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
function stream(type, extra = {}, timestamp) { return { type: 'stream_event', event: { type, ...extra }, timestamp }; }
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
test('new event sequences replay a continuation without resetting prompt timing or usage', async t => {
    const prompt = { ...user, promptId: 'p1' };
    const first = { ...assistant, timestamp: '2026-10-22T00:00:10Z' };
    const replay = { ...prompt, uuid: 'u2', timestamp: '2026-10-22T00:00:15Z' };
    const cumulative = { ...first, uuid: 'a2', timestamp: '2026-10-22T00:00:20Z',
        message: { ...first.message, usage: { ...usage, output_tokens: 80 } } };
    const nextPrompt = { ...prompt, uuid: 'u3', promptId: 'p2', timestamp: '2026-10-22T00:00:30Z' };
    const nextResponse = { ...assistant, uuid: 'a3', timestamp: '2026-10-22T00:00:36Z',
        message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 30 } } };
    const toolResult = { ...nextPrompt, uuid: 'tool-result', timestamp: '2026-10-22T00:02:00Z',
        message: { role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'test result' }] } };
    const toolResponse = { ...assistant, uuid: 'a4', timestamp: '2026-10-22T00:02:10Z',
        message: { ...assistant.message, id: 'm3', usage: { ...usage, output_tokens: 60 } } };
    const f = fixture(t, [{ data: [event(prompt, 1)], next_cursor: '1' },
        { data: [event(first, 2)], resume_cursor: '2' },
        { data: [event(replay, 3)], next_cursor: '3' },
        { data: [event(cumulative, 4)], resume_cursor: '4' },
        { data: [], resume_cursor: '4' },
        { data: [event(nextPrompt, 5)], resume_cursor: '5' },
        { data: [event(nextResponse, 6)], resume_cursor: '6' },
        { data: [event(toolResult, 7)], resume_cursor: '7' },
        { data: [event(toolResponse, 8)], resume_cursor: '8' }]);
    assert.equal((await f.reader.read()).tps, 4);

    const continued = await f.reader.read();
    assert.equal(continued.turns, 1); assert.equal(continued.steps, 1);
    assert.equal(continued.inputTokens, 100); assert.equal(continued.outputTokens, 80);
    assert.equal(continued.totalTokens, 180); assert.equal(continued.tps, 4);
    assert.deepEqual(await f.reader.read(), continued);

    assert.equal((await f.reader.read()).tps, 4);
    assert.equal((await f.reader.read()).tps, 110 / (20 + 6));
    assert.equal((await f.reader.read()).tps, 110 / (20 + 6));
    const following = await f.reader.read();
    assert.equal(following.turns, 2); assert.equal(following.steps, 3);
    assert.equal(following.inputTokens, 300); assert.equal(following.outputTokens, 170);
    assert.equal(following.totalTokens, 470); assert.equal(following.tps, 170 / (20 + 6 + 10));
    assert.deepEqual(await f.reader.read(), following);
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

test('session average survives new turns and active streams before reweighting completed samples', async t => {
    const next = { ...user, uuid: 'u2', promptId: 'p2', timestamp: '2026-10-22T00:00:10Z' };
    const partial = { ...assistant, uuid: 'a2', timestamp: '2026-10-22T00:00:12Z',
        message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 20 } } };
    const final = { ...partial, uuid: 'a3', timestamp: '2026-10-22T00:00:18Z',
        message: { ...partial.message, usage: { ...usage, output_tokens: 80 } } };
    const f = fixture(t, [
        { data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [event(next, 3), event({ type: 'stream_event', event: { type: 'message_start',
            message: { id: 'm2', usage: { ...usage, output_tokens: 1 } } } }, 4)], resume_cursor: '4' },
        { data: [event(partial, 5), event({ type: 'stream_event', event: { type: 'message_delta',
            usage: { output_tokens: 80 } } }, 6)], resume_cursor: '6' },
        { data: [event({ type: 'stream_event', timestamp: final.timestamp,
            event: { type: 'message_stop' } }, 7), event(final, 8)], resume_cursor: '8' },
        { data: [event({ ...next, uuid: 'u3', promptId: 'p3', timestamp: '2026-10-22T00:00:30Z' }, 9)],
            resume_cursor: '9' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const streaming = await f.reader.read();
    assert.equal(streaming.outputTokens, 60);
    assert.equal(streaming.tps, 20);
    const completed = await f.reader.read();
    assert.equal(completed.steps, 2); assert.equal(completed.outputTokens, 120);
    assert.equal(completed.tps, 120 / (2 + 8));
    assert.equal((await f.reader.read()).tps, completed.tps);
});

test('abandoned partial streams never become session average samples', async t => {
    const next = { ...user, uuid: 'u2', promptId: 'p2', timestamp: '2026-10-22T00:00:10Z' };
    const third = { ...next, uuid: 'u3', promptId: 'p3', timestamp: '2026-10-22T00:00:20Z' };
    const f = fixture(t, [
        { data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [event(next, 3), event({ type: 'stream_event', event: { type: 'message_start',
            message: { id: 'm2', usage } } }, 4), event({ ...assistant, uuid: 'a2',
            timestamp: '2026-10-22T00:00:11Z', message: { ...assistant.message, id: 'm2',
                usage: { ...usage, output_tokens: 1000 } } }, 5)], resume_cursor: '5' },
        { data: [event(third, 6)], resume_cursor: '6' },
        { data: [event({ ...assistant, uuid: 'a3', timestamp: '2026-10-22T00:00:24Z',
            message: { ...assistant.message, id: 'm3' } }, 7)], resume_cursor: '7' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const completed = await f.reader.read();
    assert.equal(completed.outputTokens, 1080);
    assert.equal(completed.tps, 80 / (2 + 4));
});

test('replayed starts of completed streams cannot hide their confirmed TPS', async t => {
    const start = { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage } } };
    const stop = { type: 'stream_event', timestamp: assistant.timestamp, event: { type: 'message_stop' } };
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stop, 3)], resume_cursor: '3' },
        { data: [event(start, 4)], resume_cursor: '4' },
        { data: [event(stop, 5)], resume_cursor: '5' },
    ]);
    const completed = await f.reader.read();
    assert.equal(completed.tps, 20);
    assert.deepEqual(await f.reader.read(), completed);
    assert.deepEqual(await f.reader.read(), completed);
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

test('replayed prompt carriers keep an incomplete usage stream until its final snapshot', async t => {
    const prompt = { ...user, promptId: 'p1' };
    const partial = { ...assistant, timestamp: '2026-10-22T00:00:10Z' };
    const final = { ...assistant, uuid: 'a2', timestamp: '2026-10-22T00:00:20Z',
        message: { ...assistant.message, usage: { ...usage, output_tokens: 80 } } };
    const f = fixture(t, [{ data: [event(prompt, 1),
        event({ type: 'stream_event', event: { type: 'message_start',
            message: { id: 'm1', role: 'assistant', model: 'test', usage: { ...usage, output_tokens: 1 } } } }, 2),
        event(partial, 3)], resume_cursor: '3' },
        { data: [event({ ...prompt, uuid: 'u2', timestamp: '2026-10-22T00:00:15Z' }, 4)], resume_cursor: '4' },
        { data: [event({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 80 } } }, 5),
            event({ type: 'stream_event', timestamp: final.timestamp, event: { type: 'message_stop' } }, 6)],
            resume_cursor: '6' },
        { data: [event(final, 7)], resume_cursor: '7' }]);
    const streaming = await f.reader.read();
    assert.equal(streaming.outputTokens, 40); assert.equal(streaming.tps, null);
    const replayed = await f.reader.read();
    assert.equal(replayed.outputTokens, 40); assert.equal(replayed.tps, null);
    const completed = await f.reader.read();
    assert.equal(completed.turns, 1); assert.equal(completed.steps, 1);
    assert.equal(completed.inputTokens, 100); assert.equal(completed.outputTokens, 80);
    assert.equal(completed.totalTokens, 180); assert.equal(completed.tps, 4);
    assert.deepEqual(await f.reader.read(), completed);
    assert.deepEqual(await f.reader.read(), completed);
});

test('genuine prompts and tool results discard an older incomplete usage stream', async t => {
    for (const [tool, withUuid] of [[false, true], [true, true], [false, false], [true, false]]) {
        const prompt = { ...user, uuid: withUuid ? user.uuid : undefined, promptId: 'p1' };
        const nextInput = { ...user, uuid: withUuid ? 'u2' : undefined, promptId: tool ? 'p1' : 'p2',
            timestamp: '2026-10-22T00:00:30Z', message: { role: 'user', content: tool
                ? [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'test result' }] : 'test next prompt' } };
        const f = fixture(t, [{ data: [event(prompt, 1),
            event({ type: 'stream_event', event: { type: 'message_start',
                message: { id: 'm1', usage: { ...usage, output_tokens: 1 } } } }, 2),
            event({ ...assistant, timestamp: '2026-10-22T00:00:10Z' }, 3)], resume_cursor: '3' },
            { data: [event(nextInput, 4)], resume_cursor: '4' },
            { data: [event({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 80 } } }, 5),
                event({ type: 'stream_event', timestamp: '2026-10-22T00:00:32Z',
                    event: { type: 'message_stop' } }, 6),
                event({ ...assistant, uuid: 'a2', timestamp: '2026-10-22T00:00:36Z',
                    message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 30 } } }, 7)],
                resume_cursor: '7' }]);
        assert.equal((await f.reader.read()).tps, null);
        assert.equal((await f.reader.read()).tps, null);
        const result = await f.reader.read();
        assert.equal(result.turns, tool ? 1 : 2); assert.equal(result.steps, 2);
        assert.equal(result.outputTokens, 70); assert.equal(result.totalTokens, 270); assert.equal(result.tps, 5);
    }
});

test('requestId-only assistant records retain the existing identity fallback', async t => {
    const f = fixture(t, [{ data: [event(user, 1),
        event({ ...assistant, requestId: 'request-1', message: { ...assistant.message, id: undefined } }, 2)] }]);
    const result = await f.reader.read();
    assert.equal(result?.steps, 1); assert.equal(result?.totalTokens, 140);
    assert.equal(result?.tps, 20);
});

test('active request-only snapshots remain pending through alias upgrades and complete once', async t => {
    const next = { ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' };
    const fallback = { ...assistant, requestId: 'r2', timestamp: '2026-10-22T00:00:12Z',
        message: { ...assistant.message, id: undefined, usage: { ...usage, output_tokens: 1000 } } };
    const linked = { ...fallback, timestamp: '2026-10-22T00:00:14Z', message: { ...fallback.message, id: 'm2' } };
    const f = fixture(t, [
        { data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [event(next, 3), event(stream('message_start', { message: { id: 'm2', usage } }), 4),
            event(fallback, 5)], resume_cursor: '5' },
        { data: [event(linked, 6)], resume_cursor: '6' },
        { data: [event(stream('message_delta', { usage: { output_tokens: 2000 } }), 7),
            event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 8)], resume_cursor: '8' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    const pending = await f.reader.read();
    assert.equal(pending.outputTokens, 1040); assert.equal(pending.tps, 20);
    const upgraded = await f.reader.read();
    assert.equal(upgraded.steps, 2); assert.equal(upgraded.outputTokens, 1040); assert.equal(upgraded.tps, 20);
    const completed = await f.reader.read();
    assert.equal(completed.steps, 2); assert.equal(completed.outputTokens, 2040); assert.equal(completed.tps, 204);
});

test('unassociated request fallbacks remain excluded after stream stop until explicitly linked', async t => {
    const fallback = { ...assistant, requestId: 'r2', timestamp: '2026-10-22T00:00:12Z',
        message: { ...assistant.message, id: undefined, usage: { ...usage, output_tokens: 1000 } } };
    const f = fixture(t, [
        { data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 3),
            event(stream('message_start', { message: { id: 'm2', usage } }), 4), event(fallback, 5)], resume_cursor: '5' },
        { data: [event(stream('message_delta', { usage: { output_tokens: 2000 } }), 6),
            event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 7)], resume_cursor: '7' },
        { data: [event({ ...fallback, timestamp: '2026-10-22T00:00:18Z',
            message: { ...fallback.message, id: 'm2', usage: { ...usage, output_tokens: 2000 } } }, 8)], resume_cursor: '8' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const unlinked = await f.reader.read();
    assert.equal(unlinked.steps, 3); assert.equal(unlinked.outputTokens, 3040); assert.equal(unlinked.tps, 204);
    const linked = await f.reader.read();
    assert.equal(linked.steps, 2); assert.equal(linked.outputTokens, 2040); assert.equal(linked.tps, 204);
});

test('request fallbacks from abandoned streams stay pending through a later explicit identity', async t => {
    const fallback = { ...assistant, requestId: 'r2', timestamp: '2026-10-22T00:00:12Z',
        message: { ...assistant.message, id: undefined, usage: { ...usage, output_tokens: 1000 } } };
    const f = fixture(t, [
        { data: [event(user, 1), event(assistant, 2)], resume_cursor: '2' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 3),
            event(stream('message_start', { message: { id: 'm2', usage } }), 4), event(fallback, 5)], resume_cursor: '5' },
        { data: [event({ ...user, uuid: 'u3', timestamp: '2026-10-22T00:00:20Z' }, 6)], resume_cursor: '6' },
        { data: [event({ ...fallback, timestamp: '2026-10-22T00:00:24Z',
            message: { ...fallback.message, usage: { ...usage, output_tokens: 2000 } } }, 7)], resume_cursor: '7' },
        { data: [event({ ...assistant, timestamp: '2026-10-22T00:00:24Z',
            message: { ...assistant.message, id: 'm3' } }, 8)], resume_cursor: '8' },
        { data: [event({ ...fallback, timestamp: '2026-10-22T00:00:14Z',
            message: { ...fallback.message, id: 'm2' } }, 9)], resume_cursor: '9' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    for (let poll = 0; poll < 3; poll++) assert.equal((await f.reader.read()).tps, 20);
    const later = await f.reader.read();
    assert.equal(later.outputTokens, 2080); assert.equal(later.tps, 80 / 6);
    assert.deepEqual(await f.reader.read(), later);
});

test('replaying a request-only sample confirmed before an active stream preserves its average', async t => {
    const confirmed = { ...assistant, requestId: 'r1', message: { ...assistant.message, id: undefined } };
    const f = fixture(t, [
        { data: [event(user, 1), event(confirmed, 2)], resume_cursor: '2' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 3),
            event(stream('message_start', { message: { id: 'm2', usage } }), 4),
            event(confirmed, 5)], resume_cursor: '5' },
    ]);
    const completed = await f.reader.read();
    assert.equal(completed.tps, 20);
    const pending = await f.reader.read();
    assert.equal(pending.tps, 20); assert.equal(pending.steps, 1); assert.equal(pending.outputTokens, 40);
});

test('a completed stream replay cannot mutate or finish a different active stream', async t => {
    const start = stream('message_start', { message: { id: 'm1', usage } });
    const stop = stream('message_stop', {}, assistant.timestamp);
    const partial = { ...assistant, timestamp: '2026-10-22T00:00:12Z',
        message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 1 } } };
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stop, 3)], resume_cursor: '3' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
            event(stream('message_start', { message: { id: 'm2', usage: { ...usage, output_tokens: 1 } } }), 5),
            event(partial, 6)], resume_cursor: '6' },
        { data: [event(start, 7), event(stream('message_delta', { usage: { output_tokens: 40 } }), 8),
            event(stop, 9)], resume_cursor: '9' },
        { data: [event({ ...partial, timestamp: '2026-10-22T00:00:14Z',
            message: { ...partial.message, usage: { ...usage, output_tokens: 1000 } } }, 10)], resume_cursor: '10' },
        { data: [event(stream('message_delta', { usage: { output_tokens: 2000 } }), 11),
            event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 12)], resume_cursor: '12' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    const pending = await f.reader.read();
    assert.equal(pending.tps, 20); assert.equal(pending.outputTokens, 41);
    assert.deepEqual(await f.reader.read(), pending);
    const continued = await f.reader.read();
    assert.equal(continued.tps, 20); assert.equal(continued.outputTokens, 1040);
    const completed = await f.reader.read();
    assert.equal(completed.tps, 204); assert.equal(completed.outputTokens, 2040);
});

test('an unclosed completed-stream replay cannot consume or complete an active response', async t => {
    const start = stream('message_start', { message: { id: 'm1', usage } });
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
            event(stream('message_start', { message: { id: 'm2', usage } }), 5), event(start, 6)], resume_cursor: '6' },
        { data: [event({ ...assistant, timestamp: '2026-10-22T00:00:14Z',
            message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 1000 } } }, 7),
            event(stream('message_delta', { usage: { output_tokens: 2000 } }), 8),
            event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 9)], resume_cursor: '9' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const pending = await f.reader.read();
    assert.equal(pending.tps, 20); assert.equal(pending.outputTokens, 1040);
});

test('an active stream can stop after a complete replay without repeating its final usage', async t => {
    const start = stream('message_start', { message: { id: 'm1', usage } });
    const stop = stream('message_stop', {}, assistant.timestamp);
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stop, 3)], resume_cursor: '3' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
            event(stream('message_start', { message: { id: 'm2', usage } }), 5),
            event(stream('message_delta', { usage: { output_tokens: 2000 } }), 6)], resume_cursor: '6' },
        { data: [event(start, 7), event(stream('message_delta', { usage: { output_tokens: 40 } }), 8),
            event(stop, 9)], resume_cursor: '9' },
        { data: [event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 10)], resume_cursor: '10' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const completed = await f.reader.read();
    assert.equal(completed.tps, 204); assert.equal(completed.outputTokens, 2040);
});

test('a new stream interleaved with an unclosed replay stays pending without guessing ownership', async t => {
    const start = stream('message_start', { message: { id: 'm1', usage } });
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
            event(stream('message_start', { message: { id: 'm2', usage } }), 5), event(start, 6),
            event(stream('message_start', { message: { id: 'm3', usage } }), 7),
            event(stream('message_stop', {}, assistant.timestamp), 8)], resume_cursor: '8' },
        { data: [event({ ...assistant, timestamp: '2026-10-22T00:00:14Z',
            message: { ...assistant.message, id: 'm3', usage: { ...usage, output_tokens: 1000 } } }, 9),
            event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 10)], resume_cursor: '10' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
});

test('genuine prompts and tool results recover new streams after an unclosed replay', async t => {
    for (const tool of [false, true]) {
        const start = stream('message_start', { message: { id: 'm1', usage } });
        const next = { ...user, uuid: 'u2', promptId: 'p2', timestamp: '2026-10-22T00:00:10Z' };
        const recovery = { ...next, uuid: 'u3', promptId: tool ? 'p2' : 'p3', timestamp: '2026-10-22T00:00:20Z',
            message: { role: 'user', content: tool ? [{ type: 'tool_result', tool_use_id: 'tool-1' }] : 'next prompt' } };
        const f = fixture(t, [
            { data: [event(user, 1), event(start, 2), event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
            { data: [event(next, 4), event(stream('message_start', { message: { id: 'm2', usage } }), 5),
                event({ ...assistant, timestamp: '2026-10-22T00:00:12Z',
                    message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 1000 } } }, 6),
                event(start, 7)], resume_cursor: '7' },
            { data: [event(recovery, 8), event(stream('message_start', { message: { id: 'm3', usage } }), 9),
                event(stream('message_delta', { usage: { output_tokens: 1000 } }), 10),
                event(stream('message_stop', {}, '2026-10-22T00:00:24Z'), 11)], resume_cursor: '11' },
            { data: [event({ ...next, uuid: 'u4', promptId: 'p4', timestamp: '2026-10-22T00:00:30Z' }, 12),
                event(stream('message_start', { message: { id: 'm4', usage } }), 13),
                event(stream('message_delta', { usage: { output_tokens: 2000 } }), 14),
                event(stream('message_stop', {}, '2026-10-22T00:00:38Z'), 15)], resume_cursor: '15' },
        ]);
        assert.equal((await f.reader.read()).tps, 20);
        const pending = await f.reader.read();
        assert.equal(pending.tps, 20); assert.equal(pending.steps, 2); assert.equal(pending.outputTokens, 1040);
        const recovered = await f.reader.read();
        assert.equal(recovered.steps, 3); assert.equal(recovered.outputTokens, 2040);
        assert.equal(recovered.tps, 1040 / 6); // The abandoned m2 output remains excluded.
        const continued = await f.reader.read();
        assert.equal(continued.steps, 4); assert.equal(continued.outputTokens, 4040);
        assert.equal(continued.tps, 3040 / 14); // m1 / 2s, m3 / 4s and m4 / 8s.
    }
});

test('replayed prompts and tool results cannot reset an unfinished replay boundary', async t => {
    for (const tool of [false, true]) {
        const start = stream('message_start', { message: { id: 'm1', usage } });
        const next = { ...user, uuid: 'u2', promptId: tool ? 'p1' : 'p2', timestamp: '2026-10-22T00:00:10Z',
            message: { role: 'user', content: tool ? [{ type: 'tool_result', tool_use_id: 'tool-1' }] : 'next prompt' } };
        const f = fixture(t, [
            { data: [event({ ...user, promptId: 'p1' }, 1), event(start, 2),
                event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
            { data: [event(next, 4), event(stream('message_start', { message: { id: 'm2', usage } }), 5),
                event({ ...assistant, timestamp: '2026-10-22T00:00:12Z',
                    message: { ...assistant.message, id: 'm2', usage: { ...usage, output_tokens: 1000 } } }, 6),
                event(start, 7)], resume_cursor: '7' },
            { data: [event({ ...next, uuid: 'replayed-input', timestamp: '2026-10-22T00:00:20Z' }, 8),
                event(stream('message_delta', { usage: { output_tokens: 9999 } }), 9),
                event(stream('message_stop', {}, assistant.timestamp), 10)], resume_cursor: '10' },
            { data: [event(stream('message_delta', { usage: { output_tokens: 2000 } }), 11),
                event(stream('message_stop', {}, '2026-10-22T00:00:18Z'), 12)], resume_cursor: '12' },
        ]);
        assert.equal((await f.reader.read()).tps, 20);
        const pending = await f.reader.read();
        assert.equal(pending.tps, 20); assert.equal(pending.outputTokens, 1040);
        assert.deepEqual(await f.reader.read(), pending);
        const completed = await f.reader.read();
        assert.equal(completed.steps, 2); assert.equal(completed.outputTokens, 2040); assert.equal(completed.tps, 204);
    }
});

test('a delayed replay tail cannot finish or pollute a stream after a genuine input', async t => {
    for (const [oldOutput, oldStop, startedAt, confirmedSnapshot] of [
        [40, '02', undefined, false], [2000, '02', undefined, false],
        [2000, '21', '22', false], [2000, '02', '22', true],
    ]) {
        const start = stream('message_start', { message: { id: 'm1', usage } });
        const confirmed = { ...assistant, timestamp: '2026-10-22T00:00:23Z',
            message: { ...assistant.message, id: 'm3', usage: { ...usage, output_tokens: 100 } } };
        const finalUsage = { output_tokens: 1000 };
        const final = confirmedSnapshot ? { ...confirmed, timestamp: '2026-10-22T00:00:24Z',
            message: { ...confirmed.message, usage: { ...usage, ...finalUsage } } }
            : stream('message_delta', { usage: finalUsage });
        const f = fixture(t, [
            { data: [event(user, 1), event(start, 2), event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
            { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
                event(stream('message_start', { message: { id: 'm2', usage } }), 5), event(start, 6)], resume_cursor: '6' },
            { data: [event({ ...user, uuid: 'u3', timestamp: '2026-10-22T00:00:20Z' }, 7),
                event(stream('message_start', { message: { id: 'm3', usage: confirmedSnapshot
                    ? { output_tokens: 1 } : { ...usage, output_tokens: 1 } } },
                startedAt ? `2026-10-22T00:00:${startedAt}Z` : undefined), 8),
                ...(confirmedSnapshot ? [event(confirmed, 9)] : [])], resume_cursor: '9' },
            { data: [event(stream('message_delta', { usage: { input_tokens: 9999,
                cache_creation_input_tokens: 9999, cache_read_input_tokens: 9999, output_tokens: oldOutput } }), 10),
                event(stream('message_stop', {}, `2026-10-22T00:00:${oldStop}Z`), 11)], resume_cursor: '11' },
            { data: [event(final, 12), event(stream('message_stop', {}, '2026-10-22T00:00:24Z'), 13)], resume_cursor: '13' },
        ]);
        assert.equal((await f.reader.read()).tps, 20);
        assert.equal((await f.reader.read()).tps, 20);
        const pending = await f.reader.read();
        assert.equal(pending.tps, 20); assert.equal(pending.outputTokens, confirmedSnapshot ? 140 : 40);
        assert.deepEqual(await f.reader.read(), pending);
        const completed = await f.reader.read();
        assert.equal(completed.steps, 2); assert.equal(completed.inputTokens, 200);
        assert.equal(completed.outputTokens, 1040); assert.equal(completed.totalTokens, 1240);
        assert.equal(completed.tps, 1040 / 6); // m1 / 2s and m3 / 4s, excluding the old replay tail.
    }
});

test('a conflicting stop without later trustworthy usage keeps the sample pending and permits later streams', async t => {
    const start = stream('message_start', { message: { id: 'm1', usage } });
    const f = fixture(t, [
        { data: [event(user, 1), event(start, 2), event(stream('message_stop', {}, assistant.timestamp), 3)], resume_cursor: '3' },
        { data: [event({ ...user, uuid: 'u2', timestamp: '2026-10-22T00:00:10Z' }, 4),
            event(stream('message_start', { message: { id: 'm2', usage } }), 5), event(start, 6)], resume_cursor: '6' },
        { data: [event({ ...user, uuid: 'u3', timestamp: '2026-10-22T00:00:20Z' }, 7),
            event(stream('message_start', { message: { id: 'm3', usage: { output_tokens: 1 } } }), 8),
            event({ ...assistant, timestamp: '2026-10-22T00:00:21Z',
                message: { ...assistant.message, id: 'm3', usage: { ...usage, output_tokens: 100 } } }, 9),
            event(stream('message_delta', { usage: { output_tokens: 2000 } }), 10),
            event(stream('message_stop', {}, assistant.timestamp), 11),
            event(stream('message_stop', {}, '2026-10-22T00:00:24Z'), 12)], resume_cursor: '12' },
        { data: [event({ ...user, uuid: 'u4', timestamp: '2026-10-22T00:00:30Z' }, 13),
            event(stream('message_start', { message: { id: 'm4', usage } }), 14),
            event(stream('message_delta', { usage: { output_tokens: 2000 } }), 15),
            event(stream('message_stop', {}, '2026-10-22T00:00:38Z'), 16)], resume_cursor: '16' },
    ]);
    assert.equal((await f.reader.read()).tps, 20);
    assert.equal((await f.reader.read()).tps, 20);
    const ambiguous = await f.reader.read();
    assert.equal(ambiguous.steps, 2); assert.equal(ambiguous.outputTokens, 140); assert.equal(ambiguous.tps, 20);
    const completed = await f.reader.read();
    assert.equal(completed.steps, 3); assert.equal(completed.outputTokens, 2140);
    assert.equal(completed.tps, 204); // m3's confirmed partial output stays excluded from the average.
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
