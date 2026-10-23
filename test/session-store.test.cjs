'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

async function setup(t) {
    const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-'));
    const store = createSessionStore({ claudeHome });
    t.after(async () => { store.dispose(); await fs.rm(claudeHome, { recursive: true }); });
    const write = async (id, text, project = 'project') => {
        const directory = path.join(claudeHome, 'projects', project);
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${id}.jsonl`);
        await fs.writeFile(file, text);
        return file;
    };
    return { claudeHome, store, write };
}
function line(id, output, extra = {}) {
    return JSON.stringify({ type: 'assistant', sessionId: ID, ...extra,
        message: { id, role: 'assistant', model: 'test', content: [{ type: 'text', text: 'private' }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70,
                output_tokens: output } } }) + '\n';
}
test('selects only the exact requested UUID and exposes no transcript or file path', async t => {
    const { store, write, claudeHome } = await setup(t);
    await write(ID, line('a', 5)); await write(OTHER, line('b', 9999));
    const stats = await store.getStats(ID);
    assert.equal(stats.status, 'ok'); assert.equal(stats.threadId, ID);
    assert.equal(stats.totalTokens, 105); assert.equal(stats.tps, null);
    assert.ok(!JSON.stringify(stats).includes('private'));
    assert.ok(!JSON.stringify(stats).includes(claudeHome));
});
test('invalid identifiers and missing logs stay unavailable', async t => {
    const { store } = await setup(t);
    for (const id of [null, '', '../secret', `${ID}.jsonl`])
        assert.equal((await store.getStats(id)).status, 'unavailable');
    assert.equal((await store.getStats(ID)).status, 'not-found');
});
test('incremental reads merge duplicate snapshots and wait for complete UTF-8 lines', async t => {
    const { store, write } = await setup(t);
    const file = await write(ID, line('a', 5));
    assert.equal((await store.getStats(ID)).totalTokens, 105);
    const data = Buffer.from(line('a', 15, { ignored: '中文' }));
    const split = data.indexOf(Buffer.from('中')) + 1;
    await fs.appendFile(file, data.subarray(0, split));
    assert.equal((await store.getStats(ID)).totalTokens, 105);
    await fs.appendFile(file, data.subarray(split));
    assert.equal((await store.getStats(ID)).totalTokens, 115);
    assert.equal((await store.getStats(ID)).steps, 1);
});
test('incremental continuation replay preserves prompt timing and cumulative usage', async t => {
    const { store, write } = await setup(t);
    const prompt = { type: 'user', sessionId: ID, uuid: 'u1', promptId: 'p1',
        timestamp: '2026-10-22T00:00:00Z', message: { role: 'user', content: 'test prompt' } };
    const file = await write(ID, JSON.stringify(prompt) + '\n'
        + line('m1', 40, { timestamp: '2026-10-22T00:00:10Z' }));
    assert.equal((await store.getStats(ID)).tps, 4);

    await fs.appendFile(file, JSON.stringify({ ...prompt, uuid: 'u2', timestamp: '2026-10-22T00:00:15Z' }) + '\n'
        + line('m1', 80, { timestamp: '2026-10-22T00:00:20Z' }));
    const continued = await store.getStats(ID);
    assert.equal(continued.status, 'ok'); assert.equal(continued.turns, 1); assert.equal(continued.steps, 1);
    assert.equal(continued.inputTokens, 100); assert.equal(continued.outputTokens, 80);
    assert.equal(continued.totalTokens, 180); assert.equal(continued.tps, 4);
    assert.deepEqual(await store.getStats(ID), continued);

    await fs.appendFile(file, JSON.stringify({ ...prompt, uuid: 'u3', promptId: 'p2',
        timestamp: '2026-10-22T00:00:30Z' }) + '\n');
    assert.equal((await store.getStats(ID)).tps, null);
    await fs.appendFile(file, line('m2', 30, { timestamp: '2026-10-22T00:00:36Z' }));
    assert.equal((await store.getStats(ID)).tps, 5);

    await fs.appendFile(file, JSON.stringify({ ...prompt, uuid: 'tool-result', promptId: 'p2',
        timestamp: '2026-10-22T00:02:00Z', message: { role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'test result' }] } }) + '\n');
    assert.equal((await store.getStats(ID)).tps, null);
    await fs.appendFile(file, line('m3', 60, { timestamp: '2026-10-22T00:02:10Z' }));
    const following = await store.getStats(ID);
    assert.equal(following.turns, 2); assert.equal(following.steps, 3);
    assert.equal(following.inputTokens, 300); assert.equal(following.outputTokens, 170);
    assert.equal(following.totalTokens, 470); assert.equal(following.tps, 6);
    assert.deepEqual(await store.getStats(ID), following);
});
test('resets after truncation and same-size rewrite', async t => {
    const { store, write } = await setup(t);
    const file = await write(ID, line('a', 5) + line('b', 8));
    assert.equal((await store.getStats(ID)).steps, 2);
    await fs.writeFile(file, line('c', 1));
    assert.equal((await store.getStats(ID)).totalTokens, 101);
    await fs.writeFile(file, line('d', 2));
    assert.equal((await store.getStats(ID)).totalTokens, 102);
});
test('duplicate UUID files in different projects fail closed', async t => {
    const { store, write } = await setup(t);
    await write(ID, line('a', 5), 'one'); await write(ID, line('b', 9), 'two');
    assert.equal((await store.getStats(ID)).status, 'not-found');
});
test('a cached session path is revalidated when the index expires', async t => {
    const { store, write } = await setup(t);
    await write(ID, line('a', 5), 'one');
    assert.equal((await store.getStats(ID)).status, 'ok');
    await write(ID, line('b', 9), 'two');
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 16000 });
    assert.equal((await store.getStats(ID)).status, 'not-found');
});
test('does not scan subagents or import records from a different session', async t => {
    const { store, write } = await setup(t);
    await write(ID, line('a', 5, { sessionId: OTHER }) + line('b', 7));
    assert.equal((await store.getStats(ID)).totalTokens, 107);
});
test('concurrent polling does not double-ingest, dispose invalidates results', async t => {
    const { store, write } = await setup(t);
    await write(ID, line('a', 5));
    const results = await Promise.all(Array.from({length: 8}, () => store.getStats(ID)));
    for (const s of results) assert.equal(s.totalTokens, 105);
    store.dispose(); assert.equal((await store.getStats(ID)).status, 'unavailable');
});
test('corrupt complete rows mark totals unavailable instead of reporting an undercount', async t => {
    const { store, write } = await setup(t);
    await write(ID, line('a', 5) + '{corrupt}\n');
    assert.equal((await store.getStats(ID)).status, 'incomplete');
});
