'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMetrics } = require('../src/metrics.cjs');

test('resetting a fork input boundary preserves samples and needs a new input for subsequent responses', () =>
{
    const metrics = createMetrics();
    metrics.ingest({ type: 'user', uuid: 'inherited-input', timestamp: '2026-01-01T00:00:00Z',
        message: { role: 'user', content: 'input' } });
    const response = (id, timestamp) => ({ type: 'assistant', timestamp,
        message: { role: 'assistant', id, usage: { output_tokens: 1000 } } });
    metrics.ingest(response('inherited', '2026-01-01T00:00:05Z'));
    metrics.resetInput();
    metrics.ingest(response('inherited', '2026-01-01T00:00:50Z'));
    metrics.ingest(response('own-without-input', '2026-01-01T00:01:00Z'));
    assert.equal(metrics.snapshot().tps, 200);
    assert.equal(metrics.snapshot().steps, 2);
});

function user(uuid, content = 'prompt', fields = {})
{
    return { type: 'user', sessionId: 'session-1', uuid, message: { role: 'user', content }, ...fields };
}

function assistant(id, usage = completeUsage(), fields = {})
{
    return {
        type: 'assistant', sessionId: 'session-1', uuid: `row-${id}`, requestId: `request-${id}`,
        message: { id, role: 'assistant', model: 'claude-test', usage }, ...fields
    };
}

function completeUsage(fields = {})
{
    return { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70,
        output_tokens: 40, ...fields };
}

test('an empty session leaves measurements unknown', () =>
{
    assert.deepEqual(createMetrics().snapshot(), {
        turns: 0, steps: null, totalTokens: null, inputTokens: null, outputTokens: null,
        cachedInputTokens: null, cacheHit: null, tps: null, usageComplete: false
    });
});

test('user turns deduplicate by promptId with uuid fallback', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('row-1', 'prompt', { promptId: 'prompt-1' }));
    metrics.ingest(user('row-2', [{ type: 'text', text: 'prompt' }], { promptId: 'prompt-1' }));
    metrics.ingest(user('row-3'));
    metrics.ingest(user('row-3'));
    metrics.ingest(user('row-4', [{ type: 'image', source: { type: 'base64', data: 'AA==' } }]));
    assert.equal(metrics.snapshot().turns, 3);
});

test('uuid and prompt aliases count one user turn in either arrival order', () =>
{
    for (const uuidFirst of [true, false])
    {
        const metrics = createMetrics();
        const uuid = user('row-1');
        const prompt = user('row-1', 'prompt', { promptId: 'prompt-1' });
        for (const row of uuidFirst ? [uuid, prompt, uuid] : [prompt, uuid, prompt]) metrics.ingest(row);
        metrics.ingest(user('row-2', 'prompt', { promptId: 'prompt-1' }));
        assert.equal(metrics.snapshot().turns, 1);
    }
});

test('separate uuid and prompt carriers collapse when their shared identity arrives', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('row-1'));
    metrics.ingest(user(undefined, 'prompt', { promptId: 'prompt-1' }));
    assert.equal(metrics.snapshot().turns, 2);
    metrics.ingest(user('row-1', 'prompt', { promptId: 'prompt-1' }));
    assert.equal(metrics.snapshot().turns, 1);
});

test('conflicting prompt IDs preserve the first UUID binding', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('row-1', 'prompt', { promptId: 'prompt-1' }));
    metrics.ingest(user('row-1', 'prompt', { promptId: 'prompt-2' }));
    assert.equal(metrics.snapshot().turns, 1);
    metrics.ingest(user('row-2', 'prompt', { promptId: 'prompt-2' }));
    metrics.ingest(user('row-1'));
    assert.equal(metrics.snapshot().turns, 2);
});

test('tool results and bookkeeping messages do not create user turns', () =>
{
    const metrics = createMetrics();
    for (const row of [
        user('tool', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'result' }]),
        user('meta', 'prompt', { isMeta: true }),
        user('sidechain', 'prompt', { isSidechain: true }),
        user('summary', 'prompt', { isCompactSummary: true }),
        user('synthetic', 'prompt', { isSynthetic: true }),
        user('empty', '  '), user('empty-array', []), user(undefined),
        user('wrong-role', 'prompt', { message: { role: 'assistant', content: 'prompt' } })
    ]) metrics.ingest(row);
    metrics.ingest(user('mixed', [{ type: 'tool_result' }, { type: 'text', text: 'prompt' }]));
    assert.equal(metrics.snapshot().turns, 1);
});

test('input includes ordinary tokens, cache writes and cache reads exactly once per response', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1'));
    metrics.ingest(assistant('message-1'));
    metrics.ingest(assistant('message-2', completeUsage({ output_tokens: 60 })));
    assert.deepEqual(metrics.snapshot(), {
        turns: 0, steps: 2, totalTokens: 300, inputTokens: 200, outputTokens: 100,
        cachedInputTokens: 140, cacheHit: 0.7, tps: null, usageComplete: true
    });
});

test('later cumulative snapshots merge fields and replay cannot roll usage back', () =>
{
    const metrics = createMetrics();
    const first = assistant('message-1', { input_tokens: 10, cache_read_input_tokens: 70, output_tokens: 1 });
    metrics.ingest(first);
    metrics.ingest(assistant('message-1', { cache_creation_input_tokens: 20, output_tokens: 40 }));
    metrics.ingest(assistant('message-1', completeUsage({ output_tokens: 30 })));
    metrics.ingest(first);
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().totalTokens, 140);
    assert.equal(metrics.snapshot().outputTokens, 40);
    assert.equal(metrics.snapshot().usageComplete, true);
});

test('requestId deduplicates a response when message id is unavailable', () =>
{
    const metrics = createMetrics();
    const row = assistant(undefined, completeUsage(), { requestId: 'request-1' });
    metrics.ingest(row);
    metrics.ingest(row);
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().totalTokens, 140);
});

test('message and request aliases join partial snapshots in either arrival order', () =>
{
    for (const requestFirst of [true, false])
    {
        const metrics = createMetrics();
        const request = assistant(undefined, completeUsage({ output_tokens: 1 }), { requestId: 'request-1' });
        const message = assistant('message-1', completeUsage(), { requestId: 'request-1' });
        for (const row of requestFirst ? [request, message, request] : [message, request, message])
        {
            metrics.ingest(row);
        }
        assert.equal(metrics.snapshot().steps, 1);
        assert.equal(metrics.snapshot().totalTokens, 140);
    }
});

test('conflicting message IDs remain distinct despite a shared request alias', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1', completeUsage(), { requestId: 'shared-request' }));
    metrics.ingest(assistant('message-2', completeUsage(), { requestId: 'shared-request' }));
    metrics.ingest(assistant(undefined, completeUsage({ output_tokens: 1000 }), { requestId: 'shared-request' }));
    assert.equal(metrics.snapshot().steps, 2);
    assert.equal(metrics.snapshot().totalTokens, 280);
});

test('a response without usage makes totals unknown until its usage arrives', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1'));
    metrics.ingest(assistant('message-2', null));
    const incomplete = metrics.snapshot();
    assert.equal(incomplete.steps, 2);
    assert.equal(incomplete.totalTokens, null);
    assert.equal(incomplete.inputTokens, null);
    assert.equal(incomplete.outputTokens, null);
    assert.equal(incomplete.cachedInputTokens, null);
    assert.equal(incomplete.cacheHit, null);
    assert.equal(incomplete.usageComplete, false);
    metrics.ingest(assistant('message-2'));
    assert.equal(metrics.snapshot().totalTokens, 280);
    assert.equal(metrics.snapshot().usageComplete, true);
});

test('missing output preserves independently complete input and cache measurements', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1', completeUsage({ output_tokens: undefined })));
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.inputTokens, 100);
    assert.equal(snapshot.cachedInputTokens, 70);
    assert.equal(snapshot.cacheHit, 0.7);
    assert.equal(snapshot.outputTokens, null);
    assert.equal(snapshot.totalTokens, null);
    assert.equal(snapshot.usageComplete, false);
});

for (const [label, value] of [
    ['negative', -1], ['fractional', 1.5], ['NaN', NaN], ['infinite', Infinity],
    ['string', '10'], ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['null', null]
])
{
    test(`a ${label} token count remains unknown`, () =>
    {
        const metrics = createMetrics();
        metrics.ingest(assistant('message-1', completeUsage({ input_tokens: value })));
        assert.equal(metrics.snapshot().inputTokens, null);
        assert.equal(metrics.snapshot().totalTokens, null);
        assert.equal(metrics.snapshot().cacheHit, null);
        assert.equal(metrics.snapshot().usageComplete, false);
    });
}

test('missing cache fields do not imply zero cache usage', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1', { input_tokens: 10, output_tokens: 40 }));
    assert.equal(metrics.snapshot().inputTokens, null);
    assert.equal(metrics.snapshot().cachedInputTokens, null);
    assert.equal(metrics.snapshot().cacheHit, null);
});

test('explicit zero usage is complete but has no cache-hit denominator', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1', {
        input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0
    }));
    assert.equal(metrics.snapshot().totalTokens, 0);
    assert.equal(metrics.snapshot().cacheHit, null);
    assert.equal(metrics.snapshot().usageComplete, true);
});

test('token sums cannot overflow the safe integer range', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1', completeUsage({ input_tokens: Number.MAX_SAFE_INTEGER })));
    assert.equal(metrics.snapshot().inputTokens, null);
    assert.equal(metrics.snapshot().totalTokens, null);
    assert.equal(metrics.snapshot().usageComplete, false);
});

test('synthetic, error and sidechain assistant rows do not count as model steps', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1'));
    for (const fields of [{ isApiErrorMessage: true }, { isSidechain: true }, { isMeta: true },
        { isCompactSummary: true }, { isSynthetic: true },
        { message: { id: 'synthetic', role: 'assistant', model: '<synthetic>', usage: completeUsage() } }])
    {
        metrics.ingest(assistant('excluded', completeUsage(), fields));
    }
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().totalTokens, 140);
});

test('explicit session selection rejects rows from another session', () =>
{
    const metrics = createMetrics({ sessionId: 'session-1' });
    metrics.ingest(user('foreign', 'prompt', { sessionId: 'session-2' }));
    metrics.ingest(assistant('foreign', completeUsage(), { sessionId: 'session-2' }));
    metrics.ingest(user('local'));
    metrics.ingest(assistant('local'));
    assert.equal(metrics.snapshot().turns, 1);
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().totalTokens, 140);
});

test('unspecified session binds to the first accepted session', () =>
{
    const metrics = createMetrics();
    metrics.ingest({ type: 'system', sessionId: 'ignored' });
    metrics.ingest(user('local'));
    metrics.ingest(user('foreign', 'prompt', { sessionId: 'session-2' }));
    metrics.ingest(assistant('foreign', completeUsage(), { sessionId: 'session-2' }));
    metrics.ingest(assistant('local'));
    assert.equal(metrics.snapshot().turns, 1);
    assert.equal(metrics.snapshot().steps, 1);
});

test('malformed records cannot corrupt a complete measurement', () =>
{
    const metrics = createMetrics();
    metrics.ingest(assistant('message-1'));
    for (const row of [null, [], {}, { type: 'assistant', message: null },
        assistant(undefined, completeUsage(), { requestId: undefined }),
        assistant('message-1', completeUsage({ output_tokens: -1 })),
        { type: 'assistant', message: { id: 'wrong-role', role: 'user' } }]) metrics.ingest(row);
    assert.equal(metrics.snapshot().steps, 1);
    assert.equal(metrics.snapshot().totalTokens, 140);
    assert.equal(metrics.snapshot().usageComplete, true);
});

test('TPS estimates response time using timestamps, not thinking or aggregate cost timing', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('user-1', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('message-1', completeUsage(), {
        timestamp: '2026-01-01T00:00:10Z', thinkingDurationMs: 1000,
        started_at_ms: 0, completed_at_ms: 2000
    }));
    metrics.ingest({ type: 'system', subtype: 'cost', totalAPIDuration: 2000, totalToolDuration: 1000 });
    assert.equal(metrics.snapshot().tps, 4);
});

test('tool results preserve the session TPS and start the next interval after tool execution', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('prompt', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user('tool', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        { timestamp: '2026-01-01T00:02:00Z' }));
    assert.equal(metrics.snapshot().tps, 4);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 300 }),
        { timestamp: '2026-01-01T00:02:06Z' }));
    assert.equal(metrics.snapshot().tps, 21.25); // (40 + 300) tokens / (10 + 6) seconds.
    assert.equal(metrics.snapshot().turns, 1);
});

test('cumulative response blocks and replay keep one output count and the original start', () =>
{
    const metrics = createMetrics();
    const prompt = user('prompt', 'prompt', { timestamp: '2026-01-01T00:00:00Z' });
    const first = assistant('response', completeUsage({ output_tokens: 1 }),
        { timestamp: '2026-01-01T00:00:02Z' });
    metrics.ingest(prompt);
    metrics.ingest(first);
    metrics.ingest(assistant('response', completeUsage({ output_tokens: 400 }),
        { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(prompt);
    metrics.ingest(first);
    assert.equal(metrics.snapshot().tps, 40);
    assert.equal(metrics.snapshot().steps, 1);
    metrics.ingest(user('next', 'next', { timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(first);
    assert.equal(metrics.snapshot().tps, 40);
    metrics.ingest(assistant('next', completeUsage(), { timestamp: '2026-01-01T00:00:24Z' }));
    assert.equal(metrics.snapshot().tps, 440 / 14); // 400 / 10 seconds and 40 / 4 seconds.
});

test('replayed prompt aliases preserve TPS and cumulative usage when the carrier UUID changes', () =>
{
    for (const firstUuid of ['original', undefined])
    {
        const metrics = createMetrics();
        metrics.ingest(user(firstUuid, 'prompt', { promptId: 'same-prompt', timestamp: '2026-01-01T00:00:00Z' }));
        metrics.ingest(assistant('response', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
        assert.equal(metrics.snapshot().tps, 4);
        metrics.ingest(user('replayed', 'prompt', { promptId: 'same-prompt', timestamp: '2026-01-01T00:00:15Z' }));
        assert.equal(metrics.snapshot().tps, 4);
        metrics.ingest(assistant('response', completeUsage({ output_tokens: 80 }),
            { timestamp: '2026-01-01T00:00:20Z' }));
        const stats = metrics.snapshot();
        assert.equal(stats.turns, 1);
        assert.equal(stats.steps, 1);
        assert.equal(stats.totalTokens, 180);
        assert.equal(stats.outputTokens, 80);
        assert.equal(stats.tps, 4);
    }
});

test('replaying an older prompt under another UUID preserves the session response samples', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('original', 'first', { promptId: 'first', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user('next', 'second', { promptId: 'second', timestamp: '2026-01-01T00:00:20Z' }));
    assert.equal(metrics.snapshot().tps, 4);
    metrics.ingest(assistant('second', completeUsage(), { timestamp: '2026-01-01T00:00:22Z' }));
    metrics.ingest(user('old-replay', 'first', { promptId: 'first', timestamp: '2026-01-01T00:00:00Z' }));
    const stats = metrics.snapshot();
    assert.equal(stats.turns, 2);
    assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 280);
    assert.equal(stats.tps, 80 / 12); // Two 40-token responses taking 10 and 2 seconds.
});

test('tool results without UUIDs use tool identities independently of the prompt and replay carriers', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user(undefined, 'prompt', { promptId: 'prompt', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    const result = user(undefined, [{ type: 'tool_result', tool_use_id: 'tool-1' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:20Z' });
    metrics.ingest(result);
    assert.equal(metrics.snapshot().tps, 4);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 60 }),
        { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 5); // (40 + 60) tokens / (10 + 10) seconds.
    metrics.ingest({ ...result, uuid: 'replayed-tool', timestamp: '2026-01-01T00:00:40Z' });
    assert.equal(metrics.snapshot().tps, 5);
    metrics.ingest(user(undefined, [{ type: 'tool_result', tool_use_id: 'tool-2' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:50Z' }));
    assert.equal(metrics.snapshot().tps, 5);
    metrics.ingest(assistant('third', completeUsage({ output_tokens: 100 }),
        { timestamp: '2026-01-01T00:01:00Z' }));
    const stats = metrics.snapshot();
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 500); assert.equal(stats.tps, 200 / 30);
});

test('a tool result without a row or tool identity cannot lend the previous input time to TPS', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user(undefined, 'prompt', { promptId: 'prompt', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user(undefined, [{ type: 'tool_result' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(assistant('second', completeUsage(), { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 4); // The second response has no trustworthy start time.
    assert.equal(metrics.snapshot().totalTokens, 280);
});

test('TPS stays unknown for missing, reversed or too short timing and missing output', () =>
{
    for (const [start, end, output] of [
        [undefined, '2026-01-01T00:00:10Z', 40],
        ['2026-01-01T00:00:00Z', undefined, 40],
        ['invalid', '2026-01-01T00:00:10Z', 40],
        ['2026-01-01T00:00:10Z', '2026-01-01T00:00:00Z', 40],
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 40],
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.050Z', 40],
        ['2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z', undefined]
    ])
    {
        const metrics = createMetrics();
        metrics.ingest(user('prompt', 'prompt', { timestamp: start }));
        metrics.ingest(assistant('response', completeUsage({ output_tokens: output }), { timestamp: end }));
        assert.equal(metrics.snapshot().tps, null);
    }
});

test('request aliases preserve the TPS interval and excluded rows cannot move it', () =>
{
    const metrics = createMetrics({ sessionId: 'session-1' });
    metrics.ingest(user('prompt', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant(undefined, completeUsage({ output_tokens: 1 }),
        { requestId: 'request-1', timestamp: '2026-01-01T00:00:02Z' }));
    for (const fields of [{ isMeta: true }, { isSidechain: true }, { sessionId: 'session-2' }])
        metrics.ingest(user('excluded', 'prompt', { timestamp: '2026-01-01T00:00:08Z', ...fields }));
    metrics.ingest(assistant('response', completeUsage({ output_tokens: 400 }),
        { requestId: 'request-1', timestamp: '2026-01-01T00:00:10Z' }));
    assert.equal(metrics.snapshot().tps, 40);
    assert.equal(metrics.snapshot().steps, 1);
});

test('session TPS divides total response output by total duration across user turns', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage({ output_tokens: 1000 }),
        { timestamp: '2026-01-01T00:00:05Z' }));
    assert.equal(metrics.snapshot().tps, 200);
    metrics.ingest(user('second', 'next', { timestamp: '2026-01-01T00:00:10Z' }));
    assert.equal(metrics.snapshot().tps, 200);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 1000 }),
        { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 80); // 2000 tokens / 25 seconds, rather than (200 + 50) / 2.
});

test('pending response IDs exclude only matching TPS samples while retaining every usage count', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user('second', 'next', { timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 300 }),
        { timestamp: '2026-01-01T00:00:26Z' }));
    metrics.ingest(user('third', 'next', { timestamp: '2026-01-01T00:00:30Z' }));
    metrics.ingest(assistant('third', completeUsage({ output_tokens: 100 }),
        { timestamp: '2026-01-01T00:00:40Z' }));
    const all = metrics.snapshot();
    assert.deepEqual(metrics.snapshot({ pendingResponseId: 'second' }), { ...all, tps: 7 });
    assert.deepEqual(metrics.snapshot({ pendingResponseId: 'request-second' }), all);
    assert.deepEqual(metrics.snapshot({ pendingResponseId: 'message:second' }), all);
    assert.equal(all.tps, 440 / 26);
    assert.deepEqual(metrics.snapshot(), all);
});

test('multiple pending responses stay excluded together until completed', () =>
{
    const metrics = createMetrics();
    for (const [id, start, end, output] of [
        ['first', '00', '10', 40], ['second', '20', '30', 1000], ['third', '40', '50', 2000]
    ])
    {
        metrics.ingest(user(id, 'prompt', { timestamp: `2026-01-01T00:00:${start}Z` }));
        metrics.ingest(assistant(id, completeUsage({ output_tokens: output }),
            { timestamp: `2026-01-01T00:00:${end}Z` }));
    }
    const all = metrics.snapshot();
    assert.deepEqual(metrics.snapshot({ pendingResponseIds: ['second', 'third'] }), { ...all, tps: 4 });
    assert.deepEqual(metrics.snapshot({ pendingResponseId: 'first', pendingResponseIds: ['second', 'third'] }),
        { ...all, tps: null });
    assert.deepEqual(metrics.snapshot(), all);
});

test('known zero-output responses contribute elapsed time but cannot create a positive TPS alone', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('zero', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('zero', completeUsage({ output_tokens: 0 }),
        { timestamp: '2026-01-01T00:00:10Z' }));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(user('positive', 'prompt', { timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(assistant('positive', completeUsage(), { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 2); // 40 tokens over both ten-second responses.
    assert.equal(metrics.snapshot({ pendingResponseId: 'zero' }).tps, 4);
});

test('missing or invalid response data contributes neither output nor duration to session TPS', () =>
{
    for (const [start, end, output] of [
        [undefined, '2026-01-01T00:00:30Z', 10000],
        ['2026-01-01T00:00:20Z', undefined, 10000],
        ['invalid', '2026-01-01T00:00:30Z', 10000],
        ['2026-01-01T00:00:20Z', 'invalid', 10000],
        [Infinity, '2026-01-01T00:00:30Z', 10000],
        ['2026-01-01T00:00:20Z', NaN, 10000],
        ['2026-01-01T00:00:30Z', '2026-01-01T00:00:20Z', 10000],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:20Z', 10000],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:20.099Z', 10000],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', undefined],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', -1],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', 1.5],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', NaN],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', Infinity],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', '40'],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', Number.MAX_SAFE_INTEGER + 1],
        ['2026-01-01T00:00:20Z', '2026-01-01T00:00:30Z', null]
    ])
    {
        const metrics = createMetrics();
        metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
        metrics.ingest(assistant('first', completeUsage({ output_tokens: 1000 }),
            { timestamp: '2026-01-01T00:00:05Z' }));
        metrics.ingest(user('invalid', 'prompt', { timestamp: start }));
        metrics.ingest(assistant('invalid', completeUsage({ output_tokens: output }), { timestamp: end }));
        assert.equal(metrics.snapshot().tps, 200, JSON.stringify([start, end, output]));
    }
});

test('a response lasting exactly 100 milliseconds is a usable TPS sample', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('prompt', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('response', completeUsage({ output_tokens: 20 }),
        { timestamp: '2026-01-01T00:00:00.100Z' }));
    assert.equal(metrics.snapshot().tps, 200);
});

test('cumulative usage updates replace a session sample and replay cannot double-count it', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage({ output_tokens: 1000 }),
        { timestamp: '2026-01-01T00:00:05Z' }));
    metrics.ingest(user('second', 'prompt', { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(assistant('second', completeUsage({ output_tokens: undefined }),
        { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 200);
    const completed = assistant('second', completeUsage({ output_tokens: 1000 }),
        { timestamp: '2026-01-01T00:00:30Z' });
    metrics.ingest(completed);
    assert.equal(metrics.snapshot().tps, 80);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 2000 }),
        { timestamp: '2026-01-01T00:00:35Z' }));
    metrics.ingest(completed);
    assert.equal(metrics.snapshot().tps, 100); // (1000 + 2000) tokens / (5 + 25) seconds.
    assert.equal(metrics.snapshot().steps, 2);
    assert.equal(metrics.snapshot().outputTokens, 3000);
});

test('request-to-message alias upgrades contribute one session sample in either arrival order', () =>
{
    for (const requestFirst of [true, false])
    {
        const metrics = createMetrics();
        metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
        metrics.ingest(assistant('first', completeUsage({ output_tokens: 1000 }),
            { timestamp: '2026-01-01T00:00:05Z' }));
        metrics.ingest(user('second', 'next', { timestamp: '2026-01-01T00:00:10Z' }));
        const request = assistant(undefined, completeUsage({ output_tokens: 1 }),
            { requestId: 'shared-request', timestamp: '2026-01-01T00:00:12Z' });
        const message = assistant('second', completeUsage({ output_tokens: 1000 }),
            { requestId: 'shared-request', timestamp: '2026-01-01T00:00:30Z' });
        for (const row of requestFirst ? [request, message, request] : [message, request, message])
            metrics.ingest(row);
        assert.equal(metrics.snapshot().tps, 80);
        assert.equal(metrics.snapshot().steps, 2);
        assert.equal(metrics.snapshot().outputTokens, 2000);
        assert.equal(metrics.snapshot({ pendingResponseId: 'second' }).tps, 200);
    }
});

test('session TPS becomes unknown when the valid sample output sum exceeds safe integers', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage({ output_tokens: Number.MAX_SAFE_INTEGER }),
        { timestamp: '2026-01-01T00:00:10Z' }));
    assert.equal(metrics.snapshot().tps, Number.MAX_SAFE_INTEGER / 10);
    metrics.ingest(user('second', 'prompt', { timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(assistant('second', completeUsage({ output_tokens: Number.MAX_SAFE_INTEGER }),
        { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, null);
    assert.equal(metrics.snapshot({ pendingResponseId: 'second' }).tps, Number.MAX_SAFE_INTEGER / 10);
});

test('pending request fallbacks stay excluded until their explicit message identity arrives', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('first', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:02Z' }));
    metrics.ingest(user('second', 'next', { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(assistant(undefined, completeUsage({ output_tokens: 1000 }),
        { requestId: 'request-2', timestamp: '2026-01-01T00:00:12Z' }));
    const pending = metrics.snapshot();
    assert.equal(pending.tps, 260);
    assert.deepEqual(metrics.snapshot({ pendingResponseId: 'second', pendingRequestIds: ['request-2'] }),
        { ...pending, tps: 20 });
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 1000 }),
        { requestId: 'request-2', timestamp: '2026-01-01T00:00:14Z' }));
    assert.equal(metrics.snapshot({ pendingResponseId: 'second', pendingRequestIds: ['request-2'] }).tps, 20);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 2000 }),
        { requestId: 'request-2', timestamp: '2026-01-01T00:00:18Z' }));
    const completed = metrics.snapshot({ pendingRequestIds: ['request-2'] });
    assert.equal(completed.tps, 204); // (40 + 2000) tokens / (2 + 8) seconds.
    assert.equal(completed.steps, 2); assert.equal(completed.outputTokens, 2040);
});

test('explicit agent metrics include only the exact parent sidechain and retain deduplication and TPS', () =>
{
    const metrics = createMetrics({ sessionId: 'session-1', agentId: 'agent-1' });
    const scope = { agentId: 'agent-1', isSidechain: true };
    for (const fields of [
        { ...scope, sessionId: 'other' }, { ...scope, sessionId: undefined },
        { ...scope, agentId: 'other' }, { ...scope, agentId: undefined },
        { ...scope, isSidechain: false }, { ...scope, isSidechain: undefined }
    ])
    {
        metrics.ingest(user('foreign', 'prompt', fields));
        metrics.ingest(assistant('foreign', completeUsage({ output_tokens: 999 }), fields));
    }
    metrics.ingest(user('own', 'prompt', { ...scope, timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('own', completeUsage(), { ...scope, timestamp: '2026-01-01T00:00:02Z' }));
    metrics.ingest(assistant('own', completeUsage({ output_tokens: 60 }),
        { ...scope, timestamp: '2026-01-01T00:00:03Z' }));
    assert.deepEqual(metrics.snapshot(), {
        turns: 1, steps: 1, totalTokens: 160, inputTokens: 100, outputTokens: 60,
        cachedInputTokens: 70, cacheHit: 0.7, tps: 20, usageComplete: true
    });
});

test('agent mode cannot learn a missing parent identity from incoming records', () =>
{
    const metrics = createMetrics({ agentId: 'agent-1' });
    metrics.ingest(user('foreign', 'prompt', { agentId: 'agent-1', isSidechain: true }));
    metrics.ingest(assistant('foreign', completeUsage(), { agentId: 'agent-1', isSidechain: true }));
    assert.equal(metrics.snapshot().turns, 0);
    assert.equal(metrics.snapshot().steps, null);
});
