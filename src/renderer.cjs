'use strict';

function parseSessionId(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (url.username || url.password) return null;
        if (!(url.protocol === 'app:' && url.hostname === 'localhost' && !url.port)
            && url.origin !== 'https://claude.ai')
            return null;
        const match = /^\/epitaxy\/(local_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i
            .exec(url.pathname) ?? /^\/(?:epitaxy|code)\/(session_[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
        return match ? match[1] : null;
    } catch { return null; }
}

function isVisible(element, win) {
    if (!element.isConnected || !element.getClientRects().length
        || element.closest('[hidden],[inert],[aria-hidden="true"],dialog,[role="dialog"],[role="menu"]')) return false;
    for (let node = element; node; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
}

function findComposer(win) {
    const editors = [...win.document.querySelectorAll(
        '.ProseMirror[contenteditable], [contenteditable="true"][role="textbox"], textarea')]
        .filter(node => isVisible(node, win));
    if (editors.length !== 1) return null;
    const editor = editors[0];
    // 只在当前编辑器附近寻找输入框和操作按钮的共同容器，避免把整个会话作为挂载点。
    for (let node = editor.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
        if (node === win.document.body || node === win.document.documentElement || node.tagName === 'MAIN') break;
        const rect = node.getBoundingClientRect();
        if (rect.height > Math.min(500, win.innerHeight * 0.7)) break;
        if (rect.width > 0 && rect.height > 0 && node.querySelector('button') && isVisible(node, win)) return node;
    }
    return null;
}

function compact(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value >= 1000000) return `${(value / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}K`;
    return String(Math.round(value));
}

function footerBounds(root, win) {
    const rect = root.getBoundingClientRect();
    const center = rect.left + rect.width / 2;
    const fallback = { left: rect.left + 4, top: rect.bottom + 6, width: Math.max(0, rect.width - 8) };
    const controls = new Map();
    // 输入框内的加号、麦克风不是底部操作栏；只查找输入区下方的相邻控件。
    for (let node = root.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
        if (node === win.document.body || node === win.document.documentElement || node.tagName === 'MAIN') break;
        if (node.getBoundingClientRect().height > Math.min(500, win.innerHeight * 0.7)) break;
        for (const button of node.querySelectorAll('button, [role="button"], select')) {
            if (root.contains(button) || controls.has(button) || !isVisible(button, win)) continue;
            const bounds = button.getBoundingClientRect();
            if (bounds.width > 0 && bounds.width < rect.width * 0.6 && bounds.height > 0
                && bounds.top >= rect.bottom - 2 && bounds.bottom <= rect.bottom + 64
                && bounds.left >= rect.left - 4 && bounds.right <= rect.right + 4) controls.set(button, bounds);
        }
    }
    if (!controls.size) return fallback;
    const firstTop = Math.min(...[...controls.values()].map(bounds => bounds.top));
    const row = [...controls.values()].filter(bounds => bounds.top < firstTop + 12);
    const top = Math.min(...row.map(bounds => bounds.top));
    const bottom = Math.max(...row.map(bounds => bounds.bottom));
    let left = rect.left + 4;
    let right = rect.right - 4;
    for (const bounds of row) {
        if ((bounds.left + bounds.right) / 2 < center) left = Math.max(left, bounds.right + 8);
        else right = Math.min(right, bounds.left - 8);
    }
    const halfWidth = Math.min(center - left, right - center);
    if (halfWidth < 64) return { ...fallback, top: bottom + 4 };
    return { left: center - halfWidth, top: (top + bottom - 14) / 2, width: halfWidth * 2 };
}

function makeBar(doc, remote) {
    const bar = doc.createElement('div');
    bar.dataset.sessionStats = '';
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', '会话统计');
    const fields = {};
    for (const names of [['turns', 'steps', 'tps'], ['tokens', 'cache']]) {
        const group = doc.createElement('span');
        group.className = 'session-stats-group';
        for (const name of names) {
            if (group.childNodes.length) group.append(doc.createTextNode(' · '));
            const field = doc.createElement('span');
            field.dataset.stat = name; fields[name] = field; group.append(field);
        }
        bar.append(group);
    }
    const scope = remote ? '当前 Remote Control 会话' : '当前主会话';
    fields.turns.title = `${scope}的用户轮次，按 promptId/uuid 去重，排除工具返回和系统注入消息`;
    fields.steps.title = `${scope}的模型响应次数，按消息 ID 去重；不等于工具调用次数`;
    fields.tps.title = '整个会话平均 TPS（估算）：有效响应样本的输出 tokens 总和 ÷ 对应耗时总和；'
        + `以${remote ? '已同步历史' : '已确认日志'}为范围，耗时从用户输入或工具返回计至响应记录，包含首 Token 等待和网络耗时。`
        + '新输入、工具执行和后续生成期间保留已有平均值；缺少有效样本时显示 —。';
    return { bar, fields };
}

function render(entry, stats) {
    const s = stats?.status === 'ok' ? stats : {};
    const text = {
        turns: `${s.turns ?? '—'} turns`, steps: `${s.steps ?? '—'} steps`,
        tps: `${Number.isFinite(s.tps) && s.tps > 0 ? `≈ ${Math.round(s.tps)}` : '—'} tok/s`,
        tokens: `${compact(s.totalTokens)} tok`,
        cache: `Cache hit ${Number.isFinite(s.cacheHit) ? `${Math.round(s.cacheHit * 100)}%` : '—'}`,
    };
    for (const [name, value] of Object.entries(text))
        if (entry.fields[name].textContent !== value) entry.fields[name].textContent = value;
    const pending = stats?.status === 'incomplete' ? '日志包含不完整记录，等待可验证的用量数据'
        : '等待当前会话的本地统计数据';
    entry.bar.title = stats?.status === 'ok' ? '' : pending;
    entry.fields.tokens.title = stats?.status === 'ok'
        ? `累计输入 ${compact(s.inputTokens)}，输出 ${compact(s.outputTokens)}；输入包含缓存读取和写入`
            + (entry.remote ? '；累计仅包含 Remote Control 同步历史' : '') : pending;
    entry.fields.cache.title = stats?.status === 'ok'
        ? `缓存读取 ${compact(s.cachedInputTokens)} ÷ 总输入 ${compact(s.inputTokens)}` : pending;
}

function startRenderer(api, options = {}) {
    const win = options.window ?? window;
    const doc = win.document;
    let entry = null;
    const remoteRequests = new WeakMap();
    let stopped = false;
    let scheduled = null;
    const style = doc.createElement('style');
    style.dataset.sessionStatsStyle = '';
    style.textContent = `
        [data-session-stats] { position: fixed; display: flex; gap: 20px; padding: 0; margin: 0;
            height: 14px; line-height: 14px; font-size: 11px; font-family: inherit; z-index: 10;
            font-variant-numeric: tabular-nums; opacity: .7;
            overflow-x: auto; scrollbar-width: none; pointer-events: none; white-space: nowrap; }
        [data-session-stats] .session-stats-group { flex-shrink: 0; pointer-events: auto; }
        [data-session-stats] .session-stats-group:first-child { margin-left: auto; }
        [data-session-stats] .session-stats-group:last-child { margin-right: auto; }
    `;
    doc.head.append(style);

    function remove() { entry?.bar.remove(); entry = null; }
    function position(current) {
        const bounds = footerBounds(current.root, win);
        current.bar.style.color = win.getComputedStyle(current.root).color;
        current.bar.style.left = `${Math.round(bounds.left)}px`;
        current.bar.style.top = `${Math.round(bounds.top)}px`;
        current.bar.style.width = `${Math.round(bounds.width)}px`;
    }
    function isCurrent(current) {
        return !stopped && entry === current && doc.visibilityState !== 'hidden'
            && parseSessionId(win.location.href) === current.sessionId && findComposer(win) === current.root;
    }
    async function refresh(current) {
        if (current.inflight) return;
        let pending;
        if (current.remote) {
            pending = remoteRequests.get(current.root);
            if (pending?.has(current.sessionId)) return;
            if (!pending) remoteRequests.set(current.root, pending = new Set());
            pending.add(current.sessionId);
        }
        current.inflight = true;
        try {
            const stats = await (current.remote ? api.ipc.invoke('remote-stats')
                : api.ipc.invoke('stats', current.sessionId));
            if (!isCurrent(current)) return;
            if (current.remote) {
                if (stats?.threadId !== current.sessionId || stats.source !== 'remote_control' || stats.status !== 'ok') {
                    current.bar.remove(); return;
                }
                render(current, stats); position(current);
                if (!current.bar.isConnected) doc.body.append(current.bar);
            } else render(current, stats?.threadId === current.sessionId ? stats : null);
        } catch {
            if (isCurrent(current)) {
                if (current.remote) current.bar.remove();
                else render(current, null);
            }
        } finally {
            current.inflight = false;
            if (pending) {
                pending.delete(current.sessionId);
                if (!pending.size) remoteRequests.delete(current.root);
            }
        }
    }
    function reconcile() {
        scheduled = null;
        if (stopped) return;
        const sessionId = parseSessionId(win.location.href);
        const root = sessionId && doc.visibilityState !== 'hidden' ? findComposer(win) : null;
        if (!sessionId || !root) { remove(); return; }
        if (!entry || entry.sessionId !== sessionId || entry.root !== root) {
            const remote = sessionId.startsWith('session_');
            remove(); entry = { ...makeBar(doc, remote), root, sessionId, remote, inflight: false };
            if (!remote) { render(entry, null); doc.body.append(entry.bar); }
        }
        position(entry); void refresh(entry);
    }
    function schedule() {
        if (!stopped && scheduled === null) scheduled = win.setTimeout(reconcile, options.debounceMs ?? 100);
    }
    const observer = new win.MutationObserver(mutations => {
        if (mutations.some(m => !m.target.closest?.('[data-session-stats]')
            && !m.target.parentElement?.closest('[data-session-stats]'))) schedule();
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true,
        attributeFilter: ['hidden', 'inert', 'aria-hidden', 'contenteditable', 'class'] });
    for (const event of ['popstate', 'hashchange', 'resize', 'scroll']) win.addEventListener(event, schedule, true);
    doc.addEventListener('visibilitychange', schedule);
    const timer = win.setInterval(reconcile, options.pollMs ?? 1000);
    reconcile();
    return { stop() {
        if (stopped) return;
        stopped = true; observer.disconnect(); win.clearInterval(timer);
        if (scheduled !== null) win.clearTimeout(scheduled);
        for (const event of ['popstate', 'hashchange', 'resize', 'scroll']) win.removeEventListener(event, schedule, true);
        doc.removeEventListener('visibilitychange', schedule);
        remove(); style.remove();
    } };
}

module.exports = { parseSessionId, findComposer, startRenderer };
