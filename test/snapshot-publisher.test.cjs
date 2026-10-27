'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CLI = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_666666666666666666666666';
const PUBLISHER = '77777777-7777-4777-8777-777777777777';
const OTHER_PUBLISHER = '88888888-8888-4888-8888-888888888888';
const STATS = { turns: 2, steps: 3, totalTokens: 100, inputTokens: 60, outputTokens: 40,
    cachedInputTokens: 20, cacheHit: 1 / 3, tps: 4, usageComplete: true, status: 'ok' };

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-publisher-'));
    const claudeData = path.join(root, 'desktop');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    const row = { sessionId: LOCAL, cliSessionId: CLI, cwd: workspace, bridgeSessionIds: [BRIDGE] };
    const write = value => fs.writeFile(metadata, JSON.stringify(value));
    await write(row);
    let stats = { ...STATS, private: 'do not export', threadId: CLI };
    let clock = 100000;
    const publisherOptions = typeof options === 'function' ? await options({ root, claudeData, workspace }) : options;
    const store = publisherOptions.store || { async getStats(id) { assert.equal(id, CLI); return stats; } };
    const publisher = createSnapshotPublisher({ claudeData, store, now: () => clock,
        pollMs: 100000, publisherId: PUBLISHER, ...publisherOptions });
    t.after(async () => { await publisher.stop(); await fs.rm(root, { recursive: true, force: true }); });
    const directory = path.join(workspace, '.claude', 'session-stats');
    const destination = path.join(directory, `${BRIDGE}.json`);
    const snapshot = async () => JSON.parse(await fs.readFile(destination, 'utf8'));
    return { root, claudeData, workspace, metadata, row, write, publisher, directory,
        destination, snapshot, setStats(value) { stats = value; }, setClock(value) { clock = value; } };
}

test('background publication writes allowlisted stats and local reads return the exact shared revision', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const snapshot = await f.snapshot();
    assert.deepEqual(snapshot.stats, STATS);
    assert.equal(snapshot.bridgeSessionId, BRIDGE);
    assert.equal(snapshot.organizationId, ORG);
    assert.equal(snapshot.publisherId, PUBLISHER);
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.generatedAt, 100000);
    assert.deepEqual(await f.publisher.readLocal(LOCAL), { ...STATS, threadId: LOCAL,
        snapshotGeneratedAt: 100000, snapshotRevision: 1, snapshotPublisherId: PUBLISHER });
    assert.equal(await f.publisher.readLocal('local_99999999-9999-4999-8999-999999999999'), null);
    const encoded = JSON.stringify(snapshot);
    for (const privateValue of [f.workspace, CLI, LOCAL, ACCOUNT, 'do not export'])
        assert.equal(encoded.includes(privateValue), false);
    assert.equal(await fs.readFile(path.join(f.directory, '.gitignore'), 'utf8'), '*\n');
    assert.equal(await fs.stat(path.join(f.workspace, '.gitignore')).then(() => true, () => false), false);
});

test('unchanged polls preserve the sample until heartbeat and changed metrics publish a new revision', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    f.setClock(109999);
    assert.equal((await f.publisher.readLocal(LOCAL)).snapshotRevision, 1);
    assert.equal((await f.snapshot()).generatedAt, 100000);
    f.setClock(110000);
    assert.equal((await f.publisher.readLocal(LOCAL)).snapshotRevision, 2);
    assert.equal((await f.snapshot()).generatedAt, 110000);
    f.setStats({ ...STATS, totalTokens: 120, outputTokens: 60, tps: 6 });
    assert.equal((await f.publisher.readLocal(LOCAL)).snapshotRevision, 3);
    assert.equal((await f.snapshot()).stats.tps, 6);
});

test('timer publishes changed data with no local tab read', async t => {
    const f = await fixture(t, { pollMs: 10 });
    await f.publisher.start();
    f.setStats({ ...STATS, turns: 5 });
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + 2000;
        const check = async () => {
            try { if ((await f.snapshot()).stats.turns === 5) return resolve(); }
            catch (error) { return reject(error); }
            if (Date.now() > deadline) return reject(new Error('background snapshot did not update'));
            setTimeout(check, 10);
        };
        check();
    });
});

async function within(promise, timeoutMs = 500) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Local snapshot read waited for background collection')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

test('fast local reads return a committed sample while background statistics collection is blocked', async t => {
    let blocked = false, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats() {
        if (blocked) { entered(); await wait; return { ...STATS, turns: 4 }; }
        return STATS;
    } } });
    await f.publisher.start();
    blocked = true;
    const poll = f.publisher.start();
    await ready;
    try {
        const local = await within(f.publisher.readLocal(LOCAL, { waitForPoll: false }));
        assert.equal(local.status, 'ok');
        assert.equal(local.turns, 2);
        assert.equal(local.snapshotRevision, 1);
        assert.equal((await f.snapshot()).revision, 1);
    } finally { release(); await poll; }
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).snapshotRevision, 2);
});

test('fast local reads fail closed before the initial publication and proven unbound reads remain null', async t => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats() { entered(); await wait; return STATS; } } });
    let poll;
    try {
        const cold = await within(f.publisher.readLocal(LOCAL, { waitForPoll: false }));
        assert.equal(cold.status, 'unavailable');
        assert.equal(cold.snapshotRevision, undefined);
        poll = f.publisher.start();
        await ready;
        assert.equal((await within(f.publisher.readLocal(LOCAL, { waitForPoll: false }))).status, 'unavailable');
    } finally { release(); await poll; }
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).snapshotRevision, 1);
    assert.equal(await f.publisher.readLocal('local_99999999-9999-4999-8999-999999999999', { waitForPoll: false }), null);
});

test('fast local reads do not treat a newly discovered pending publication as an unbound session', async t => {
    const secondLocal = 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const secondCli = '99999999-9999-4999-8999-999999999999';
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats(id) {
        if (id === secondCli) { entered(); await wait; }
        return STATS;
    } } });
    await f.publisher.start();
    await fs.writeFile(path.join(path.dirname(f.metadata), `${secondLocal}.json`), JSON.stringify({ ...f.row,
        sessionId: secondLocal, cliSessionId: secondCli, bridgeSessionIds: ['session_second'] }));
    const poll = f.publisher.start();
    await ready;
    try {
        assert.equal((await within(f.publisher.readLocal(secondLocal, { waitForPoll: false }))).status, 'unavailable');
    } finally { release(); await poll; }
});

test('default local reads still wait for fresh statistics and return the new publication', async t => {
    let blocked = false, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats() {
        if (blocked) { entered(); await wait; return { ...STATS, turns: 4 }; }
        return STATS;
    } } });
    await f.publisher.start();
    blocked = true;
    let settled = false;
    const local = f.publisher.readLocal(LOCAL).then(value => { settled = true; return value; });
    await ready;
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
    } finally { release(); }
    const result = await local;
    assert.equal(result.turns, 4);
    assert.equal(result.snapshotRevision, 2);
});

test('atomic replacement never exposes partial JSON to concurrent filesystem readers', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    let reading = true;
    let activeAttempt = null, precedingUnavailable = false;
    const errors = [];
    const reader = (async () => { while (reading) {
        const attempt = activeAttempt, wasUnavailable = precedingUnavailable;
        try {
            const snapshot = await f.snapshot();
            assert.equal(snapshot.schemaVersion, 1);
            assert.equal(snapshot.producer, 'claude-session-stats');
            assert.equal(snapshot.bridgeSessionId, BRIDGE);
            assert.equal(snapshot.organizationId, ORG);
            assert.ok(Number.isSafeInteger(snapshot.revision) && snapshot.revision > 0);
            assert.ok(Number.isSafeInteger(snapshot.stats.turns) && snapshot.stats.turns >= 2 && snapshot.stats.turns <= 14);
            assert.deepEqual(snapshot.stats, { ...STATS, turns: snapshot.stats.turns });
        } catch (error) {
            errors.push({ error, attempt, wasUnavailable });
            if (error.code !== 'ENOENT') reading = false;
        }
    } })();
    try { for (let turns = 3; turns < 15; turns++) {
        f.setStats({ ...STATS, turns });
        activeAttempt = { unavailable: false };
        const local = await f.publisher.readLocal(LOCAL);
        activeAttempt.unavailable = local.status === 'unavailable';
        precedingUnavailable = activeAttempt.unavailable;
        if (local.status === 'ok') {
            for (const [field, value] of Object.entries({ ...STATS, turns })) assert.equal(local[field], value, field);
        } else {
            assert.equal(local.status, 'unavailable');
            for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens',
                'cachedInputTokens', 'cacheHit', 'tps']) assert.equal(local[field], null, field);
            assert.equal(local.usageComplete, false);
            assert.equal(local.snapshotRevision, undefined);
        }
    } } finally { reading = false; await reader; }
    for (const { error, attempt, wasUnavailable } of errors) {
        if (error.code !== 'ENOENT' || !wasUnavailable && !attempt?.unavailable) throw error;
    }
    const recovered = await f.publisher.readLocal(LOCAL);
    for (const [field, value] of Object.entries({ ...STATS, turns: 14 })) assert.equal(recovered[field], value, field);
    const final = await f.snapshot();
    assert.deepEqual(final.stats, { ...STATS, turns: 14 });
    assert.equal(final.revision, recovered.snapshotRevision);
});

test('Windows rename lock exhaustion returns no metrics and recovers after the lock is released',
    { skip: process.platform !== 'win32' }, async t => {
        const f = await fixture(t);
        await f.publisher.start();
        const destination = await fs.realpath(f.destination);
        const rename = fs.rename;
        let locked = true;
        t.mock.method(fs, 'rename', async (source, target) => {
            if (locked && target === destination) {
                const error = new Error('Fixture Windows replacement lock');
                error.code = 'EPERM';
                throw error;
            }
            return rename(source, target);
        });
        f.setStats({ ...STATS, turns: 4 });
        const unavailable = await f.publisher.readLocal(LOCAL);
        assert.equal(unavailable.status, 'unavailable');
        for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens',
            'cachedInputTokens', 'cacheHit', 'tps']) assert.equal(unavailable[field], null, field);
        assert.equal(unavailable.usageComplete, false);
        assert.equal(unavailable.snapshotRevision, undefined);
        await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
        locked = false;
        const recovered = await f.publisher.readLocal(LOCAL);
        for (const [field, value] of Object.entries({ ...STATS, turns: 4 })) assert.equal(recovered[field], value, field);
        assert.deepEqual((await f.snapshot()).stats, { ...STATS, turns: 4 });
        assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.gitignore', `${BRIDGE}.json`]);
    });

test('refuses unknown destination ownership and preserves unrelated project files', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    await fs.writeFile(f.destination, '{"private":"unrelated"}');
    await fs.writeFile(path.join(f.directory, 'keep.txt'), 'keep');
    await f.publisher.start();
    const local = await f.publisher.readLocal(LOCAL);
    assert.equal(local.status, 'unavailable');
    assert.equal(local.tps, null);
    assert.equal(local.snapshotRevision, undefined);
    await f.publisher.stop();
    assert.equal(await fs.readFile(f.destination, 'utf8'), '{"private":"unrelated"}');
    assert.equal(await fs.readFile(path.join(f.directory, 'keep.txt'), 'utf8'), 'keep');
});

test('refuses directory junctions below the workspace without writing outside it', async t => {
    const f = await fixture(t);
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(f.workspace, '.claude'), 'junction');
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');
    assert.deepEqual(await fs.readdir(outside), []);
});

test('invalid statistics fail closed and remove only this publisher previous snapshot', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    f.setStats({ ...STATS, tps: Infinity });
    const local = await f.publisher.readLocal(LOCAL);
    assert.equal(local.status, 'unavailable');
    assert.equal(local.snapshotRevision, undefined);
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('metadata changes during stats collection invalidate the pending write', async t => {
    let release;
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const deferred = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats() { entered(); return deferred; } } });
    const started = f.publisher.start();
    await ready;
    await f.write({ ...f.row, cliSessionId: '99999999-9999-4999-8999-999999999999' });
    release(STATS);
    await started;
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('mapping deletion removes own snapshots and makes local identity unbound', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    await fs.rm(f.metadata);
    assert.equal(await f.publisher.readLocal(LOCAL), null);
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('stop invalidates pending writes and cleanup preserves a replacement owned by another publisher', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const replacement = { ...await f.snapshot(), publisherId: OTHER_PUBLISHER };
    await fs.writeFile(f.destination, JSON.stringify(replacement));
    await f.publisher.stop();
    assert.equal((await f.snapshot()).publisherId, OTHER_PUBLISHER);
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');

    let release;
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const deferred = new Promise(resolve => { release = resolve; });
    const pending = await fixture(t, { store: { async getStats() { entered(); return deferred; } } });
    const started = pending.publisher.start();
    await ready;
    const stopped = pending.publisher.stop();
    release(STATS);
    await Promise.all([started, stopped]);
    assert.equal(await fs.stat(pending.destination).then(() => true, () => false), false);
});

test('local reads recheck their binding after other background sessions finish collecting', async t => {
    const SECOND_CLI = '99999999-9999-4999-8999-999999999999';
    const SECOND_LOCAL = 'local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let block = false, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const deferred = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats(id) {
        if (id === SECOND_CLI && block) { entered(); await deferred; }
        return STATS;
    } } });
    await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
        sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI, bridgeSessionIds: ['session_second'] }));
    await f.publisher.start();
    block = true;
    const local = f.publisher.readLocal(LOCAL);
    await ready;
    await f.write({ ...f.row, cliSessionId: SECOND_CLI });
    release();
    const result = await local;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.snapshotRevision, undefined);
});

test('stop removes its snapshots and temporary files while retaining existing ignore rules', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    await fs.writeFile(path.join(f.directory, '.gitignore'), '# project-owned rule\n*.json\n');
    await fs.writeFile(path.join(f.directory, 'keep.txt'), 'keep');
    await f.publisher.start();
    await f.publisher.stop();
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['.gitignore', 'keep.txt']);
    assert.equal(await fs.readFile(path.join(f.directory, '.gitignore'), 'utf8'), '# project-owned rule\n*.json\n');
});

test('wrong-organization snapshots are never overwritten or removed', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const wrong = { ...await f.snapshot(), organizationId: ACCOUNT };
    await fs.writeFile(f.destination, JSON.stringify(wrong));
    const local = await f.publisher.readLocal(LOCAL);
    assert.equal(local.status, 'unavailable');
    await f.publisher.stop();
    assert.deepEqual(await f.snapshot(), wrong);
});

test('publishes only in Desktop workspace_root when worktreePath, cwd and originCwd differ', async t => {
    const f = await fixture(t);
    const original = path.join(f.root, 'original-repository');
    const active = path.join(f.root, 'active-workspace');
    await fs.mkdir(original);
    await fs.mkdir(active);
    await f.write({ ...f.row, originCwd: original, worktreePath: active });
    await f.publisher.start();
    const file = path.join(active, '.claude', 'session-stats', `${BRIDGE}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).stats, STATS);
    for (const unused of [original, f.workspace])
        assert.equal(await fs.stat(path.join(unused, '.claude')).then(() => true, () => false), false);
});

test('returning bindings preserve monotonic revisions for the lifetime of the publisher', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    f.setClock(110000);
    const before = await f.publisher.readLocal(LOCAL);
    assert.equal(before.snapshotRevision, 2);
    await fs.rm(f.metadata);
    assert.equal(await f.publisher.readLocal(LOCAL), null);
    await f.write(f.row);
    f.setClock(111000);
    const restored = await f.publisher.readLocal(LOCAL);
    assert.equal(restored.snapshotPublisherId, before.snapshotPublisherId);
    assert.ok(restored.snapshotRevision > before.snapshotRevision);
    assert.equal((await f.snapshot()).revision, restored.snapshotRevision);
});

async function pauseLocalValidation(t, f, { timeoutMs = 5000, holdMs = 5000, stage = 'before-open' } = {}) {
    const destination = await fs.realpath(f.destination);
    let entered, releaseWait, timer, armHold, reads = 0, paused = false, released = false;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { releaseWait = resolve; });
    const release = () => { released = true; clearTimeout(timer); releaseWait(); };
    const deadline = new Promise((_, reject) => {
        const expire = reason => {
            release();
            reject(new Error(reason));
        };
        timer = setTimeout(() => expire('Timed out waiting for snapshot validation'), timeoutMs);
        armHold = () => {
            clearTimeout(timer);
            timer = setTimeout(() => expire('Timed out releasing snapshot validation'), holdMs);
        };
    });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        // The unchanged poll reads once; pause its caller's subsequent local validation.
        if (!released && file === destination && flags === 'r' && ++reads === 2) {
            const pause = async () => { paused = true; armHold(); entered(); await wait; };
            if (stage === 'after-close') {
                const handle = await originalOpen(file, flags, ...args);
                const close = handle.close.bind(handle);
                handle.close = async () => { await close(); await pause(); };
                return handle;
            }
            await pause();
        }
        return originalOpen(file, flags, ...args);
    });
    t.after(release);
    const read = f.publisher.readLocal(LOCAL);
    const local = Promise.race([read, deadline]);
    void local.catch(() => {});
    try {
        await Promise.race([ready, deadline, read.then(() => {
            if (!paused) throw new Error('Local read completed without pausing snapshot validation');
        })]);
    } catch (error) { release(); throw error; }
    return { local, release };
}

test('delayed validation matches the canonical snapshot through an aliased workspace path', async t => {
    const f = await fixture(t);
    const alias = path.join(f.root, 'workspace-alias');
    await fs.symlink(f.workspace, alias, 'junction');
    await f.write({ ...f.row, cwd: alias });
    f.destination = path.join(alias, '.claude', 'session-stats', `${BRIDGE}.json`);
    await f.publisher.start();
    assert.notEqual(f.destination, await fs.realpath(f.destination));
    const paused = await pauseLocalValidation(t, f);
    f.setStats({ ...STATS, turns: 4 });
    let newer;
    try { newer = await f.publisher.readLocal(LOCAL); }
    finally { paused.release(); }
    assert.equal(newer.snapshotRevision, 2);
    assert.equal((await paused.local).snapshotRevision, 2);
    assert.equal((await f.snapshot()).revision, newer.snapshotRevision);
});

test('the validation pause helper rejects a completed read that never reaches its barrier', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    await fs.rm(f.metadata);
    let timeout;
    try {
        await assert.rejects(Promise.race([pauseLocalValidation(t, f), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Validation readiness wait was unbounded')), 10000);
        })]), /Local read completed without pausing snapshot validation/);
    } finally { clearTimeout(timeout); }
});

test('the validation pause helper releases and rejects an abandoned barrier within its deadline', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { holdMs: 40 });
    let timeout;
    try {
        await assert.rejects(Promise.race([paused.local, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Validation release wait was unbounded')), 500);
        })]), /Timed out releasing snapshot validation/);
    } finally { clearTimeout(timeout); paused.release(); }
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
});

test('a delayed older local validation cannot clear or delete a newer shared publication', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f);
    f.setStats({ ...STATS, turns: 4 });
    f.setClock(101000);
    let newer;
    try { newer = await f.publisher.readLocal(LOCAL); }
    finally { paused.release(); }
    assert.equal(newer.snapshotRevision, 2);
    assert.equal((await paused.local).snapshotRevision, 2);
    assert.equal((await f.snapshot()).revision, newer.snapshotRevision);
    const current = await f.publisher.readLocal(LOCAL);
    assert.equal(current.snapshotRevision, newer.snapshotRevision);
    assert.equal(current.turns, 4);
});

test('an unchanged heartbeat crossing before a local file open reselects the committed publication', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f);
    f.setClock(110000);
    let newer;
    try { newer = await f.publisher.readLocal(LOCAL); }
    finally { paused.release(); }
    assert.equal(newer.snapshotRevision, 2);
    const local = await paused.local;
    assert.equal(local.status, 'ok');
    assert.equal(local.snapshotRevision, 2);
    assert.equal(local.turns, 2);
});

test('an unchanged heartbeat crossing after a local file read preserves its validated successful sample', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close' });
    f.setClock(110000);
    let newer;
    try { newer = await f.publisher.readLocal(LOCAL); }
    finally { paused.release(); }
    assert.equal(newer.snapshotRevision, 2);
    const local = await paused.local;
    assert.equal(local.status, 'ok');
    assert.equal(local.snapshotRevision, 1);
    assert.equal(local.turns, 2);
    assert.equal((await f.snapshot()).revision, 2);
});

async function exposePendingPublication(t, f) {
    const destination = await fs.realpath(f.destination);
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const rename = fs.rename;
    let paused = false;
    t.mock.method(fs, 'rename', async (source, target) => {
        const result = await rename(source, target);
        if (!paused && target === destination) { paused = true; entered(); await wait; }
        return result;
    });
    t.after(release);
    f.setClock(110000);
    const poll = f.publisher.start();
    await within(ready);
    return { poll, release };
}

test('a visible pending heartbeat waits for its own successful commit before returning local statistics', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const pending = await exposePendingPublication(t, f);
    const local = f.publisher.readLocal(LOCAL, { waitForPoll: false });
    try {
        assert.equal((await f.snapshot()).revision, 2);
        assert.equal(await Promise.race([local.then(() => 'settled'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 100))]), 'pending');
    } finally { pending.release(); await pending.poll; }
    const result = await within(local);
    assert.equal(result.status, 'ok');
    assert.equal(result.snapshotRevision, 2);
    assert.equal(result.turns, 2);
});

test('a visible pending publication cannot return statistics when its final binding check fails', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const pending = await exposePendingPublication(t, f);
    const local = f.publisher.readLocal(LOCAL, { waitForPoll: false });
    try {
        assert.equal(await Promise.race([local.then(() => 'settled'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 100))]), 'pending');
        await f.write({ ...f.row, cliSessionId: '99999999-9999-4999-8999-999999999999' });
    } finally { pending.release(); await pending.poll; }
    const result = await within(local);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.snapshotRevision, undefined);
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('a newer non-ok publication invalidates an older successful local sample', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close' });
    f.setStats({ ...STATS, status: 'incomplete', usageComplete: false });
    try { assert.equal((await f.publisher.readLocal(LOCAL)).status, 'incomplete'); }
    finally { paused.release(); }
    const local = await paused.local;
    assert.equal(local.status, 'unavailable');
    assert.equal(local.snapshotRevision, undefined);
    assert.equal((await f.snapshot()).stats.status, 'incomplete');
});

test('an invalidated publication cannot be resurrected by an older completed local file read', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close' });
    f.setStats({ ...STATS, tps: Infinity });
    try { assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable'); }
    finally { paused.release(); }
    assert.equal((await paused.local).status, 'unavailable');
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('local validation rejects foreign replacements and same-publisher payload tampering', async t => {
    for (const tamper of ['publisher', 'stats', 'revision']) {
        await t.test(tamper, async t => {
            const f = await fixture(t);
            await f.publisher.start();
            const paused = await pauseLocalValidation(t, f);
            const replacement = await f.snapshot();
            if (tamper === 'publisher') replacement.publisherId = OTHER_PUBLISHER;
            if (tamper === 'stats') replacement.stats.turns = 999;
            if (tamper === 'revision') replacement.revision = 999;
            try { await fs.writeFile(f.destination, JSON.stringify(replacement)); }
            finally { paused.release(); }
            const local = await paused.local;
            assert.equal(local.status, 'unavailable');
            assert.equal(local.snapshotRevision, undefined);
            assert.deepEqual(await f.snapshot(), replacement);
        });
    }
});

test('local validation rechecks freshness after its file read completes', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close' });
    f.setClock(130001);
    paused.release();
    const local = await paused.local;
    assert.equal(local.status, 'unavailable');
    assert.equal(local.snapshotRevision, undefined);
});

test('stop invalidates a delayed local validation without recreating its removed snapshot', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f);
    await f.publisher.stop();
    paused.release();
    assert.equal((await paused.local).status, 'unavailable');
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('identity changes invalidate delayed local validation before it can return an old revision', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f);
    await f.write({ ...f.row, cliSessionId: '99999999-9999-4999-8999-999999999999' });
    paused.release();
    const result = await paused.local;
    assert.equal(result.status, 'unavailable');
    assert.equal(result.snapshotRevision, undefined);
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');
    assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
});

test('installation roots and overlapping managed snapshot directories are excluded before any generated write', async t => {
    for (const location of ['workspace', 'ancestor', 'managed-parent', 'managed-child', 'installation-junction']) {
        await t.test(location, async t => {
            const f = await fixture(t, async ({ root, workspace }) => {
                let installationRoot = workspace;
                if (location === 'ancestor') installationRoot = root;
                if (location === 'managed-parent') installationRoot = path.join(workspace, '.claude');
                if (location === 'managed-child') installationRoot = path.join(workspace, '.claude', 'session-stats', 'installed');
                if (location === 'installation-junction') {
                    installationRoot = path.join(root, 'installed-link');
                    await fs.symlink(workspace, installationRoot, 'junction');
                } else await fs.mkdir(installationRoot, { recursive: true });
                return { installationRoot };
            });
            await f.publisher.start();
            const result = await f.publisher.readLocal(LOCAL);
            assert.equal(result.status, 'unavailable');
            assert.equal(result.snapshotRevision, undefined);
            assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
            assert.equal(await fs.stat(path.join(f.directory, '.gitignore')).then(() => true, () => false), false);
        });
    }
});

test('watched tweak roots and their immediate installed junction targets cannot trigger snapshot reload loops', async t => {
    for (const kind of ['watch-root', 'installed-target', 'nested-target', 'environment-root']) {
        await t.test(kind, async t => {
            const f = await fixture(t, async ({ root, workspace }) => {
                const userRoot = path.join(root, 'user-root');
                const watchedTweaksRoot = kind === 'watch-root' ? workspace : path.join(userRoot, 'tweaks');
                await fs.mkdir(watchedTweaksRoot, { recursive: true });
                if (kind !== 'watch-root') await fs.symlink(workspace, path.join(watchedTweaksRoot, 'installed'), 'junction');
                if (kind === 'environment-root') {
                    const old = process.env.CLAUDE_PLUSPLUS_USER_ROOT;
                    process.env.CLAUDE_PLUSPLUS_USER_ROOT = userRoot;
                    t.after(() => { if (old === undefined) delete process.env.CLAUDE_PLUSPLUS_USER_ROOT;
                        else process.env.CLAUDE_PLUSPLUS_USER_ROOT = old; });
                    return {};
                }
                return { watchedTweaksRoot };
            });
            let destination = f.destination;
            if (kind === 'nested-target') {
                const nested = path.join(f.workspace, 'nested');
                await fs.mkdir(nested);
                await f.write({ ...f.row, cwd: nested });
                destination = path.join(nested, '.claude', 'session-stats', `${BRIDGE}.json`);
            }
            await f.publisher.start();
            const result = await f.publisher.readLocal(LOCAL);
            assert.equal(result.status, 'unavailable');
            assert.equal(result.snapshotRevision, undefined);
            assert.equal(await fs.stat(destination).then(() => true, () => false), false);
        });
    }
});

test('a sibling project sharing a path prefix with an installation remains publishable', async t => {
    const f = await fixture(t, async ({ root, workspace }) => {
        const installationRoot = `${workspace}-installed`;
        const watchedTweaksRoot = path.join(root, 'tweaks');
        await fs.mkdir(installationRoot);
        await fs.mkdir(watchedTweaksRoot);
        return { installationRoot, watchedTweaksRoot };
    });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
});
test('workspace migration publishes fresh metrics without reading or copying the old workspace snapshot', async t => {
    let currentRoot, rootKey = 'launch';
    const f = await fixture(t, async ({ root, workspace }) => {
        currentRoot = workspace;
        return { resolveWorkspace: async () => ({
            workspaceRoot: await fs.realpath(currentRoot), evidenceKey: rootKey, verify: async () => true }) };
    });
    await f.publisher.start();
    const initial = await f.snapshot();
    const worktree = path.join(f.root, 'worktree');
    await fs.mkdir(worktree);
    currentRoot = worktree; rootKey = 'worktree';
    f.setStats({ ...STATS, turns: 4, tps: 8 });
    const originalOpen = fs.open.bind(fs);
    const spy = t.mock.method(fs, 'open', async (file, ...args) => {
        if (path.resolve(file) === path.resolve(f.destination)) throw new Error('Old workspace must not be read');
        return originalOpen(file, ...args);
    });
    const local = await f.publisher.readLocal(LOCAL);
    assert.equal(local.status, 'ok');
    assert.equal(local.tps, 8);
    const migrated = JSON.parse(await fs.readFile(path.join(worktree, '.claude', 'session-stats', BRIDGE + '.json'), 'utf8'));
    assert.equal(migrated.stats.turns, 4);
    assert.equal(migrated.stats.tps, 8);
    assert.ok(migrated.revision > initial.revision);
    spy.mock.restore();
    assert.deepEqual(await f.snapshot(), initial);
});
