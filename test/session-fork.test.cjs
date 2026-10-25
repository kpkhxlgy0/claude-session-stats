'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');

const SOURCE = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const NESTED = '33333333-3333-4333-8333-333333333333';
const timestamp = seconds => new Date(Date.UTC(2026, 9, 25) + seconds * 1000).toISOString();
function user(sessionId, uuid, parentUuid, seconds, promptId = uuid) {
    return { type: 'user', sessionId, uuid, parentUuid, promptId, timestamp: timestamp(seconds),
        message: { role: 'user', content: 'private input' } };
}
function reply(sessionId, uuid, parentUuid, seconds, output = 1000, messageId = uuid) {
    return { type: 'assistant', sessionId, uuid, parentUuid, requestId: `request-${messageId}`,
        timestamp: timestamp(seconds), message: { id: messageId, role: 'assistant', model: 'test',
            content: [{ type: 'text', text: 'private response' }], usage: { input_tokens: 10,
                cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: output } } };
}
const original = [user(SOURCE, 'u1', null, 0), reply(SOURCE, 'a1', 'u1', 5)];
function fork(rows, sessionId, at = 3600) {
    const uuids = new Map(rows.map(row => [row.uuid, `${sessionId.slice(0, 2)}-${row.uuid}`]));
    return rows.map((row, i) => ({ ...row, sessionId, uuid: uuids.get(row.uuid),
        parentUuid: row.parentUuid === null ? null : uuids.get(row.parentUuid),
        forkedFrom: { sessionId: row.sessionId, messageUuid: row.uuid },
        timestamp: i === rows.length - 1 ? timestamp(at) : row.timestamp }));
}
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
async function setup(t, childRows = fork(original, CHILD), sourceRows = original, resolveFork) {
    const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-fork-'));
    const directory = path.join(claudeHome, 'projects', 'project');
    await fs.mkdir(directory, { recursive: true });
    const write = async (id, rows, project = directory) => {
        await fs.mkdir(project, { recursive: true });
        const file = path.join(project, `${id}.jsonl`);
        await fs.writeFile(file, typeof rows === 'string' ? rows : lines(rows));
        return file;
    };
    const childFile = await write(CHILD, childRows);
    const sourceFile = sourceRows === null ? null : await write(SOURCE, sourceRows);
    const store = createSessionStore({ claudeHome, resolveFork });
    t.after(async () => { store.dispose(); await fs.rm(claudeHome, { recursive: true }); });
    return { claudeHome, store, write, childFile, sourceFile };
}

test('native rewritten fork timestamps restore inherited TPS while retaining existing counters', async t => {
    const { store, childFile, sourceFile } = await setup(t);
    const inherited = await store.getStats(CHILD);
    assert.equal(inherited.status, 'ok'); assert.equal(inherited.tps, 200);
    assert.equal(inherited.turns, 1); assert.equal(inherited.steps, 1);
    assert.equal(inherited.totalTokens, 1100);
    await fs.appendFile(sourceFile, lines([user(SOURCE, 'late-u', 'a1', 4000),
        reply(SOURCE, 'late-a', 'late-u', 4001, 999999)]));
    assert.deepEqual(await store.getStats(CHILD), inherited);
    await fs.appendFile(childFile, lines([user(CHILD, 'u2', '22-a1', 3610),
        reply(CHILD, 'a2', 'u2', 3630)]));
    const continued = await store.getStats(CHILD);
    assert.equal(continued.status, 'ok'); assert.equal(continued.tps, 80);
    assert.equal(continued.turns, 2); assert.equal(continued.steps, 2);
    assert.equal(continued.totalTokens, 2200);
    assert.deepEqual(await store.getStats(CHILD), continued);
    const restarted = createSessionStore({ claudeHome: path.dirname(path.dirname(path.dirname(childFile))) });
    t.after(() => restarted.dispose());
    assert.deepEqual(await restarted.getStats(CHILD), continued);
});

test('nested forks follow each declared row to its original timing and deduplicate replay', async t => {
    const copied = fork(original, CHILD);
    const { store, write } = await setup(t, copied.concat(copied));
    const nested = fork(copied, NESTED, 7200);
    const file = await write(NESTED, nested.concat(nested));
    assert.equal((await store.getStats(NESTED)).tps, 200);
    await fs.appendFile(file, lines([user(NESTED, 'nested-u', nested[1].uuid, 7210),
        reply(NESTED, 'nested-a', 'nested-u', 7230)]));
    assert.equal((await store.getStats(NESTED)).tps, 80);
});

test('a fork own response needs a new input instead of inheriting an ancestor input timestamp', async t => {
    const { store, childFile } = await setup(t);
    await fs.appendFile(childFile, lines([reply(CHILD, 'orphan-a', '22-a1', 3620)]));
    const stats = await store.getStats(CHILD);
    assert.equal(stats.tps, 200); assert.equal(stats.steps, 2); assert.equal(stats.totalTokens, 2200);
});

test('unverifiable fork ancestry hides all TPS samples while retaining independently known counters', async t => {
    const cases = [
        { name: 'missing source', source: null },
        { name: 'conflicting source UUID', source: original.concat({ ...original[1], timestamp: timestamp(9) }) },
        { name: 'sidechain source', source: [original[0], { ...original[1], isSidechain: true }] },
        { name: 'wrong source identity', source: original.map(row => ({ ...row, sessionId: NESTED })) },
        { name: 'changed content', change: rows => { rows[1].message = { ...rows[1].message, content: 'different' }; } },
        { name: 'changed usage', change: rows => { rows[1].message = { ...rows[1].message,
            usage: { ...rows[1].message.usage, output_tokens: 999 } }; } },
        { name: 'malformed marker', change: rows => { rows[1].forkedFrom = { sessionId: '../outside', messageUuid: 'a1' }; } },
        { name: 'unknown message', change: rows => { rows[1].forkedFrom.messageUuid = 'absent'; } },
        { name: 'broken copied branch', change: rows => { rows[1].parentUuid = null; } },
        { name: 'corrupt source', source: lines(original) + '{bad}\n' },
    ];
    for (const value of cases) {
        const copied = fork(original, CHILD); value.change?.(copied);
        const { store, childFile } = await setup(t, copied, Object.hasOwn(value, 'source') ? value.source : original);
        await fs.appendFile(childFile, lines([user(CHILD, 'own-u', '22-a1', 3610),
            reply(CHILD, 'own-a', 'own-u', 3630)]));
        const stats = await store.getStats(CHILD);
        assert.equal(stats.tps, null, value.name); assert.equal(stats.status, 'ok', value.name);
        assert.equal(stats.steps, 2, value.name); assert.equal(stats.turns, 2, value.name);
        assert.ok(stats.totalTokens > 0, value.name);
    }
});

test('fork cycles and duplicate indexed source files cannot choose an arbitrary origin', async t => {
    const cycle = original.map(row => ({ ...row,
        forkedFrom: { sessionId: CHILD, messageUuid: `22-${row.uuid}` } }));
    const cyclic = await setup(t, fork(original, CHILD), cycle);
    assert.equal((await cyclic.store.getStats(CHILD)).tps, null);
    const duplicate = await setup(t);
    await duplicate.write(SOURCE, original, path.join(duplicate.claudeHome, 'projects', 'other'));
    assert.equal((await duplicate.store.getStats(CHILD)).tps, null);
});

test('fork origin lookup never scans subagents or follows traversal in an origin marker', async t => {
    const { store, claudeHome, write } = await setup(t, fork(original, CHILD), null);
    await write(SOURCE, original, path.join(claudeHome, 'projects', 'project', 'subagents'));
    assert.equal((await store.getStats(CHILD)).tps, null);
});

test('a source rewrite invalidates cached TPS even when the child has not changed', async t => {
    const { store, sourceFile } = await setup(t);
    assert.equal((await store.getStats(CHILD)).tps, 200);
    await fs.writeFile(sourceFile, lines([original[0], { ...original[1], timestamp: timestamp(10) }]));
    assert.equal((await store.getStats(CHILD)).tps, 100);
});

test('cached TPS rechecks an ancestor metadata absence before accepting a new invalid state or fork binding', async t => {
    for (const next of [{ incomplete: true },
        { parentSessionId: NESTED, cutoffMessageUuid: null, verify: async () => true }]) {
        let metadata = null;
        const { store } = await setup(t, fork(original, CHILD), original,
            async id => id === SOURCE ? metadata : null);
        assert.equal((await store.getStats(CHILD)).tps, 200);
        metadata = next;
        const changed = await store.getStats(CHILD);
        assert.equal(changed.tps, null);
        assert.equal(changed.totalTokens, 1100);
        assert.equal(changed.status, 'ok');
    }
});

test('source metadata changing from absent before final validation cannot publish a stale TPS', async t => {
    let sourceReads = 0;
    const { store } = await setup(t, fork(original, CHILD), original,
        async id => id === SOURCE && ++sourceReads > 1 ? { incomplete: true } : null);
    const stats = await store.getStats(CHILD);
    assert.equal(stats.tps, null);
    assert.equal(stats.totalTokens, 1100);
});

test('current metadata changing after its initial resolution invalidates both fresh and cached TPS', async t => {
    for (const warm of [false, true]) {
        let metadata = null, mutate = false;
        const { store } = await setup(t, fork(original, CHILD), original, async id => {
            if (id === CHILD) return metadata;
            if (id === SOURCE && mutate) metadata = { incomplete: true };
            return null;
        });
        if (warm) assert.equal((await store.getStats(CHILD)).tps, 200);
        mutate = true;
        const stats = await store.getStats(CHILD);
        assert.equal(stats.tps, null);
        assert.equal(stats.totalTokens, 1100);
    }
});

const desktopFork = parentSessionId => ({ parentSessionId, cutoffMessageUuid: null, verify: async () => true });
test('native Desktop raw copies use metadata and copied prefix only without changing foreign-row counters', async t => {
    const { store, childFile, sourceFile } = await setup(t,
        original.concat({ type: 'custom-title', customTitle: 'fork' }), original,
        async id => id === CHILD ? desktopFork(SOURCE) : null);
    const inherited = await store.getStats(CHILD);
    assert.equal(inherited.status, 'ok'); assert.equal(inherited.tps, 200);
    assert.equal(inherited.turns, 0); assert.equal(inherited.steps, null);
    await fs.appendFile(sourceFile, lines([user(SOURCE, 'late-u', 'a1', 4000),
        reply(SOURCE, 'late-a', 'late-u', 4001, 999999)]));
    assert.deepEqual(await store.getStats(CHILD), inherited);
    await fs.appendFile(childFile, lines([user(CHILD, 'u2', 'a1', 3610), reply(CHILD, 'a2', 'u2', 3630)]));
    const continued = await store.getStats(CHILD);
    assert.equal(continued.tps, 80); assert.equal(continued.totalTokens, 1100);
    assert.equal(continued.turns, 1); assert.equal(continued.steps, 1);
});

test('nested Desktop metadata forks resolve raw copied rows through each verified parent', async t => {
    const resolveFork = async id => id === CHILD ? desktopFork(SOURCE) : id === NESTED ? desktopFork(CHILD) : null;
    const { store, write } = await setup(t, original, original, resolveFork);
    await write(NESTED, original);
    assert.equal((await store.getStats(NESTED)).tps, 200);
});

test('nested fork boundaries cannot lend a grandparent input to a parent own orphan response', async t => {
    const resolveFork = async id => id === CHILD ? desktopFork(SOURCE) : id === NESTED ? desktopFork(CHILD) : null;
    const child = original.concat(reply(CHILD, 'orphan', 'a1', 4000));
    const { store, write } = await setup(t, child, original, resolveFork);
    await write(NESTED, child);
    assert.equal((await store.getStats(NESTED)).tps, 200);
});

test('Desktop cutoff excludes its matching row and metadata failures never expose a partial TPS', async t => {
    for (const [descriptor, copied, expected] of [
        [{ ...desktopFork(SOURCE), cutoffMessageUuid: 'a1' }, original.slice(0, 1), null],
        [{ ...desktopFork(SOURCE), cutoffMessageUuid: 'absent' }, original, null],
        [{ ...desktopFork(SOURCE), verify: async () => false }, original, null],
        [{ incomplete: true }, original, null],
        [desktopFork(SOURCE), [original[0], { ...original[1], timestamp: timestamp(9) }], null],
        [desktopFork(SOURCE), original.slice().reverse(), null],
    ]) {
        const { store, childFile } = await setup(t, copied, original, async id => id === CHILD ? descriptor : null);
        await fs.appendFile(childFile, lines([user(CHILD, 'own-u', 'a1', 3610), reply(CHILD, 'own-a', 'own-u', 3630)]));
        const stats = await store.getStats(CHILD);
        if (descriptor.cutoffMessageUuid === 'a1') assert.equal(stats.tps, 50);
        else assert.equal(stats.tps, expected);
        assert.equal(stats.totalTokens, 1100);
    }
});

test('own replay with inherited response identities cannot extend the restored generation interval', async t => {
    const { store, childFile } = await setup(t);
    await fs.appendFile(childFile, lines([{ ...original[1], sessionId: CHILD, uuid: 'own-replay',
        parentUuid: '22-a1', timestamp: timestamp(3620) }]));
    assert.equal((await store.getStats(CHILD)).tps, 200);
});

test('current rewrites between counter reading and fork resolution are retried as a whole', async t => {
    let mutate;
    const resolveFork = async id => {
        if (id === CHILD && mutate) { const apply = mutate; mutate = null; await apply(); }
        return null;
    };
    const { store, childFile } = await setup(t, fork(original, CHILD), original, resolveFork);
    mutate = () => fs.appendFile(childFile, lines([user(CHILD, 'u2', '22-a1', 3610), reply(CHILD, 'a2', 'u2', 3630)]));
    const stats = await store.getStats(CHILD);
    assert.equal(stats.tps, 80); assert.equal(stats.totalTokens, 2200); assert.equal(stats.steps, 2);
});

test('identical source and copied Desktop replay UUIDs remain one inherited sample', async t => {
    const { store } = await setup(t, original.concat(original), original.concat(original),
        async id => id === CHILD ? desktopFork(SOURCE) : null);
    assert.equal((await store.getStats(CHILD)).tps, 200);
});

test('source mutation during a read rebuilds once and repeated mutation leaves TPS unknown', async t => {
    for (const persistent of [false, true]) {
        const { store, sourceFile } = await setup(t);
        const open = fs.open;
        let mutations = 0;
        const mocked = t.mock.method(fs, 'open', async (...args) => {
            const handle = await open(...args);
            if (args[0] === sourceFile) {
                const read = handle.read.bind(handle);
                handle.read = async (...readArgs) => {
                    const result = await read(...readArgs);
                    if (readArgs[3] === 0 && (persistent || !mutations)) {
                        mutations++;
                        await fs.appendFile(sourceFile, lines([{ type: 'custom-title', customTitle: `change-${mutations}` }]));
                    }
                    return result;
                };
            }
            return handle;
        });
        const stats = await store.getStats(CHILD);
        assert.equal(stats.tps, persistent ? null : 200);
        assert.equal(stats.totalTokens, 1100); assert.equal(stats.status, 'ok');
        mocked.mock.restore();
    }
});

test('a source line exceeding the streaming bound cannot expose a partial TPS', async t => {
    const { store, sourceFile } = await setup(t);
    await fs.appendFile(sourceFile, lines([{ type: 'attachment', data: 'x'.repeat(8 * 1024 * 1024) }]));
    const stats = await store.getStats(CHILD);
    assert.equal(stats.tps, null); assert.equal(stats.totalTokens, 1100);
});

test('a fork through relocated source ancestry retains its explicit session gate', async t => {
    const root = { type: 'attachment', sessionId: NESTED, uuid: 'root', parentUuid: null };
    const foreign = [root, user(NESTED, 'u1', 'root', 0), reply(NESTED, 'a1', 'u1', 5)];
    const source = foreign.concat({ type: 'relocated', sessionId: SOURCE },
        user(SOURCE, 'source-own-u', 'a1', 10), reply(SOURCE, 'source-own-a', 'source-own-u', 30));
    const copied = fork(source.filter(row => row.uuid), CHILD);
    // Desktop/SDK provenance names the file's session, even for its relocated records.
    for (const row of copied) row.forkedFrom.sessionId = SOURCE;
    const { store } = await setup(t, copied, source);
    assert.equal((await store.getStats(CHILD)).tps, 80);
});

test('Desktop metadata cycles do not use otherwise valid copied response durations', async t => {
    const { store } = await setup(t, original, original,
        async id => id === CHILD ? desktopFork(SOURCE) : id === SOURCE ? desktopFork(CHILD) : null);
    assert.equal((await store.getStats(CHILD)).tps, null);
});

test('Desktop copied mainline rows cannot borrow timing through a sidechain ancestor', async t => {
    const source = [original[0], { type: 'attachment', sessionId: SOURCE, uuid: 'side',
        parentUuid: 'u1', isSidechain: true }, { ...original[1], parentUuid: 'side' }];
    const { store } = await setup(t, source, source, async id => id === CHILD ? desktopFork(SOURCE) : null);
    assert.equal((await store.getStats(CHILD)).tps, null);
});

test('a Desktop cutoff can use its source_uuid alias and excludes the target response', async t => {
    const source = [original[0], { ...original[1], source_uuid: 'alias' }];
    const { store, childFile } = await setup(t, source.slice(0, 1), source,
        async id => id === CHILD ? { ...desktopFork(SOURCE), cutoffMessageUuid: 'alias' } : null);
    await fs.appendFile(childFile, lines([user(CHILD, 'own-u', 'u1', 10), reply(CHILD, 'own-a', 'own-u', 30)]));
    assert.equal((await store.getStats(CHILD)).tps, 50);
});

test('Desktop attachment cutoffs preserve both explicit aliases and exclude the attachment row', async t => {
    for (const cutoffMessageUuid of ['root-alias', 'attachment-alias']) {
        const attachment = { type: 'attachment', sessionId: SOURCE, uuid: 'attachment', parentUuid: 'u1',
            source_uuid: 'root-alias', attachment: { type: 'queued_command', source_uuid: 'attachment-alias' } };
        const source = [original[0], attachment, { ...original[1], parentUuid: 'attachment' }];
        const { store, childFile } = await setup(t, source.slice(0, 1), source,
            async id => id === CHILD ? { ...desktopFork(SOURCE), cutoffMessageUuid } : null);
        await fs.appendFile(childFile, lines([user(CHILD, 'own-u', 'u1', 10), reply(CHILD, 'own-a', 'own-u', 30)]));
        assert.equal((await store.getStats(CHILD)).tps, 50, cutoffMessageUuid);
    }
});

test('Desktop cutoff lookup does not interpret an alias inside message content as provenance', async t => {
    const source = [original[0], { ...original[1], message: { ...original[1].message,
        content: [{ type: 'text', text: 'private response', source_uuid: 'body-alias' }] } }];
    const { store, childFile } = await setup(t, source.slice(0, 1), source,
        async id => id === CHILD ? { ...desktopFork(SOURCE), cutoffMessageUuid: 'body-alias' } : null);
    await fs.appendFile(childFile, lines([user(CHILD, 'own-u', 'u1', 10), reply(CHILD, 'own-a', 'own-u', 30)]));
    assert.equal((await store.getStats(CHILD)).tps, null);
});

test('Desktop ancestry depth is bounded even when each individual copied prefix is valid', async t => {
    const ids = Array.from({ length: 34 }, (_, index) =>
        `${(index + 1).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    const parents = new Map([[CHILD, ids[0]], ...ids.slice(0, -1).map((id, i) => [id, ids[i + 1]])]);
    const source = original.map(row => ({ ...row, sessionId: ids.at(-1) }));
    const { store, write } = await setup(t, source, null,
        async id => parents.has(id) ? desktopFork(parents.get(id)) : null);
    for (const id of ids) await write(id, source);
    const stats = await store.getStats(CHILD);
    assert.equal(stats.tps, null); assert.equal(stats.status, 'ok');
});
