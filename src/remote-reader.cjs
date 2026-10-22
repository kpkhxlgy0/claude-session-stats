'use strict';

// 此函数被序列化到调用方页面；原始事件和登录态始终留在该页面内。
function createRemoteReader(win, createMetrics, options = {}) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
    const maxFiberDepth = 512;
    let state = null;
    let stopped = false;
    let retry = null;
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const sequence = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
        : typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

    function identity() {
        const url = new URL(win.location.href);
        if (url.username || url.password || !(url.origin === 'https://claude.ai'
            || url.protocol === 'app:' && url.hostname === 'localhost' && !url.port)) return null;
        const match = /^\/(?:epitaxy|code)\/(session_[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
        if (!match) return null;
        const editors = [...win.document.querySelectorAll(
            '.ProseMirror[contenteditable], [contenteditable="true"][role="textbox"], textarea')]
            .filter(node => node.getClientRects().length
                && !node.closest('[hidden],[inert],[aria-hidden="true"],dialog,[role="dialog"],[role="menu"]'));
        if (editors.length !== 1) return null;
        const orgs = new Set();
        // activeOrganization 是现有账户 Context 的字段；不读取 Cookie、认证令牌或聊天正文。
        for (let dom = editors[0], level = 0; dom && level < 12; dom = dom.parentElement, level++) {
            const key = Object.keys(dom).find(name => name.startsWith('__reactFiber$'));
            if (!key) continue;
            let fiber = dom[key], top = fiber;
            const roots = new Set();
            for (let depth = 0; top?.return && depth < maxFiberDepth && !roots.has(top); depth++) {
                roots.add(top); top = top.return;
            }
            if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
            const visited = new Set();
            for (let node = fiber, depth = 0; node && depth < maxFiberDepth && !visited.has(node); node = node.return, depth++) {
                visited.add(node);
                for (const value of [node.memoizedProps, node.memoizedProps?.value]) {
                    const org = value?.activeOrganization?.uuid;
                    if (typeof org === 'string' && UUID.test(org)) orgs.add(org);
                }
            }
            break;
        }
        return orgs.size === 1 ? { threadId: match[1], org: [...orgs][0] } : null;
    }
    const same = (a, b) => a && b && a.threadId === b.threadId && a.org === b.org;
    function cancel() { state?.controller?.abort(); state = null; }
    function valid(current) { return !stopped && current === state && same(current.bound, identity()); }
    function snapshot(current) {
        const stats = current.complete ? current.metrics.snapshot() : {
            turns: null, steps: null, totalTokens: null, inputTokens: null, outputTokens: null,
            cachedInputTokens: null, cacheHit: null, tps: null, usageComplete: false,
        };
        if (current.stream) stats.tps = null;
        return { ...stats, threadId: current.bound.threadId, source: 'remote_control', status: 'ok' };
    }
    function ingest(current, row) {
        if (row.parent_tool_use_id || row.isSidechain || row.isMeta || row.isSynthetic
            || row.isSyntheticReply || row.isOptimisticEcho || row.isCompactSummary || row.isApiErrorMessage) return;
        if (row.type === 'stream_event') {
            const event = row.event;
            if (!record(event)) throw new Error('Invalid stream event');
            if (event.type === 'message_start') {
                if (typeof event.message?.id !== 'string') throw new Error('Missing response identity');
                current.stream = { id: event.message.id, usage: {}, model: event.message.model };
            }
            if (current.stream) {
                const usage = event.type === 'message_start' ? event.message?.usage : event.usage;
                for (const field of fields) {
                    const count = usage?.[field];
                    if (Number.isSafeInteger(count) && count >= 0)
                        current.stream.usage[field] = Math.max(current.stream.usage[field] ?? 0, count);
                }
                if (event.type === 'message_stop') {
                    current.metrics.ingest({ type: 'assistant', timestamp: row.timestamp,
                        message: { role: 'assistant', ...current.stream } });
                    current.stream = null;
                }
            }
            return;
        }
        if (row.type !== 'user' && row.type !== 'assistant') return;
        if (!record(row.message) || row.message.role !== row.type) throw new Error('Invalid message');
        if (row.type === 'user' && !row.uuid && !row.promptId
            || row.type === 'assistant' && !row.message.id && !row.requestId) throw new Error('Missing message identity');
        // session_id/JSONL sessionId 是远端 CLI ID，统计边界使用已确认的 bridge ID。
        current.metrics.ingest({ ...row, sessionId: undefined });
        if (row.type === 'user') current.stream = null;
        else if (current.stream && row.message.id === current.stream.id) {
            // 内容块的 assistant 快照可能先于最终 message_delta，必须继续合并后续用量。
            for (const field of fields) {
                const count = row.message.usage?.[field];
                if (Number.isSafeInteger(count) && count >= 0)
                    current.stream.usage[field] = Math.max(current.stream.usage[field] ?? 0, count);
            }
        }
    }
    async function update(current) {
        const controller = new AbortController(); current.controller = controller;
        const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
        const headers = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29',
            'anthropic-client-feature': 'ccr', 'x-organization-uuid': current.bound.org };
        const base = `https://claude.ai/v1/code/sessions/${current.bound.threadId}`;
        let transportFailure = false;
        async function get(url) {
            let response, text;
            try {
                response = await win.fetch(url, { method: 'GET', credentials: 'include', headers,
                    signal: controller.signal, cache: 'no-store', redirect: 'error' });
                if (!response.ok || !valid(current) || controller.signal.aborted) throw new Error('Unavailable');
                text = await response.text();
            } catch (error) { transportFailure = true; throw error; }
            if (!valid(current) || controller.signal.aborted) {
                transportFailure = true; throw new Error('Unavailable');
            }
            if (text.length > 8 * 1024 * 1024) throw new Error('Response too large');
            return JSON.parse(text);
        }
        try {
            const detail = await get(base);
            const session = detail.session ?? (record(detail.response_shape) && 'id' in detail.response_shape
                ? detail.response_shape : null);
            if (detail.shared || !record(session) || session.id?.replace(/^cse_/, 'session_') !== current.bound.threadId
                || !['bridge', 'ENVIRONMENT_KIND_BRIDGE'].includes(session.environment_kind)) {
                retry = { bound: current.bound, after: Date.now() + (options.pollMs ?? 5000) };
                if (current === state) cancel();
                return null;
            }
            current.result = snapshot(current);
            for (let page = 0; page < (options.maxPages ?? 8); page++) {
                const params = new URLSearchParams({ limit: '500', sort_order: 'asc' });
                if (current.cursor !== null) params.set('cursor', current.cursor);
                const data = await get(`${base}/events?${params}`);
                if (!Array.isArray(data.data) || data.data.length > 500) throw new Error('Invalid history');
                const next = data.next_cursor;
                if (next !== undefined && next !== null && next !== ''
                    && (sequence(next) === null || current.cursor !== null && sequence(next) < Number(current.cursor)))
                    throw new Error('Invalid cursor');
                let previous = -1;
                for (const event of data.data) {
                    if (!record(event) || !record(event.payload) || sequence(event.sequence_num) === null)
                        throw new Error('Invalid envelope');
                    const seq = sequence(event.sequence_num);
                    if (seq <= previous) throw new Error('Unordered history');
                    previous = seq;
                    if (seq <= current.sequence) continue;
                    if (++current.rows > (options.maxRows ?? 200000)) throw new Error('History too large');
                    ingest(current, event.payload); current.sequence = seq;
                }
                if (next !== undefined && next !== null && next !== '' && String(next) !== current.cursor) {
                    current.cursor = String(next); current.complete = false;
                } else {
                    const resume = sequence(data.resume_cursor);
                    current.cursor = String(Math.max(resume ?? 0, current.sequence));
                    current.complete = true;
                    break;
                }
            }
            return valid(current) ? snapshot(current) : null;
        } catch {
            // 网络中断保留已完成的分页；结构异常则丢弃半页统计并从头恢复。
            if (!transportFailure && current === state) cancel();
            retry = { bound: current.bound, after: Date.now() + (options.pollMs ?? 5000) };
            return null;
        } finally { clearTimeout(timer); current.controller = null; }
    }
    return {
        read() {
            if (stopped) return Promise.resolve(null);
            const bound = identity();
            if (!bound) { cancel(); return Promise.resolve(null); }
            if (same(retry?.bound, bound) && Date.now() < retry.after) return Promise.resolve(null);
            if (!same(state?.bound, bound)) {
                cancel(); state = { bound, metrics: createMetrics(), cursor: null, sequence: -1, rows: 0,
                    complete: false, stream: null, inflight: null, result: null, checkedAt: -Infinity };
            }
            const current = state;
            if (current.inflight) return current.inflight;
            if (Date.now() - current.checkedAt < (options.pollMs ?? 5000)) return Promise.resolve(current.result);
            current.inflight = update(current).then(result => {
                current.result = result; current.checkedAt = Date.now(); return result;
            }).finally(() => { current.inflight = null; });
            return current.inflight;
        },
        stop() { stopped = true; cancel(); },
        peek() { return state && valid(state) ? state.result : null; },
    };
}

function buildRemoteScripts(owner) {
    const fs = require('node:fs');
    const key = JSON.stringify(`claudepp.session-stats.${owner}`);
    const metrics = fs.readFileSync(require.resolve('./metrics.cjs'), 'utf8');
    return {
        script: `(() => { const key = Symbol.for(${key});
            if (!window[key]) {
                const metrics = (() => { const module = { exports: {} }; ${metrics}\nreturn module.exports; })();
                window[key] = (${createRemoteReader.toString()})(window, metrics.createMetrics);
            }
            const reader = window[key];
            let timer;
            return Promise.race([reader.read(), new Promise(resolve => {
                timer = setTimeout(() => resolve(reader.peek()), 750);
            })]).finally(() => clearTimeout(timer));
        })()`,
        cleanupScript: `(() => { const key = Symbol.for(${key}); window[key]?.stop(); delete window[key]; })()`,
    };
}

module.exports = { createRemoteReader, buildRemoteScripts };
