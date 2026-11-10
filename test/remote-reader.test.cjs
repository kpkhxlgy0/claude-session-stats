'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createMetadataProtocol } = require('../src/metadata-protocol.cjs');
const { createRemoteReader, buildRemoteScripts } = require('../src/remote-reader.cjs');
const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';
const KEY = 'claudepp_session_stats';
const DIRECTORY = '/home/runner/.claude/.session-stats';
const PATH = `${DIRECTORY}/${ID}.json`;
const ABS_PATH = PATH;
const absolutePath = agentId => agentId === undefined ? PATH : `${DIRECTORY}/${ID}.agent-${agentId}.json`;
const STATS = { turns: 7, steps: 13, totalTokens: 1400, inputTokens: 1000, outputTokens: 400,
    cachedInputTokens: 700, cacheHit: .7, tps: 20, usageComplete: true, status: 'ok' };
const NOW = Date.parse('2026-10-24T00:00:00Z');
const event = (payload, sequence_num) => ({ event_id: `event-${sequence_num}`, sequence_num: String(sequence_num), payload });
const response = (value, ok = true) => ({ ok, text: async () => JSON.stringify(value) });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await flush(); }
    assert.fail('reader did not reach the expected transport boundary');
}

function fixture(t, options = {}) {
    const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: `https://claude.ai/epitaxy/${ID}` });
    t.after(() => dom.window.close());
    const win = dom.window, editor = win.document.querySelector('.ProseMirror');
    editor.getClientRects = () => [{ width: 100 }];
    editor.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
    let clock = NOW, revision = 1, generatedAt = NOW, publisherId = PUBLISHER, directory = DIRECTORY, requestId, requestedPath;
    let detail = { session: { id: 'cse_Test123', environment_kind: 'ENVIRONMENT_KIND_BRIDGE', connection_status: 'connected' } };
    let onFetch = null, onReply = value => value, onSnapshot = value => value, onLocation = value => value;
    const requests = [];
    function snapshot(agentId = options.sampleAgentId) {
        return onSnapshot(createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG,
            ...(agentId ? { agentId } : {}) }, STATS, { publisherId, revision, now: generatedAt }));
    }
    function location() {
        return onLocation(createMetadataProtocol(createSnapshotProtocol).makeLocation({
            bridgeSessionId: ID, organizationId: ORG, publisherId, generatedAt: clock, directory }));
    }
    function sessionDetail() {
        const value = structuredClone(detail);
        if (value.session && !Object.hasOwn(value.session, 'client_metadata'))
            value.session.client_metadata = { sibling: { outputTokens: 99999 }, [KEY]: location() };
        return value;
    }
    function reply() {
        return onReply({ type: 'control_response', response: { request_id: requestId, subtype: 'success',
            response: { contents: JSON.stringify(snapshot()), absPath: requestedPath } } });
    }
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        const request = { url: new URL(url), init, requestId, requestedPath, snapshot, location, detail: sessionDetail, reply };
        if (onFetch) {
            const result = await onFetch(request);
            if (result !== undefined) return result;
        }
        if (init.method === 'POST') {
            const payload = JSON.parse(init.body).events[0].payload;
            requestId = payload.request_id; requestedPath = payload.request.path;
            return response({});
        }
        if (!request.url.pathname.endsWith('/events')) return response(sessionDetail());
        if (request.url.searchParams.get('sort_order') === 'desc') return response({ data: [], resume_cursor: '10' });
        return response({ data: [event(reply(), 12)], resume_cursor: '12' });
    };
    const reader = createRemoteReader(win, createSnapshotProtocol, { pollMs: 0, errorBackoffMs: 0,
        responsePollMs: 1, timeoutMs: 100, now: () => clock, ...options });
    t.after(() => reader.stop());
    return { win, reader, editor, requests, snapshot, location, detail: sessionDetail,
        setDetail(value) { detail = value; }, setFetch(value) { onFetch = value; }, setReply(value) { onReply = value; },
        setSnapshot(value) { onSnapshot = value; }, setLocation(value) { onLocation = value; },
        setDirectory(value) { directory = value; }, setPublisher(value) { publisherId = value; },
        advance(ms) { clock += ms; }, setSample(value, at = clock) { revision = value; generatedAt = at; } };
}

test('discovers the directory and reads only the selected snapshot through a correlated native request', async t => {
    const f = fixture(t); const result = await f.reader.read();
    assert.deepEqual(result, { ...STATS, threadId: ID, source: 'remote_control',
        snapshotGeneratedAt: NOW, snapshotRevision: 1, snapshotPublisherId: PUBLISHER });
    const post = f.requests.find(request => request.init.method === 'POST');
    assert.ok(post, 'a read_file control request must be sent');
    assert.equal(post.url, `https://claude.ai/v1/code/sessions/${ID}/events`);
    const payload = JSON.parse(post.init.body).events[0].payload;
    assert.equal(payload.type, 'control_request');
    assert.match(payload.uuid, /^[0-9a-f-]{36}$/i); assert.match(payload.request_id, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(payload.request, { subtype: 'read_file', path: PATH, max_bytes: 16384,
        encoding: 'utf-8' });
    assert.equal(JSON.parse(post.init.body).events.length, 1);
    const postIndex = f.requests.indexOf(post);
    assert.equal(new URL(f.requests[postIndex - 1].url).searchParams.get('sort_order'), 'desc');
    assert.equal(new URL(f.requests[postIndex + 1].url).searchParams.get('cursor'), '10');
    for (const { init } of f.requests) {
        assert.equal(init.credentials, 'include'); assert.equal(init.headers['x-organization-uuid'], ORG);
        assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    }
    assert.doesNotMatch(JSON.stringify(result), /contents|absPath|organizationId|producer|read_file|request_id/);
});

test('selected child reads only its own bounded snapshot and returns agent identity', async t => {
    const agentId = 'aa6fe20fa9956750a';
    const f = fixture(t, { sampleAgentId: agentId,
        resolveAgent: () => ({ sessionId: ID, agentId, remote: true }) });
    const result = await f.reader.read();
    assert.equal(result?.agentId, agentId);
    assert.equal(result?.tps, 20);
    const post = f.requests.find(request => request.init.method === 'POST');
    assert.equal(JSON.parse(post.init.body).events[0].payload.request.path,
        `${DIRECTORY}/${ID}.agent-${agentId}.json`);
});

test('a visible task-pane editor cannot suppress either parent or child snapshot reads', async t => {
    for (const agentId of [undefined, 'a123abc']) {
        const f = fixture(t, { sampleAgentId: agentId, ...(agentId ? {
            resolveAgent: () => ({ sessionId: ID, agentId, remote: true }),
        } : {}) });
        const pane = f.win.document.createElement('div');
        pane.dataset.paneRoot = ''; pane.dataset.perfScreen = 'tasks';
        const editor = f.win.document.createElement('textarea');
        editor.getClientRects = () => [{width:100,height:20}];
        pane.append(editor); f.win.document.body.append(pane);
        const result = await f.reader.read();
        assert.equal(result?.tps, 20);
        assert.equal(result?.agentId, agentId);
        assert.ok(f.requests.some(request => request.init.method === 'POST'));
    }
});

test('missing, local, unsafe and foreign-parent child selections never request snapshots', async t => {
    let selected = null;
    const f = fixture(t, { resolveAgent: () => selected });
    for (selected of [null, { sessionId: ID, agentId: '../bad', remote: true },
        { sessionId: ID, agentId: 'a123abc', remote: false },
        { sessionId: 'session_other', agentId: 'a123abc', remote: true }]) {
        assert.equal(await f.reader.read(), null);
    }
    assert.equal(f.requests.length, 0);
});

test('child selection change invalidates a pending read and cannot display another child snapshot', async t => {
    const agentId = 'a123abc';
    let selected = { sessionId: ID, agentId, remote: true }, release;
    const f = fixture(t, { sampleAgentId: agentId, resolveAgent: () => selected });
    f.setFetch(({url,requestId,snapshot}) => url.searchParams.get('sort_order') === 'asc'
        ? new Promise(resolve => { release = () => resolve(response({ data: [event({ type: 'control_response',
            response: { request_id: requestId, subtype: 'success', response: {
                contents: JSON.stringify(snapshot()), absPath: absolutePath(agentId),
            } } }, 12)], resume_cursor: '12' })); }) : undefined);
    const pending = f.reader.read();
    await waitFor(() => release);
    selected = { ...selected, agentId: 'a456def' };
    release();
    assert.equal(await pending, null);
    assert.equal(f.reader.peek(), null);
});

test('cloud, shared, mismatched, unconnected and ambiguous identities cannot read the snapshot', async t => {
    const f = fixture(t);
    for (const detail of [
        { session: { id: ID, environment_kind: 'anthropic_cloud', connection_status: 'connected' } },
        { shared: true, session: { id: ID, environment_kind: 'bridge', connection_status: 'connected' } },
        { session: { id: 'session_Other', environment_kind: 'bridge', connection_status: 'connected' } },
    ]) {
        f.setDetail(detail); assert.equal(await f.reader.read(), null);
    }
    f.setDetail({ session: { id: ID, environment_kind: 'bridge', connection_status: 'disconnected' } });
    assert.equal((await f.reader.read()).unavailableReason, 'offline');
    assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 0);
    f.editor.__reactFiber$test.memoizedProps.activeOrganization = { uuid: '33333333-3333-4333-8333-333333333333' };
    assert.equal(await f.reader.read(), null); assert.equal(f.reader.peek(), null);
});

test('synchronized messages and unrelated or pre-cursor responses never supply usage or finish the read', async t => {
    const f = fixture(t); let polls = 0;
    f.setFetch(({ url, init, requestId, snapshot }) => {
        if (init.method !== 'GET' || url.searchParams.get('sort_order') !== 'asc') return;
        polls++;
        const payload = { type: 'control_response', response: { request_id: requestId,
            subtype: 'success', response: { contents: JSON.stringify(snapshot()), absPath: ABS_PATH } } };
        if (polls === 1) return response({ data: [
            event(payload, 10), event({ ...payload, response: { ...payload.response, request_id: 'old-request' } }, 11),
            event({ type: 'user', uuid: 'prompt', message: { role: 'user', content: 'private prompt' } }, 12),
            event({ type: 'assistant', message: { role: 'assistant', id: 'm1', usage: { output_tokens: 99999 } } }, 13),
        ], next_cursor: '13' });
        assert.equal(url.searchParams.get('cursor'), '13');
        return response({ data: [event(payload, 14)], resume_cursor: '14' });
    });
    assert.equal((await f.reader.read()).outputTokens, 400); assert.equal(polls, 2);
});

test('matching denied, missing and unsupported replies return unavailable without estimated numbers', async t => {
    for (const [error, reason] of [['read denied: file', 'snapshot-denied'],
        ['EACCES: no such file or directory', 'snapshot-denied'], ['ENOENT', 'snapshot-missing'],
        ['Unsupported control request: read_file', 'snapshot-unsupported']]) {
        const f = fixture(t);
        f.setReply(value => ({ ...value, response: { request_id: value.response.request_id, subtype: 'error', error } }));
        const result = await f.reader.read();
        assert.equal(result.status, 'unavailable'); assert.equal(result.unavailableReason, reason);
        assert.equal(result.threadId, ID); assert.equal(result.tps, null); assert.equal(result.totalTokens, null);
    }
});

test('invalid file envelopes and malformed snapshots fail closed', async t => {
    const invalid = [
        value => ({ ...value, truncated: true }), value => ({ ...value, encoding: 'base64' }),
        value => ({ ...value, anchor: 'workspace_root' }), value => ({ ...value, anchor: 'cwd' }),
        value => ({ ...value, absPath: '.claude/session-stats/session_Other.json' }),
        value => ({ ...value, absPath: '/home/runner/../.claude-plusplus/session-stats/session_Test123.json' }),
        value => ({ ...value, contents: 'x'.repeat(16385) }), value => ({ ...value, contents: '😀'.repeat(5000) }),
        value => ({ ...value, contents: '{' }),
        value => ({ ...value, contents: JSON.stringify({ ...JSON.parse(value.contents), privatePrompt: 'must reject' }) }),
    ];
    for (const mutate of invalid) {
        const f = fixture(t);
        f.setReply(value => ({ ...value, response: { ...value.response, response: mutate(value.response.response) } }));
        const result = await f.reader.read();
        assert.equal(result.status, 'unavailable'); assert.equal(result.unavailableReason, 'snapshot-invalid');
        assert.equal(result.tps, null);
    }
});

test('custom Windows and POSIX locations produce one exact absolute request without anchors', async t => {
    for (const [directory, path] of [
        ['/srv/claude config/.session-stats', '/srv/claude config/.session-stats/session_Test123.json'],
        ['D:/Custom Home/.session-stats', 'D:/Custom Home/.session-stats/session_Test123.json'],
    ]) {
        const f = fixture(t); f.setDirectory(directory);
        assert.equal((await f.reader.read()).totalTokens, 1400);
        const posts = f.requests.filter(value => value.init.method === 'POST');
        assert.equal(posts.length, 1);
        assert.deepEqual(JSON.parse(posts[0].init.body).events[0].payload.request,
            { subtype: 'read_file', path, max_bytes: 16384, encoding: 'utf-8' });
    }
});

test('file responses must match the exact advertised path instead of only its suffix', async t => {
    for (const absPath of [
        `/other/home/.claude/.session-stats/${ID}.json`, `/home/runner/other/.session-stats/${ID}.json`,
        `~/.claude/.session-stats/${ID}.json`, `/home/runner/../runner/.claude/.session-stats/${ID}.json`,
        `/home/runner/.claude/.session-stats/${ID}.agent-other.json`, `${PATH}/extra`,
        `//server/share/.session-stats/${ID}.json`, `C:/Users/runner/.session-stats/${ID}.json`,
    ]) {
        const f = fixture(t);
        f.setReply(value => ({ ...value, response: { ...value.response,
            response: { ...value.response.response, absPath } } }));
        const result = await f.reader.read();
        assert.equal(result.unavailableReason, 'snapshot-invalid', absPath); assert.equal(result.tps, null, absPath);
        assert.equal(f.requests.filter(value => value.init.method === 'POST').length, 1, absPath);
    }
});

test('wrong snapshot identity, stale and future samples remain unavailable', async t => {
    for (const [mutate, reason] of [
        [sample => ({ ...sample, bridgeSessionId: 'session_Other' }), 'snapshot-identity'],
        [sample => ({ ...sample, organizationId: '33333333-3333-4333-8333-333333333333' }), 'snapshot-identity'],
        [sample => ({ ...sample, generatedAt: NOW - 30001 }), 'snapshot-expired'],
        [sample => ({ ...sample, generatedAt: NOW + 5001 }), 'snapshot-future'],
    ]) {
        const f = fixture(t);
        f.setReply(value => ({ ...value, response: { ...value.response,
            response: { ...value.response.response, contents: JSON.stringify(mutate(JSON.parse(value.response.response.contents))) } } }));
        assert.equal((await f.reader.read()).unavailableReason, reason);
    }
});

test('valid snapshots with unavailable source data do not claim a usable shared revision', async t => {
    const f = fixture(t);
    f.setReply(value => ({ ...value, response: { ...value.response, response: { ...value.response.response,
        contents: JSON.stringify(createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG },
            { ...STATS, status: 'incomplete' }, { publisherId: PUBLISHER, revision: 1, now: NOW })) } } }));
    assert.equal((await f.reader.read()).unavailableReason, 'source-unavailable'); assert.equal(f.reader.peek().tps, null);
});

test('cache expires while an RPC is pending and concurrent reads share its one request', async t => {
    const f = fixture(t); assert.equal((await f.reader.read()).tps, 20);
    f.advance(29000); let release;
    f.setFetch(({ url, requestId, snapshot }) => url.searchParams.get('sort_order') === 'asc'
        ? new Promise(resolve => { release = () => resolve(response({ data: [event({ type: 'control_response',
            response: { request_id: requestId, subtype: 'success', response: { contents: JSON.stringify(snapshot()),
                absPath: ABS_PATH } } }, 12)], resume_cursor: '12' })); }) : undefined);
    const first = f.reader.read(), second = f.reader.read(); assert.equal(first, second);
    await waitFor(() => release);
    assert.equal(f.reader.peek().tps, 20); f.advance(1001);
    assert.equal(f.reader.peek().tps, null); assert.equal(f.reader.peek().unavailableReason, 'snapshot-expired');
    release(); assert.equal((await first).unavailableReason, 'snapshot-expired');
});

test('snapshot revision rollback, changed same revision and old publisher replays are rejected', async t => {
    const f = fixture(t); f.setSample(3); assert.equal((await f.reader.read()).snapshotRevision, 3);
    f.setSample(2); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
    f.setSample(3); f.setReply(value => ({ ...value, response: { ...value.response,
        response: { ...value.response.response, contents: value.response.response.contents.replace('"tps":20', '"tps":21') } } }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
    f.setReply(value => ({ ...value, response: { ...value.response, response: { ...value.response.response,
        contents: JSON.stringify({ ...JSON.parse(value.response.response.contents), publisherId: '44444444-4444-4444-8444-444444444444' }) } } }));
    f.setPublisher('44444444-4444-4444-8444-444444444444');
    f.advance(1); f.setSample(1); assert.equal((await f.reader.read()).snapshotRevision, 1);
    f.setPublisher(PUBLISHER); f.setReply(value => value); f.setSample(4); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
});

test('normal polling and unavailable backoff suppress extra network calls', async t => {
    const f = fixture(t, { pollMs: 5000, errorBackoffMs: 30000 });
    await f.reader.read(); const calls = f.requests.length;
    f.advance(4999); assert.equal((await f.reader.read()).tps, 20); assert.equal(f.requests.length, calls);
    f.advance(1); f.setReply(value => ({ ...value, response: { request_id: value.response.request_id, subtype: 'error', error: 'ENOENT' } }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-missing'); const unavailableCalls = f.requests.length;
    f.advance(29999); assert.equal((await f.reader.read()).tps, null); assert.equal(f.requests.length, unavailableCalls);
    f.advance(1); await f.reader.read(); assert.ok(f.requests.length > unavailableCalls);
});

test('navigation and stop abort pending fetch and discard its result', async t => {
    const f = fixture(t); let signal;
    f.setFetch(({ url, init }) => {
        if (url.searchParams.get('sort_order') !== 'asc') return;
        signal = init.signal;
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    });
    const pending = f.reader.read(); await waitFor(() => signal);
    f.win.history.pushState({}, '', '/epitaxy/session_Other');
    assert.equal(f.reader.peek(), null); assert.equal(signal.aborted, true); assert.equal(await pending, null);
    const next = f.reader.read(); f.reader.stop(); assert.equal(await next, null); assert.equal(f.reader.peek(), null);
});

test('stop cancels a response-poll wait without sending another request', async t => {
    const f = fixture(t, { responsePollMs: 10000, timeoutMs: 20000 }); let polled = false, signal;
    f.setFetch(({ url, init }) => {
        if (url.searchParams.get('sort_order') !== 'asc') return;
        polled = true; signal = init.signal; return response({ data: [], resume_cursor: '10' });
    });
    const pending = f.reader.read(); await waitFor(() => polled); await flush();
    const calls = f.requests.length; f.reader.stop();
    assert.equal(await pending, null); assert.equal(signal.aborted, true); assert.equal(f.requests.length, calls);
});

test('a missing response times out with bound unavailable statistics', async t => {
    const f = fixture(t, { timeoutMs: 15 });
    f.setFetch(({ url }) => url.searchParams.get('sort_order') === 'asc' ? response({ data: [], resume_cursor: '10' }) : undefined);
    const result = await f.reader.read(); assert.equal(result.unavailableReason, 'timeout'); assert.equal(result.tps, null);
});

test('authorization and malformed cursor failures never expose prior values', async t => {
    const f = fixture(t); await f.reader.read();
    f.setFetch(({ url }) => url.searchParams.get('sort_order') === 'desc' ? response({}, false) : undefined);
    assert.equal((await f.reader.read()).unavailableReason, 'transport'); assert.equal(f.reader.peek().tps, null);
    f.setFetch(({ url }) => url.searchParams.get('sort_order') === 'desc' ? response({ data: [], resume_cursor: 'not-a-sequence' }) : undefined);
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-invalid');
});

test('untrusted paging envelopes cannot conceal a response or make an unbounded pagination loop', async t => {
    for (const page of [
        { data: [event({ type: 'ignored' }, 12), event({ type: 'ignored' }, 11)], resume_cursor: '12' },
        { data: [event({ type: 'ignored' }, 11)], next_cursor: '10' },
        { data: [], next_cursor: '10' },
        { data: [event({ type: 'ignored' }, '9007199254740992')], resume_cursor: '9007199254740992' },
        { data: Array.from({ length: 501 }, (_, i) => event({ type: 'ignored' }, i + 11)), resume_cursor: '511' },
    ]) {
        const f = fixture(t);
        f.setFetch(({ url }) => url.searchParams.get('sort_order') === 'asc' ? response(page) : undefined);
        assert.equal((await f.reader.read()).unavailableReason, 'snapshot-invalid');
        assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 1);
    }
});

test('RPC timeout aborts a body read that never finishes', async t => {
    const f = fixture(t, { timeoutMs: 15 }); let signal;
    f.setFetch(({ url, init }) => {
        if (url.searchParams.get('sort_order') !== 'asc') return;
        signal = init.signal; return { ok: true, text: () => new Promise(() => {}) };
    });
    assert.equal((await f.reader.read()).unavailableReason, 'timeout'); assert.equal(signal.aborted, true);
});

test('switching organizations discards cached numbers and a missing provider never fetches', async t => {
    const f = fixture(t); assert.equal((await f.reader.read()).tps, 20);
    f.editor.__reactFiber$test.return.memoizedProps.value.activeOrganization.uuid = '33333333-3333-4333-8333-333333333333';
    assert.equal(f.reader.peek(), null);
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-identity');
    f.editor.__reactFiber$test.return = null;
    const calls = f.requests.length;
    assert.equal(await f.reader.read(), null); assert.equal(f.requests.length, calls);
});

test('the current account provider can be above a deeply nested composer', async t => {
    const f = fixture(t); let provider = f.editor.__reactFiber$test.return;
    for (let depth = 0; depth < 160; depth++) provider = { memoizedProps: {}, return: provider };
    f.editor.__reactFiber$test.return = provider; assert.equal((await f.reader.read()).totalTokens, 1400);
});

test('serialized bridge returns pending at 750ms, finishes in the page and cleans up', async t => {
    const vm = require('node:vm'); const f = fixture(t); f.setSample(1, Date.now());
    f.advance(Date.now() - NOW); let release; const timers = new Map();
    f.setFetch(({ url }) => url.searchParams.get('sort_order') === 'asc' ? new Promise(resolve => { release = resolve; }) : undefined);
    const { script, cleanupScript } = buildRemoteScripts('slow-owner');
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController,
        setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
    const reply = vm.runInContext(script, context); await waitFor(() => release);
    [...timers.values()].find(timer => timer.ms === 750).fn(); assert.equal((await reply).unavailableReason, 'pending');
    assert.equal([...timers.values()].some(timer => timer.ms === 750), false);
    const posted = JSON.parse(f.requests.find(request => request.init.method === 'POST').init.body).events[0].payload;
    const sample = f.snapshot(); sample.generatedAt = Date.now();
    release(response({ data: [event({ type: 'control_response', response: { request_id: posted.request_id,
        subtype: 'success', response: { contents: JSON.stringify(sample), absPath: ABS_PATH } } }, 12)], resume_cursor: '12' }));
    const reader = f.win[Symbol.for('claudepp.session-stats.slow-owner')];
    assert.equal((await reader.read()).tps, 20); assert.equal(timers.size, 0);
    vm.runInContext(cleanupScript, context); assert.equal(f.win[Symbol.for('claudepp.session-stats.slow-owner')], undefined);
});

test('serialized child reader derives identity from the selected pane and rejects arbitrary script input', async t => {
    const vm = require('node:vm'), agentId = 'a123abc';
    const f = fixture(t, { sampleAgentId: agentId }); f.setSample(1, Date.now()); f.advance(Date.now() - NOW);
    const pane = f.win.document.createElement('div');
    pane.dataset.paneRoot = ''; pane.dataset.perfScreen = 'tasks'; pane.dataset.sessionStatsKey = 'pane-1';
    pane.getClientRects = () => [{ width: 200, height: 400 }]; f.win.document.body.append(pane);
    const top = { tag: 3, stateNode: {} }; top.stateNode.current = top;
    const ref = { id: ID, type: 'bridge' };
    const host = { stateNode: pane, memoizedProps: {}, return: top };
    host.child = { memoizedProps: { view: { kind: 'subagent', toolUseId: 'tool_1' }, sessionRef: ref }, return: host };
    host.child.child = { memoizedProps: { openedToolUseId: 'tool_1', sessionRef: ref,
        paneView: { agentId }, task: { taskId: agentId, toolUseId: 'tool_1' } }, return: host.child };
    pane.__reactFiber$test = host;
    f.setReply(reply => { const sample = JSON.parse(reply.response.response.contents);
        sample.generatedAt = Date.now(); reply.response.response.contents = JSON.stringify(sample); return reply; });
    const scripts = buildRemoteScripts('child-owner');
    assert.equal(typeof scripts.agentScript, 'function');
    for (const key of [null, '', 'pane-1);window.secret', 'x'.repeat(129)]) assert.equal(scripts.agentScript(key), null);
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController, setTimeout, clearTimeout });
    const result = await vm.runInContext(scripts.agentScript('pane-1'), context);
    assert.equal(result?.agentId, agentId); assert.equal(result?.tps, 20);
    pane.remove();
    assert.equal(await vm.runInContext(scripts.agentScript('pane-1'), context), null);
    vm.runInContext(scripts.cleanupScript, context);
    assert.equal(f.win[Symbol.for('claudepp.session-stats.child-owner')], undefined);
});
test('advertised snapshot requests do not use a current-directory or launch-root anchor', async t => {
    const f = fixture(t);
    f.setReply(value => {
        delete value.response.response.anchor;
        return value;
    });
    const result = await f.reader.read();
    assert.equal(result.status, 'ok');
    assert.equal(result.tps, 20);
    const posts = f.requests.filter(request => request.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].init.body).events[0].payload.request,
        { subtype: 'read_file', path: PATH, max_bytes: 16384, encoding: 'utf-8' });
});

test('a denied advertised read never tries another path, anchor or data source', async t => {
    const f = fixture(t);
    f.setReply(value => ({ ...value, response: { request_id: value.response.request_id,
        subtype: 'error', error: 'read denied: ' + PATH } }));
    const result = await f.reader.read();
    assert.equal(result.unavailableReason, 'snapshot-denied');
    assert.equal(result.tps, null);
    const posts = f.requests.filter(request => request.init.method === 'POST');
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0].init.body).events[0].payload.request,
        { subtype: 'read_file', path: PATH, max_bytes: 16384, encoding: 'utf-8' });
});

test('missing, legacy and malformed locations never request any file or write metadata', async t => {
    for (const [mutate, reason] of [
        [() => undefined, 'snapshot-missing'],
        [value => ({ ...value, protocolVersion: 1 }), 'snapshot-invalid'],
        [value => ({ protocolVersion: 1, bridgeSessionId: ID, organizationId: ORG,
            publisherId: PUBLISHER, generatedAt: NOW, parent: createSnapshotProtocol().makeSnapshot({
                bridgeSessionId: ID, organizationId: ORG }, STATS, { publisherId: PUBLISHER, revision: 1, now: NOW }),
            agents: [] }), 'snapshot-invalid'],
        [value => ({ ...value, protocolVersion: 3 }), 'snapshot-invalid'],
        [value => ({ ...value, parent: null, agents: [] }), 'snapshot-invalid'],
        [() => [], 'snapshot-invalid'],
        [value => ({ ...value, directory: '../.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, directory: 'https://example.com/.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, directory: '//server/share/.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, directory: '/home/runner/../.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, directory: '/home/' + 'x'.repeat(4096) + '/.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, directory: '/home/' + '😀'.repeat(2100) + '/.session-stats' }), 'snapshot-invalid'],
        [value => ({ ...value, bridgeSessionId: 'session_Other' }), 'snapshot-identity'],
        [value => ({ ...value, organizationId: '33333333-3333-4333-8333-333333333333' }), 'snapshot-identity'],
        [value => ({ ...value, generatedAt: NOW - 30001 }), 'snapshot-expired'],
        [value => ({ ...value, generatedAt: NOW + 5001 }), 'snapshot-future'],
    ]) {
        const f = fixture(t); f.setLocation(mutate); const result = await f.reader.read();
        assert.equal(result.unavailableReason, reason); assert.equal(result.totalTokens, null);
        assert.equal(f.requests.length, 1); assert.equal(f.requests[0].init.method, 'GET');
    }
});

test('detail-root metadata is accepted only after validating the exact connected bridge', async t => {
    for (const [session, expected] of [
        [{ id: ID, environment_kind: 'bridge', connection_status: 'connected' }, 1400],
        [{ id: 'session_Other', environment_kind: 'bridge', connection_status: 'connected' }, undefined],
        [{ id: ID, environment_kind: 'anthropic_cloud', connection_status: 'connected' }, undefined],
        [{ id: ID, environment_kind: 'bridge', connection_status: 'connected', shared: true }, undefined],
    ]) {
        const f = fixture(t);
        f.setDetail({ response_shape: session, client_metadata: { [KEY]: f.location() } });
        const result = await f.reader.read(); assert.equal(result?.totalTokens, expected);
        assert.equal(f.requests.some(value => value.init.method === 'POST'), expected !== undefined);
    }
});

test('present session metadata never falls back to a different root descriptor', async t => {
    for (const client_metadata of [[], {}, { [KEY]: { protocolVersion: 1 } }]) {
        const f = fixture(t);
        f.setDetail({ session: { id: ID, environment_kind: 'bridge', connection_status: 'connected', client_metadata },
            client_metadata: { [KEY]: f.location() } });
        const result = await f.reader.read();
        assert.equal(result.status, 'unavailable'); assert.equal(result.tps, null);
        assert.equal(f.requests.length, 1);
    }
});

test('a file from another publisher cannot satisfy the advertised location', async t => {
    const f = fixture(t);
    f.setSnapshot(value => ({ ...value, publisherId: '44444444-4444-4444-8444-444444444444' }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-identity');
});

test('an in-flight file is discarded when its location path or publisher changes', async t => {
    for (const change of [f => f.setDirectory('/new/config/.session-stats'),
        f => f.setPublisher('44444444-4444-4444-8444-444444444444')]) {
        const f = fixture(t); let release;
        f.setFetch(({ url, reply }) => url.searchParams.get('sort_order') === 'asc'
            ? new Promise(resolve => { const value = reply(); release = () => resolve(response({
                data: [event(value, 12)], resume_cursor: '12' })); }) : undefined);
        const pending = f.reader.read(); await waitFor(() => release); change(f); release();
        const result = await pending; assert.equal(result.status, 'unavailable'); assert.equal(result.tps, null);
        assert.equal(result.unavailableReason, 'snapshot-identity');
        assert.equal(f.requests.filter(value => value.init.method === 'POST').length, 1);
    }
});

test('location refresh during a read may advance time but cannot roll it back', async t => {
    for (const [shift, expected] of [[1, 'ok'], [-1, 'unavailable']]) {
        const f = fixture(t); let details = 0;
        f.setFetch(({ url }) => {
            if (!url.pathname.endsWith('/events') && ++details === 2)
                f.setLocation(value => ({ ...value, generatedAt: NOW + shift }));
        });
        const result = await f.reader.read(); assert.equal(result.status, expected);
        if (shift < 0) assert.equal(result.unavailableReason, 'snapshot-replay');
    }
});

test('fresh metadata cannot refresh an expired selected snapshot', async t => {
    const f = fixture(t); f.setSample(1, NOW - 30001);
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-expired');
});

test('valid zero usage remains zero while an unmeasured TPS remains null', async t => {
    const f = fixture(t);
    f.setSnapshot(value => ({ ...value, stats: { status: 'ok', turns: 0, steps: 0, totalTokens: 0,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheHit: 0, tps: null, usageComplete: true } }));
    const result = await f.reader.read(); assert.equal(result.status, 'ok');
    for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheHit'])
        assert.equal(result[field], 0, field);
    assert.equal(result.tps, null);
});

test('snapshot UTF-8 bound rejects file contents before invoking its parser', async t => {
    let parsed = false;
    const factory = () => ({ ...createSnapshotProtocol(), parseSnapshot() { parsed = true; throw new Error('oversized'); } });
    const f = fixture(t); f.setReply(value => ({ ...value, response: { ...value.response,
        response: { ...value.response.response, contents: '😀'.repeat(5000) } } }));
    const reader = createRemoteReader(f.win, factory, { now: () => NOW }); t.after(() => reader.stop());
    assert.equal((await reader.read()).unavailableReason, 'snapshot-invalid'); assert.equal(parsed, false);
});

test('identical repeated file reads replace totals and preserve the same revision', async t => {
    const f = fixture(t);
    for (let index = 0; index < 3; index++) {
        const result = await f.reader.read(); assert.equal(result.totalTokens, 1400); assert.equal(result.snapshotRevision, 1);
    }
    assert.equal(f.requests.filter(value => value.init.method === 'POST').length, 3);
    assert.equal(f.requests.some(value => value.init.method === 'PUT'), false);
});

test('concurrent main and visible child panes keep file paths and correlated responses separate', async t => {
    const agentId = 'a123abc', f = fixture(t), posts = [], replies = [];
    const child = createRemoteReader(f.win, createSnapshotProtocol, { now: () => NOW, responsePollMs: 1,
        resolveAgent: () => ({ sessionId: ID, agentId, remote: true }) }); t.after(() => child.stop());
    f.setFetch(({ url, init }) => {
        if (init.method === 'POST') {
            const payload = JSON.parse(init.body).events[0].payload; posts.push(payload);
            const isChild = payload.request.path.endsWith(`.agent-${agentId}.json`);
            const sample = f.snapshot(isChild ? agentId : undefined);
            replies.push(event({ type: 'control_response', response: { request_id: payload.request_id,
                subtype: 'success', response: { absPath: payload.request.path, contents: JSON.stringify({
                    ...sample, stats: { ...sample.stats, totalTokens: isChild ? 2100 : 1400 } }) } } }, replies.length + 11));
            return response({});
        }
        if (url.searchParams.get('sort_order') === 'asc') return response({ data: replies, resume_cursor: String(replies.length + 10) });
    });
    const [parentResult, childResult] = await Promise.all([f.reader.read(), child.read()]);
    assert.equal(parentResult.totalTokens, 1400); assert.equal(parentResult.agentId, undefined);
    assert.equal(childResult.totalTokens, 2100); assert.equal(childResult.agentId, agentId);
    assert.deepEqual(posts.map(value => value.request.path).sort(), [PATH, `${DIRECTORY}/${ID}.agent-${agentId}.json`].sort());
    assert.notEqual(posts[0].request_id, posts[1].request_id);
});

test('a new selected child can finish while the cancelled previous response is still pending', async t => {
    let selected = { sessionId: ID, agentId: 'child_A', remote: true }, release, signal;
    const f = fixture(t, { sampleAgentId: 'child_B', resolveAgent: () => selected });
    f.setFetch(({ url, init, requestId, requestedPath }) => {
        if (url.searchParams.get('sort_order') !== 'asc' || !requestedPath.endsWith('.agent-child_A.json')) return;
        signal = init.signal;
        return new Promise(resolve => { release = () => resolve(response({ data: [event({ type: 'control_response',
            response: { request_id: requestId, subtype: 'success', response: { absPath: requestedPath,
                contents: JSON.stringify(f.snapshot('child_A')) } } }, 12)], resume_cursor: '12' })); });
    });
    const old = f.reader.read(); await waitFor(() => release);
    selected = { ...selected, agentId: 'child_B' };
    const result = await f.reader.read(); assert.equal(signal.aborted, true);
    assert.equal(result.agentId, 'child_B'); assert.equal(result.totalTokens, 1400);
    release(); assert.equal(await old, null); assert.equal(f.reader.peek().agentId, 'child_B');
    const paths = f.requests.filter(value => value.init.method === 'POST')
        .map(value => JSON.parse(value.init.body).events[0].payload.request.path);
    assert.deepEqual(paths, [`${DIRECTORY}/${ID}.agent-child_A.json`, `${DIRECTORY}/${ID}.agent-child_B.json`]);
});

test('wrong parent and selected-child snapshot identities cannot supply another pane numbers', async t => {
    for (const [sampleAgentId, selected] of [['child_A', undefined], ['child_A', 'child_B'], [undefined, 'child_A']]) {
        const f = fixture(t, { sampleAgentId, ...(selected ? {
            resolveAgent: () => ({ sessionId: ID, agentId: selected, remote: true }),
        } : {}) });
        const result = await f.reader.read();
        assert.equal(result.unavailableReason, 'snapshot-identity'); assert.equal(result.tps, null);
    }
});

test('navigation and stop also abort a pending metadata body read without further file requests', async t => {
    for (const action of [f => { f.win.history.pushState({}, '', '/epitaxy/session_Other'); f.reader.peek(); },
        f => f.reader.stop()]) {
        const f = fixture(t); let reading = false, signal;
        f.setFetch(({ init }) => { signal = init.signal; return { ok: true,
            text() { reading = true; return new Promise(() => {}); } }; });
        const pending = f.reader.read(); await waitFor(() => reading); action(f);
        assert.equal(await pending, null); assert.equal(signal.aborted, true); assert.equal(f.requests.length, 1);
    }
});
