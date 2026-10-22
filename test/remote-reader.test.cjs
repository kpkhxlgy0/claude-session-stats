'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createMetrics } = require('../src/metrics.cjs');
const { createRemoteReader, buildRemoteScripts } = require('../src/remote-reader.cjs');
const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: 40 };
const user = { type: 'user', uuid: 'u1', timestamp: '2026-10-22T00:00:00Z', message: { role: 'user', content: 'private text' } };
const assistant = { type: 'assistant', uuid: 'a1', timestamp: '2026-10-22T00:00:02Z', message: { role: 'assistant', id: 'm1', usage } };
function event(payload, sequence_num) { return { event_id: `event-${sequence_num}`, sequence_num, payload }; }
function fixture(t, pages = [{ data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' }], options = {}) {
    const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: `https://claude.ai/epitaxy/${ID}` });
    t.after(() => dom.window.close());
    const win = dom.window, editor = win.document.querySelector('.ProseMirror');
    editor.getClientRects = () => [{ width: 100 }];
    editor.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
    const requests = [];
    let detail = { session: { id: ID, environment_kind: 'ENVIRONMENT_KIND_BRIDGE' } };
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        return { ok: true, text: async () => JSON.stringify(url.includes('/events?') ? pages.shift() ?? { data: [], resume_cursor: '2' } : detail) };
    };
    const reader = createRemoteReader(win, createMetrics, { pollMs: 0, ...options });
    t.after(() => reader.stop());
    return { win, reader, requests, editor, setDetail: value => { detail = value; } };
}
test('reads exact bridge history, uses raw usage and timestamps, exports only aggregates', async t => {
    const f = fixture(t); const result = await f.reader.read();
    assert.equal(result.threadId, ID); assert.equal(result.source, 'remote_control');
    assert.equal(result.turns, 1); assert.equal(result.steps, 1); assert.equal(result.totalTokens, 140);
    assert.equal(result.cacheHit, .7); assert.equal(result.tps, 20);
    assert.doesNotMatch(JSON.stringify(result), /private text|input_tokens|event-/);
    for (const req of f.requests) {
        assert.match(req.url, /^https:\/\/claude\.ai\/v1\/code\/sessions\/session_Test123/);
        assert.equal(req.init.credentials, 'include'); assert.equal(req.init.method, 'GET');
        assert.equal(req.init.headers['x-organization-uuid'], ORG);
    }
});
test('paginates in ascending sequence and resumes without double counting', async t => {
    const f = fixture(t, [{ data: [event(user, 1)], next_cursor: '1' },
        { data: [event(assistant, 2)], resume_cursor: '2' },
        { data: [event(assistant, 2)], resume_cursor: '2' }]);
    assert.equal((await f.reader.read()).totalTokens, 140);
    assert.equal((await f.reader.read()).totalTokens, 140);
    assert.match(f.requests[2].url, /sort_order=asc&cursor=1/);
    assert.match(f.requests.at(-1).url, /cursor=2/);
});
test('missing usage and timestamps are not synthesized from envelope time', async t => {
    const missing = { ...assistant, timestamp: undefined, message: { ...assistant.message, usage: { output_tokens: 40 } } };
    const f = fixture(t, [{ data: [event(user, 1), { ...event(missing, 2), created_at: '2026-10-22T00:00:02Z' }] }]);
    const result = await f.reader.read();
    assert.equal(result.totalTokens, null); assert.equal(result.cacheHit, null); assert.equal(result.tps, null);
});
test('cloud, shared, mismatched and ambiguous organizations never yield stats', async t => {
    const f = fixture(t);
    for (const detail of [{ session: { id: ID, environment_kind: 'anthropic_cloud' } },
        { shared: { session: { id: ID, environment_kind: 'bridge' } } },
        { session: { id: 'session_Other', environment_kind: 'bridge' } }]) {
        f.setDetail(detail); assert.equal(await f.reader.read(), null);
    }
    f.editor.__reactFiber$test.memoizedProps.activeOrganization = { uuid: '22222222-2222-4222-8222-222222222222' };
    assert.equal(await f.reader.read(), null);
});
test('partial pages and malformed records cannot look like complete totals', async t => {
    const f = fixture(t, [{ data: [event(user, 1)], next_cursor: '1' },
        { data: [event(assistant, 2)], next_cursor: 'invalid' }], { maxPages: 1 });
    const first = await f.reader.read(); assert.equal(first.totalTokens, null); assert.equal(first.turns, null);
    assert.equal(await f.reader.read(), null);
});
test('subagent and synthetic records do not affect root statistics', async t => {
    const f = fixture(t, [{ data: [event(user, 1), event(assistant, 2),
        event({ ...assistant, parent_tool_use_id: 'tool-1', message: { ...assistant.message, id: 'sub' } }, 3),
        event({ ...user, uuid: 'synthetic', isSynthetic: true }, 4)] }]);
    const result = await f.reader.read(); assert.equal(result.turns, 1); assert.equal(result.steps, 1);
});
test('navigation and stop invalidate pending fetch results', async t => {
    const f = fixture(t); let finish;
    f.win.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = f.reader.read();
    f.win.history.pushState({}, '', '/epitaxy/session_Other');
    finish({ ok: true, text: async () => JSON.stringify({ session: { id: ID, environment_kind: 'bridge' } }) });
    assert.equal(await pending, null);
    const next = f.reader.read(); f.reader.stop();
    finish({ ok: true, text: async () => '{}' }); assert.equal(await next, null);
});
test('generated page script is self contained and cleanup removes its own reader', async t => {
    const vm = require('node:vm'); const f = fixture(t);
    const { script, cleanupScript } = buildRemoteScripts('test-owner');
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController, setTimeout, clearTimeout });
    const result = await vm.runInContext(script, context);
    assert.equal(result.totalTokens, 140);
    vm.runInContext(cleanupScript, context);
    assert.equal(f.win[Symbol.for('claudepp.session-stats.test-owner')], undefined);
});

test('raw streaming usage and final snapshots count the response once', async t => {
    const stream = (type, extra, timestamp) => ({ type: 'stream_event', event: { type, ...extra }, timestamp });
    const f = fixture(t, [{ data: [event(user, 1),
        event(stream('message_start', { message: { id: 'm1', usage: { ...usage, output_tokens: 1 } } }), 2),
        event(stream('message_delta', { usage: { output_tokens: 40 } }), 3),
        event(stream('message_stop', {}, assistant.timestamp), 4), event(assistant, 5),
        event({ type: 'result', usage: { ...usage, output_tokens: 99999 } }, 6)] }]);
    const result = await f.reader.read();
    assert.equal(result.steps, 1); assert.equal(result.totalTokens, 140); assert.equal(result.tps, 20);
});
test('organization switches reset state and a missing provider never fetches', async t => {
    const f = fixture(t);
    await f.reader.read();
    f.editor.__reactFiber$test.return.memoizedProps.value.activeOrganization.uuid = '22222222-2222-4222-8222-222222222222';
    await f.reader.read(); assert.doesNotMatch(f.requests.at(-1).url, /cursor=/);
    const count = f.requests.length;
    delete f.editor.__reactFiber$test;
    assert.equal(await f.reader.read(), null); assert.equal(f.requests.length, count);
});
test('network failure resumes from the last complete page', async t => {
    const f = fixture(t, [{ data: [event(user, 1)], next_cursor: '1' },
        { data: [event(assistant, 2)], resume_cursor: '2' }], { maxPages: 1 });
    await f.reader.read();
    const fetch = f.win.fetch;
    f.win.fetch = async () => { throw new Error('offline'); };
    assert.equal(await f.reader.read(), null);
    f.win.fetch = fetch;
    const result = await f.reader.read(); assert.equal(result.totalTokens, 140); assert.equal(result.turns, 1);
    assert.match(f.requests.at(-1).url, /cursor=1/);
});
test('out-of-order history fails closed instead of silently skipping records', async t => {
    const f = fixture(t, [{ data: [event(assistant, 2), event(user, 1)] }]);
    assert.equal(await f.reader.read(), null);
});

test('a repeated tail cursor is a successful terminal page', async t => {
    const f = fixture(t, [{ data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [], next_cursor: '2', resume_cursor: '2' }]);
    assert.equal((await f.reader.read()).totalTokens, 140);
    assert.equal((await f.reader.read()).totalTokens, 140);
});

test('assistant content-block snapshots do not discard a still-running usage stream', async t => {
    const f = fixture(t, [{ data: [event(user, 1),
        event({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: { ...usage, output_tokens: 1 } } } }, 2),
        event({ ...assistant, message: { ...assistant.message, usage: { ...usage, output_tokens: 1 } } }, 3),
        event({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } }, 4),
        event({ type: 'stream_event', timestamp: assistant.timestamp, event: { type: 'message_stop' } }, 5)] }]);
    const result = await f.reader.read();
    assert.equal(result.outputTokens, 40); assert.equal(result.totalTokens, 140); assert.equal(result.tps, 20);
});

test('requestId-only assistant records retain the existing identity fallback', async t => {
    const f = fixture(t, [{ data: [event(user, 1),
        event({ ...assistant, requestId: 'request-1', message: { ...assistant.message, id: undefined } }, 2)] }]);
    const result = await f.reader.read();
    assert.equal(result?.steps, 1); assert.equal(result?.totalTokens, 140);
});

test('finds the account provider above a deeply nested Remote Control composer', async t => {
    const f = fixture(t);
    let provider = f.editor.__reactFiber$test.return;
    for (let depth = 0; depth < 160; depth++) provider = { memoizedProps: {}, return: provider };
    f.editor.__reactFiber$test.return = provider;
    assert.equal((await f.reader.read())?.totalTokens, 140);
});

test('confirmed remote session exposes pending stats while a slow history request continues', async t => {
    const f = fixture(t); const fetch = f.win.fetch; let release;
    f.win.fetch = (url, init) => url.includes('/events?') ? new Promise(resolve => { release = resolve; }) : fetch(url, init);
    const pending = f.reader.read();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const waiting = f.reader.peek();
    assert.equal(waiting.source, 'remote_control'); assert.equal(waiting.totalTokens, null);
    release({ ok: true, text: async () => JSON.stringify({ data: [event(user, 1), event(assistant, 2)] }) });
    assert.equal((await pending).totalTokens, 140); assert.equal(f.reader.peek().totalTokens, 140);
    f.reader.stop(); assert.equal(f.reader.peek(), null);
});

test('page bridge returns promptly while history keeps loading and clears its response timer', async t => {
    const vm = require('node:vm'); const f = fixture(t); const fetch = f.win.fetch;
    let release; const timers = new Map();
    f.win.fetch = (url, init) => url.includes('/events?') ? new Promise(resolve => { release = resolve; }) : fetch(url, init);
    const { script, cleanupScript } = buildRemoteScripts('slow-owner');
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController,
        setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
        clearTimeout(id) { timers.delete(id); } });
    const reply = vm.runInContext(script, context);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    [...timers.values()].find(timer => timer.ms === 750).fn();
    assert.equal((await reply).source, 'remote_control');
    assert.equal([...timers.values()].some(timer => timer.ms === 750), false);
    release({ ok: true, text: async () => JSON.stringify({ data: [event(user, 1), event(assistant, 2)] }) });
    await f.win[Symbol.for('claudepp.session-stats.slow-owner')].read();
    assert.equal((await vm.runInContext(script, context)).totalTokens, 140);
    assert.equal(timers.size, 0); vm.runInContext(cleanupScript, context);
});
