'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createMetrics } = require('../src/metrics.cjs');

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

test('TPS estimates the last response using timestamps, not thinking or aggregate cost timing', () =>
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

test('tool results start a new TPS interval without counting tool execution as generation', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('prompt', 'prompt', { timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user('tool', [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        { timestamp: '2026-01-01T00:02:00Z' }));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 300 }),
        { timestamp: '2026-01-01T00:02:06Z' }));
    assert.equal(metrics.snapshot().tps, 50);
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
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(assistant('next', completeUsage(), { timestamp: '2026-01-01T00:00:24Z' }));
    assert.equal(metrics.snapshot().tps, 10);
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

test('replaying an older prompt under another UUID cannot clear the newer response speed', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user('original', 'first', { promptId: 'first', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user('next', 'second', { promptId: 'second', timestamp: '2026-01-01T00:00:20Z' }));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(assistant('second', completeUsage(), { timestamp: '2026-01-01T00:00:22Z' }));
    metrics.ingest(user('old-replay', 'first', { promptId: 'first', timestamp: '2026-01-01T00:00:00Z' }));
    const stats = metrics.snapshot();
    assert.equal(stats.turns, 2);
    assert.equal(stats.steps, 2);
    assert.equal(stats.totalTokens, 280);
    assert.equal(stats.tps, 20);
});

test('tool results without UUIDs use tool identities independently of the prompt and replay carriers', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user(undefined, 'prompt', { promptId: 'prompt', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    const result = user(undefined, [{ type: 'tool_result', tool_use_id: 'tool-1' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:20Z' });
    metrics.ingest(result);
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(assistant('second', completeUsage({ output_tokens: 60 }),
        { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, 6);
    metrics.ingest({ ...result, uuid: 'replayed-tool', timestamp: '2026-01-01T00:00:40Z' });
    assert.equal(metrics.snapshot().tps, 6);
    metrics.ingest(user(undefined, [{ type: 'tool_result', tool_use_id: 'tool-2' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:50Z' }));
    assert.equal(metrics.snapshot().tps, null);
    metrics.ingest(assistant('third', completeUsage({ output_tokens: 100 }),
        { timestamp: '2026-01-01T00:01:00Z' }));
    const stats = metrics.snapshot();
    assert.equal(stats.turns, 1); assert.equal(stats.steps, 3);
    assert.equal(stats.totalTokens, 500); assert.equal(stats.tps, 10);
});

test('a tool result without a row or tool identity cannot lend the previous input time to TPS', () =>
{
    const metrics = createMetrics();
    metrics.ingest(user(undefined, 'prompt', { promptId: 'prompt', timestamp: '2026-01-01T00:00:00Z' }));
    metrics.ingest(assistant('first', completeUsage(), { timestamp: '2026-01-01T00:00:10Z' }));
    metrics.ingest(user(undefined, [{ type: 'tool_result' }],
        { promptId: 'prompt', timestamp: '2026-01-01T00:00:20Z' }));
    metrics.ingest(assistant('second', completeUsage(), { timestamp: '2026-01-01T00:00:30Z' }));
    assert.equal(metrics.snapshot().tps, null);
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
