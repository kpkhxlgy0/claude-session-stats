'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const ID = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const marker = { type: 'relocated', sessionId: ID, relocatedCwd: 'unused-local-directory' };
const root = { type: 'attachment', sessionId: OLD, uuid: 'root', parentUuid: null };

function user(uuid, parentUuid, sessionId, seconds, promptId = uuid, extra = {}) {
    return { type: 'user', sessionId, uuid, parentUuid, promptId,
        timestamp: `2026-10-22T00:00:${String(seconds).padStart(2, '0')}Z`,
        message: { role: 'user', content: 'private prompt' }, ...extra };
}

function assistant(uuid, parentUuid, sessionId, seconds, output, messageId = uuid, extra = {}) {
    return { type: 'assistant', sessionId, uuid, parentUuid,
        timestamp: `2026-10-22T00:00:${String(seconds).padStart(2, '0')}Z`,
        message: { id: messageId, role: 'assistant', model: 'test',
            content: [{ type: 'text', text: 'private reply' }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 20,
                cache_read_input_tokens: 70, output_tokens: output } }, ...extra };
}

const oldInput = user('old-user', 'root', OLD, 0, 'old-prompt');
const oldReply = assistant('old-reply', 'old-user', OLD, 10, 40, 'old-message');
const newInput = user('new-user', 'old-reply', ID, 30, 'new-prompt');
const newReply = assistant('new-reply', 'new-user', ID, 36, 30, 'new-message');

function lines(records) { return records.map(record => JSON.stringify(record) + '\n').join(''); }

async function setup(t, records) {
    const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-relocation-'));
    const directory = path.join(claudeHome, 'projects', 'project');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${ID}.jsonl`);
    await fs.writeFile(file, lines(records));
    const store = createSessionStore({ claudeHome });
    t.after(async () => { store.dispose(); await fs.rm(claudeHome, { recursive: true }); });
    return { store, file };
}

test('a relocated same-file ancestry contributes once and a new input starts current TPS', async t => {
    const { store, file } = await setup(t, [root, oldInput, oldReply, oldInput, oldReply, marker, newInput]);
    const waiting = await store.getStats(ID);
    assert.equal(waiting.status, 'ok');
    assert.equal(waiting.turns, 2); assert.equal(waiting.steps, 1);
    assert.equal(waiting.totalTokens, 140); assert.equal(waiting.tps, null);

    await fs.appendFile(file, lines([newReply]));
    const continued = await store.getStats(ID);
    assert.equal(continued.status, 'ok'); assert.equal(continued.usageComplete, true);
    assert.equal(continued.turns, 2); assert.equal(continued.steps, 2);
    assert.equal(continued.inputTokens, 200); assert.equal(continued.outputTokens, 70);
    assert.equal(continued.totalTokens, 270); assert.equal(continued.tps, 5);
    assert.deepEqual(await store.getStats(ID), continued);
    await fs.appendFile(file, lines([oldInput, oldReply, marker, newReply]));
    assert.deepEqual(await store.getStats(ID), continued);
    assert.ok(!JSON.stringify(continued).includes('private'));
});

test('metadata children can prove copied ancestry without becoming counted prompts', async t => {
    const { store } = await setup(t, [root, oldInput, oldReply, marker, { ...newInput, isMeta: true }]);
    const stats = await store.getStats(ID);
    assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
    assert.equal(stats.totalTokens, 140); assert.equal(stats.tps, 4);
});

test('unlinked foreign records and sidechains cannot join relocated totals', async t => {
    const { store } = await setup(t, [root, oldInput, oldReply,
        assistant('unlinked', 'root', OTHER, 20, 9999),
        assistant('sidechain', 'old-reply', OLD, 25, 9999, 'side-message', { isSidechain: true }),
        marker, newInput, newReply]);
    const stats = await store.getStats(ID);
    assert.equal(stats.status, 'ok'); assert.equal(stats.steps, 2); assert.equal(stats.totalTokens, 270);
});

test('absent and wrong-session relocation markers never import foreign records', async t => {
    for (const records of [[], [{ ...marker, sessionId: OTHER }]]) {
        const { store } = await setup(t, [root, oldInput, oldReply, ...records, newInput, newReply]);
        const stats = await store.getStats(ID);
        assert.equal(stats.status, 'ok'); assert.equal(stats.turns, 1); assert.equal(stats.steps, 1);
        assert.equal(stats.totalTokens, 130); assert.equal(stats.tps, 5);
    }
});

test('missing, cyclic and conflicting linked ancestry cannot report complete or partial totals', async t => {
    const cases = [
        [oldInput, oldReply],
        [{ ...root, parentUuid: 'old-reply' }, oldInput, oldReply],
        [root, oldInput, oldReply, { ...oldReply, parentUuid: 'root' }],
        [root, oldInput, oldReply, { ...oldReply, sessionId: OTHER }],
    ];
    for (const ancestors of cases) {
        const { store } = await setup(t, [...ancestors, marker, newInput, newReply]);
        const stats = await store.getStats(ID);
        assert.equal(stats.status, 'incomplete'); assert.equal(stats.usageComplete, false);
        assert.equal(stats.totalTokens, 0); assert.equal(stats.tps, null);
    }
});

test('a canonical child cannot hide an earlier conflict for its own UUID', async t => {
    const { store } = await setup(t, [root, oldInput, oldReply,
        { ...oldReply, parentUuid: 'root' }, { ...oldReply, sessionId: ID }, marker]);
    const stats = await store.getStats(ID);
    assert.equal(stats.status, 'incomplete'); assert.equal(stats.usageComplete, false);
    assert.equal(stats.totalTokens, 0);
});

test('a later relocation marker or parent completes verified ancestry on the next poll', async t => {
    const lateMarker = await setup(t, [root, oldInput, oldReply, newInput, newReply]);
    assert.equal((await lateMarker.store.getStats(ID)).totalTokens, 130);
    await fs.appendFile(lateMarker.file, lines([marker]));
    assert.equal((await lateMarker.store.getStats(ID)).totalTokens, 270);

    const lateParent = await setup(t, [oldInput, oldReply, marker, newInput, newReply]);
    assert.equal((await lateParent.store.getStats(ID)).status, 'incomplete');
    await fs.appendFile(lateParent.file, lines([root]));
    const completed = await lateParent.store.getStats(ID);
    assert.equal(completed.status, 'ok'); assert.equal(completed.totalTokens, 270);
    assert.equal(completed.tps, 5);
    assert.deepEqual(await lateParent.store.getStats(ID), completed);
});

test('truncation and replacement discard relocation ancestry and its allowlist', async t => {
    const { store, file } = await setup(t, [root, oldInput, oldReply, marker, newInput, newReply]);
    assert.equal((await store.getStats(ID)).totalTokens, 270);
    await fs.writeFile(file, lines([oldInput, oldReply, newInput, newReply]));
    assert.equal((await store.getStats(ID)).totalTokens, 130);

    await fs.writeFile(file, lines([root, oldInput, oldReply, marker, newInput, newReply]));
    assert.equal((await store.getStats(ID)).totalTokens, 270);
    const replacement = file + '.replacement';
    await fs.writeFile(replacement, lines([oldInput, oldReply, newInput, newReply]));
    await fs.rename(file, file + '.old');
    await fs.rename(replacement, file);
    assert.equal((await store.getStats(ID)).totalTokens, 130);
});

test('message-bearing ancestors appended after their descendants cannot overwrite current TPS', async t => {
    for (const records of [
        [root, oldInput, marker, newInput, newReply, oldReply],
        [root, marker, newInput, newReply, oldInput, oldReply],
    ]) {
        const { store } = await setup(t, records);
        const stats = await store.getStats(ID);
        assert.equal(stats.status, 'incomplete');
        assert.equal(stats.usageComplete, false);
        assert.equal(stats.tps, null);
    }
});

test('joining verified ancestry still checks message order through intermediate metadata', async t => {
    for (const viaAttachment of [false, true]) {
        const canonicalInput = user('canonical-user', 'root', ID, 0);
        const canonicalReply = assistant('canonical-reply', 'canonical-user', ID, 10, 40);
        const foreignInput = user('foreign-user', viaAttachment ? 'bridge' : 'canonical-reply', OLD, 20);
        const bridge = { type: 'attachment', uuid: 'bridge', parentUuid: 'canonical-reply', sessionId: OLD };
        const child = user('meta-child', 'foreign-user', ID, 30, 'meta-prompt', { isMeta: true });
        const { store } = await setup(t, [root, foreignInput, canonicalInput, canonicalReply,
            ...(viaAttachment ? [bridge] : []), marker, child]);
        const stats = await store.getStats(ID);
        assert.equal(stats.status, 'incomplete');
        assert.equal(stats.usageComplete, false);
        assert.equal(stats.tps, null);
    }
});
