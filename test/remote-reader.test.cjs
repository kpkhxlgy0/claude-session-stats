'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createRemoteReader, buildRemoteScripts } = require('../src/remote-reader.cjs');
const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';
const PATH = '.claude/session-stats/session_Test123.json';
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
    let clock = NOW, revision = 1, generatedAt = NOW, requestId;
    let detail = { session: { id: 'cse_Test123', environment_kind: 'ENVIRONMENT_KIND_BRIDGE', connection_status: 'connected' } };
    let onFetch = null, onReply = value => value;
    const requests = [];
    function snapshot() {
        return createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG }, STATS,
            { publisherId: PUBLISHER, revision, now: generatedAt });
    }
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        const request = { url: new URL(url), init, requestId, snapshot };
        if (onFetch) {
            const result = await onFetch(request);
            if (result !== undefined) return result;
        }
        if (init.method === 'POST') {
            requestId = JSON.parse(init.body).events[0].payload.request_id;
            return response({});
        }
        if (!request.url.pathname.endsWith('/events')) return response(detail);
        if (request.url.searchParams.get('sort_order') === 'desc') return response({ data: [], resume_cursor: '10' });
        return response({ data: [event(onReply({ type: 'control_response', response: { request_id: requestId,
            subtype: 'success', response: { contents: JSON.stringify(snapshot()), absPath: PATH, anchor: 'workspace_root' } } }), 12)], resume_cursor: '12' });
    };
    const reader = createRemoteReader(win, createSnapshotProtocol, { pollMs: 0, errorBackoffMs: 0,
        responsePollMs: 1, timeoutMs: 100, now: () => clock, ...options });
    t.after(() => reader.stop());
    return { win, reader, editor, requests, snapshot, setDetail(value) { detail = value; },
        setFetch(value) { onFetch = value; }, setReply(value) { onReply = value; },
        advance(ms) { clock += ms; }, setSample(value, at = clock) { revision = value; generatedAt = at; } };
}

test('reads the fixed workspace snapshot through one correlated control request and exports only its aggregates', async t => {
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
        encoding: 'utf-8', anchor: { kind: 'workspace_root' } });
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
            subtype: 'success', response: { contents: JSON.stringify(snapshot()), absPath: PATH, anchor: 'workspace_root' } } };
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
    for (const [error, reason] of [['read denied: file', 'snapshot-denied'], ['ENOENT', 'snapshot-missing'],
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
        value => ({ ...value, anchor: undefined }), value => ({ ...value, anchor: 'cwd' }),
        value => ({ ...value, absPath: '.claude/session-stats/session_Other.json' }),
        value => ({ ...value, absPath: `/workspace/../${PATH}` }),
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

test('canonical absolute file paths can identify only the same workspace-anchored snapshot', async t => {
    const f = fixture(t);
    f.setReply(value => ({ ...value, response: { ...value.response,
        response: { ...value.response.response, absPath: `C:\\work\\project\\${PATH.replaceAll('/', '\\')}` } } }));
    assert.equal((await f.reader.read()).totalTokens, 1400);
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
                absPath: PATH, anchor: 'workspace_root' } } }, 12)], resume_cursor: '12' })); }) : undefined);
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
    f.advance(1); f.setSample(1); assert.equal((await f.reader.read()).snapshotRevision, 1);
    f.setReply(value => value); f.setSample(4); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
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
    const vm = require('node:vm'); const f = fixture(t); let release; const timers = new Map();
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
        subtype: 'success', response: { contents: JSON.stringify(sample), absPath: PATH, anchor: 'workspace_root' } } }, 12)], resume_cursor: '12' }));
    const reader = f.win[Symbol.for('claudepp.session-stats.slow-owner')];
    assert.equal((await reader.read()).tps, 20); assert.equal(timers.size, 0);
    vm.runInContext(cleanupScript, context); assert.equal(f.win[Symbol.for('claudepp.session-stats.slow-owner')], undefined);
});
