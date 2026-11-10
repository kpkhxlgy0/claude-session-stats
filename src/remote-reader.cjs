'use strict';

const { createMetadataProtocol } = require('./metadata-protocol.cjs');

// 此函数被序列化到调用方页面；会话元数据、快照内容和登录态始终留在该页面内。
function createRemoteReader(win, createSnapshotProtocol, options = {}) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const protocol = createSnapshotProtocol();
    const metadata = createMetadataProtocol(createSnapshotProtocol);
    const now = options.now ?? Date.now;
    const maxFiberDepth = 512;
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const failure = reason => Object.assign(new Error(reason), { reason });
    let state = null, stopped = false;

    function identity() {
        let url;
        try { url = new URL(win.location.href); } catch { return null; }
        if (url.username || url.password || !(url.origin === 'https://claude.ai'
            || url.protocol === 'app:' && url.hostname === 'localhost' && !url.port)) return null;
        const match = /^\/(?:epitaxy|code)\/(session_[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
        if (!match) return null;
        const editors = [...win.document.querySelectorAll(
            '.ProseMirror[contenteditable], [contenteditable="true"][role="textbox"], textarea')]
            .filter(node => node.getClientRects().length
                && !node.closest('[data-pane-root][data-perf-screen="tasks"]')
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
        if (orgs.size !== 1) return null;
        const bound = { threadId: match[1], org: [...orgs][0] };
        if (options.resolveAgent) {
            let selected;
            try { selected = options.resolveAgent(); } catch { return null; }
            const agentId = protocol.normalizeAgentId(selected?.agentId);
            if (!agentId || selected?.sessionId !== bound.threadId || selected.remote !== true) return null;
            bound.agentId = agentId;
        }
        return bound;
    }
    const same = (a, b) => a && b && a.threadId === b.threadId && a.org === b.org && a.agentId === b.agentId;
    function cancel() { state?.controller?.abort(); state = null; }
    function valid(current) {
        if (stopped || current !== state) return false;
        if (!same(current.bound, identity())) { cancel(); return false; }
        return true;
    }
    function unavailable(current, reason) {
        return { threadId: current.bound.threadId, source: 'remote_control', status: 'unavailable',
            ...(current.bound.agentId ? { agentId: current.bound.agentId } : {}),
            turns: null, steps: null, totalTokens: null, inputTokens: null, outputTokens: null,
            cachedInputTokens: null, cacheHit: null, tps: null, usageComplete: false, unavailableReason: reason };
    }
    function peek(current) {
        if (!current || !valid(current) || !current.trusted) return null;
        if (current.result?.status === 'ok') {
            const age = now() - current.result.snapshotGeneratedAt;
            if (age > protocol.maxAgeMs) current.result = unavailable(current, 'snapshot-expired');
            else if (age < -protocol.futureSkewMs) current.result = unavailable(current, 'snapshot-future');
        }
        return current.result;
    }
    function accept(current, value) {
        const parsed = metadata.readSnapshot(value, { bridgeSessionId: current.bound.threadId,
            organizationId: current.bound.org, agentId: current.bound.agentId, now: now() });
        if (!parsed.ok) throw failure(`snapshot-${parsed.reason}`);
        const sample = parsed.snapshot, previous = current.accepted;
        const serialized = JSON.stringify(sample);
        if (previous) {
            if (sample.publisherId === previous.publisherId) {
                if (sample.revision < previous.revision || sample.generatedAt < previous.generatedAt
                    || sample.revision === previous.revision && serialized !== current.acceptedText)
                    throw failure('snapshot-replay');
            } else {
                if (current.retired.has(sample.publisherId) || sample.generatedAt <= previous.generatedAt
                    || current.retired.size >= 32) throw failure('snapshot-replay');
                current.retired.add(previous.publisherId);
            }
        }
        current.accepted = sample; current.acceptedText = serialized;
        if (sample.stats.status !== 'ok') throw failure('source-unavailable');
        return { ...sample.stats, threadId: current.bound.threadId, source: 'remote_control',
            ...(current.bound.agentId ? { agentId: current.bound.agentId } : {}),
            snapshotGeneratedAt: sample.generatedAt, snapshotRevision: sample.revision,
            snapshotPublisherId: sample.publisherId };
    }
    async function update(current) {
        const controller = new AbortController(); current.controller = controller;
        let timedOut = false, rejectAbort;
        const aborted = new Promise((resolve, reject) => { rejectAbort = reject; });
        const onAbort = () => rejectAbort(failure('transport'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 12000);
        const headers = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29',
            'anthropic-client-feature': 'ccr', 'x-organization-uuid': current.bound.org };
        const base = `https://claude.ai/v1/code/sessions/${current.bound.threadId}`;
        async function request() {
            if (!valid(current) || controller.signal.aborted) throw failure('transport');
            const response = await Promise.race([win.fetch(base, { method: 'GET', credentials: 'include', headers,
                signal: controller.signal, cache: 'no-store', redirect: 'error' }), aborted]);
            if (!response.ok || !valid(current) || controller.signal.aborted) throw failure('transport');
            const text = await Promise.race([response.text(), aborted]);
            if (!valid(current) || controller.signal.aborted) throw failure('transport');
            if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw failure('snapshot-invalid');
            try { return JSON.parse(text); } catch { throw failure('snapshot-invalid'); }
        }
        try {
            const detail = await request();
            if (!record(detail)) throw failure('snapshot-invalid');
            const session = detail.session ?? (record(detail.response_shape) && 'id' in detail.response_shape ? detail.response_shape : null);
            if (detail.shared || detail.is_shared || !record(session) || session.shared || session.is_shared
                || protocol.normalizeBridgeId(session.id) !== current.bound.threadId
                || !['bridge', 'ENVIRONMENT_KIND_BRIDGE'].includes(session.environment_kind)) {
                current.trusted = false; return null;
            }
            current.trusted = true;
            if ((session.connection_status ?? detail.connection_status) !== 'connected') throw failure('offline');
            if (session.client_metadata !== undefined && session.client_metadata !== null
                && !record(session.client_metadata)) throw failure('snapshot-invalid');
            return accept(current, session.client_metadata?.[metadata.key]);
        } catch (error) {
            if (!valid(current)) return null;
            return current.trusted ? unavailable(current, timedOut ? 'timeout' : error.reason ?? 'transport') : null;
        } finally {
            clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
            current.controller = null;
        }
    }
    return {
        read() {
            if (stopped) return Promise.resolve(null);
            const bound = identity();
            if (!bound) { cancel(); return Promise.resolve(null); }
            if (!same(state?.bound, bound)) {
                cancel(); state = { bound, trusted: false, controller: null, inflight: null,
                    result: null, accepted: null, acceptedText: null, retired: new Set(), nextCheck: -Infinity };
            }
            const current = state;
            if (current.inflight) return current.inflight;
            if (now() < current.nextCheck) return Promise.resolve(peek(current));
            current.inflight = update(current).then(result => {
                if (!valid(current)) return null;
                current.result = result;
                current.nextCheck = now() + (result?.status === 'ok' ? options.pollMs ?? 5000 : options.errorBackoffMs ?? 30000);
                return peek(current);
            }).finally(() => { current.inflight = null; });
            return current.inflight;
        },
        stop() { stopped = true; cancel(); },
        peek() { return peek(state); },
    };
}

function buildRemoteScripts(owner) {
    const fs = require('node:fs');
    const { createSubagentBindings } = require('./subagent-binding.cjs');
    const key = JSON.stringify(`claudepp.session-stats.${owner}`);
    const protocol = fs.readFileSync(require.resolve('./snapshot.cjs'), 'utf8');
    function scriptFor(paneKey) {
        return `(() => { const key = Symbol.for(${key});
            if (!window[key]) {
                const protocol = (() => { const module = { exports: {} }; ${protocol}\nreturn module.exports; })();
                const createMetadataProtocol = ${createMetadataProtocol.toString()};
                const makeReader = ${createRemoteReader.toString()};
                const bindings = (${createSubagentBindings.toString()})();
                const parent = makeReader(window, protocol.createSnapshotProtocol), agents = new Map();
                window[key] = { read: () => parent.read(), peek: () => parent.peek(),
                    forAgent(paneKey) {
                        const selected = bindings.readBindings(window);
                        for (const [id, reader] of agents) if (!selected.some(item => item.key === id)) {
                            reader.stop(); agents.delete(id);
                        }
                        if (!selected.some(item => item.key === paneKey && item.bound?.remote)) return null;
                        let reader = agents.get(paneKey);
                        if (!reader) {
                            if (agents.size >= 8) { const id = agents.keys().next().value;
                                agents.get(id).stop(); agents.delete(id); }
                            reader = makeReader(window, protocol.createSnapshotProtocol, {
                                resolveAgent: () => bindings.readBindings(window).find(item => item.key === paneKey)?.bound,
                            });
                            agents.set(paneKey, reader);
                        }
                        return reader;
                    },
                    stop() { parent.stop(); for (const reader of agents.values()) reader.stop(); agents.clear(); },
                };
            }
            const reader = ${paneKey === undefined ? 'window[key]' : `window[key].forAgent(${JSON.stringify(paneKey)})`};
            if (!reader) return null;
            let timer;
            return Promise.race([reader.read(), new Promise(resolve => {
                timer = setTimeout(() => resolve(reader.peek()), 750);
            })]).finally(() => clearTimeout(timer));
        })()`;
    }
    return {
        script: scriptFor(),
        agentScript(paneKey) {
            return typeof paneKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(paneKey) ? scriptFor(paneKey) : null;
        },
        cleanupScript: `(() => { const key = Symbol.for(${key}); window[key]?.stop(); delete window[key]; })()`,
    };
}

module.exports = { createRemoteReader, buildRemoteScripts };
