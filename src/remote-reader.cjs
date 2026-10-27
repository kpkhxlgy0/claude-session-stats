'use strict';

// 此函数被序列化到调用方页面；原始事件、文件内容和登录态始终留在该页面内。
function createRemoteReader(win, createSnapshotProtocol, options = {}) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const protocol = createSnapshotProtocol();
    const now = options.now ?? Date.now;
    const maxFiberDepth = 512;
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const sequence = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
        : typeof value === 'string' && /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
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
    function valid(current) {
        if (stopped || current !== state) return false;
        if (!same(current.bound, identity())) { cancel(); return false; }
        return true;
    }
    function unavailable(current, reason) {
        return { threadId: current.bound.threadId, source: 'remote_control', status: 'unavailable',
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
    function utf8Bytes(text) {
        let size = 0;
        for (const char of text) {
            const point = char.codePointAt(0);
            size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        }
        return size;
    }
    function samePath(value, expected) {
        if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return false;
        const path = value.replaceAll('\\', '/');
        if (path === expected) return true;
        if (!/^(?:[A-Za-z]:\/|\/)/.test(path) || !path.endsWith(`/${expected}`)) return false;
        return path.split('/').every((part, i) => i === 0 && part === '' || part && part !== '.' && part !== '..');
    }
    function accept(current, file, expectedPath) {
        if (!record(file) || typeof file.contents !== 'string' || file.contents.length > protocol.maxBytes
            || utf8Bytes(file.contents) > protocol.maxBytes || file.anchor !== undefined
            || file.truncated !== undefined && file.truncated !== false
            || file.encoding !== undefined && file.encoding !== 'utf-8' || !samePath(file.absPath, expectedPath))
            throw failure('snapshot-invalid');
        const parsed = protocol.parseSnapshot(file.contents, { bridgeSessionId: current.bound.threadId,
            organizationId: current.bound.org, now: now() });
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
            snapshotGeneratedAt: sample.generatedAt, snapshotRevision: sample.revision,
            snapshotPublisherId: sample.publisherId };
    }
    function readPage(value, cursor, descending = false) {
        if (!record(value) || !Array.isArray(value.data) || value.data.length > (descending ? 1 : 500))
            throw failure('snapshot-invalid');
        let latest = cursor, previous = -1;
        for (const event of value.data) {
            const seq = sequence(event?.sequence_num);
            if (!record(event) || !record(event.payload) || seq === null || seq <= previous)
                throw failure('snapshot-invalid');
            previous = seq; latest = Math.max(latest, seq);
        }
        for (const field of ['next_cursor', 'resume_cursor']) {
            if (value[field] !== undefined && value[field] !== null && value[field] !== '') {
                const parsed = sequence(value[field]);
                if (parsed === null || parsed < latest) throw failure('snapshot-invalid');
                latest = parsed;
            }
        }
        const hasNext = value.next_cursor !== undefined && value.next_cursor !== null && value.next_cursor !== '';
        if (!descending && hasNext && latest <= cursor) throw failure('snapshot-invalid');
        return { events: value.data, cursor: latest, hasNext };
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
        async function request(url, body) {
            if (!valid(current) || controller.signal.aborted) throw failure('transport');
            const response = await Promise.race([win.fetch(url, { method: body ? 'POST' : 'GET', credentials: 'include',
                headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
                signal: controller.signal, cache: 'no-store', redirect: 'error', ...(body ? { body: JSON.stringify(body) } : {}) }), aborted]);
            if (!response.ok || !valid(current) || controller.signal.aborted) throw failure('transport');
            if (body) return;
            const text = await Promise.race([response.text(), aborted]);
            if (!valid(current) || controller.signal.aborted) throw failure('transport');
            if (typeof text !== 'string' || text.length > 8 * 1024 * 1024) throw failure('snapshot-invalid');
            try { return JSON.parse(text); } catch { throw failure('snapshot-invalid'); }
        }
        async function wait() {
            await new Promise((resolve, reject) => {
                let waiting;
                const finish = () => { clearTimeout(waiting); controller.signal.removeEventListener('abort', abort); resolve(); };
                const abort = () => { clearTimeout(waiting); controller.signal.removeEventListener('abort', abort); reject(failure('transport')); };
                if (controller.signal.aborted) return abort();
                controller.signal.addEventListener('abort', abort, { once: true });
                waiting = setTimeout(finish, options.responsePollMs ?? 250);
            });
        }
        try {
            const detail = await request(base);
            const session = detail.session ?? (record(detail.response_shape) && 'id' in detail.response_shape ? detail.response_shape : null);
            if (detail.shared || detail.is_shared || !record(session) || session.shared || session.is_shared
                || protocol.normalizeBridgeId(session.id) !== current.bound.threadId
                || !['bridge', 'ENVIRONMENT_KIND_BRIDGE'].includes(session.environment_kind)) {
                current.trusted = false; return null;
            }
            current.trusted = true;
            if ((session.connection_status ?? detail.connection_status) !== 'connected') throw failure('offline');
            if (!current.result) current.result = unavailable(current, 'pending');
            const path = protocol.snapshotPath(current.bound.threadId);
            if (!path) throw failure('snapshot-invalid');
            const initial = readPage(await request(`${base}/events?${new URLSearchParams({ limit: '1', sort_order: 'desc' })}`), 0, true);
            let cursor = initial.cursor;
            const requestId = win.crypto.randomUUID();
            // workspace_root is fixed at CLI launch; EnterWorktree changes its allowed cwd.
            // Use one current-directory contract, never a fallback after a refused anchored read.
            await request(`${base}/events`, { events: [{ payload: { type: 'control_request', uuid: win.crypto.randomUUID(),
                request_id: requestId, request: { subtype: 'read_file', path, max_bytes: protocol.maxBytes,
                    encoding: 'utf-8' } } }] });
            for (let page = 0; page < (options.maxPages ?? 128); page++) {
                const params = new URLSearchParams({ limit: '500', sort_order: 'asc', cursor: String(cursor) });
                const data = readPage(await request(`${base}/events?${params}`), cursor);
                for (const event of data.events) {
                    if (sequence(event.sequence_num) <= cursor) continue;
                    const payload = event.payload;
                    if (payload.type !== 'control_response' || !record(payload.response) || payload.response.request_id !== requestId) continue;
                    const reply = payload.response;
                    if (reply.subtype === 'error') {
                        const error = typeof reply.error === 'string' ? reply.error.toLowerCase() : '';
                        throw failure(/denied|permission|eacces/.test(error) ? 'snapshot-denied'
                            : /enoent|not found|no such file/.test(error) ? 'snapshot-missing'
                                : /unsupported|unknown.*request|not implemented/.test(error) ? 'snapshot-unsupported' : 'snapshot-invalid');
                    }
                    if (reply.subtype !== 'success') throw failure('snapshot-invalid');
                    return accept(current, reply.response, path);
                }
                cursor = data.cursor;
                if (!data.hasNext) await wait();
            }
            throw failure('timeout');
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
    const key = JSON.stringify(`claudepp.session-stats.${owner}`);
    const protocol = fs.readFileSync(require.resolve('./snapshot.cjs'), 'utf8');
    return {
        script: `(() => { const key = Symbol.for(${key});
            if (!window[key]) {
                const protocol = (() => { const module = { exports: {} }; ${protocol}\nreturn module.exports; })();
                window[key] = (${createRemoteReader.toString()})(window, protocol.createSnapshotProtocol);
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
