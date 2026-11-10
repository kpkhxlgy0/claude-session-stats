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
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-publisher-')));
    const claudeData = path.join(root, 'desktop');
    const workspace = path.join(root, 'workspace');
    const claudeHome = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(claudeHome);
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    const row = { sessionId: LOCAL, cliSessionId: CLI, cwd: workspace, bridgeSessionIds: [BRIDGE] };
    const write = value => fs.writeFile(metadata, JSON.stringify(value));
    await write(row);
    let stats = { ...STATS, private: 'do not export', threadId: CLI };
    let clock = 100000;
    const publisherOptions = typeof options === 'function' ? await options({ root, claudeData, workspace, claudeHome }) : options;
    const store = publisherOptions.store || { async getStats(id) { assert.equal(id, CLI); return stats; } };
    const publisher = createSnapshotPublisher({ claudeData, claudeHome, store, now: () => clock,
        pollMs: 100000, publisherId: PUBLISHER, ...publisherOptions });
    t.after(async () => { await publisher.stop(); await fs.rm(root, { recursive: true, force: true }); });
    const directory = path.join(publisherOptions.claudeHome ?? claudeHome, '.session-stats');
    const destination = path.join(directory, `${BRIDGE}.json`);
    const snapshot = async () => JSON.parse(await fs.readFile(destination, 'utf8'));
    return { root, claudeData, workspace, claudeHome, metadata, row, write, publisher, directory,
        destination, snapshot, setStats(value) { stats = value; }, setClock(value) { clock = value; } };
}

test('configured Claude directory owns publication while legacy user snapshots stay untouched', async t => {
    const f = await fixture(t, async ({ root }) => {
        const claudeHome = path.join(root, 'custom-config');
        await fs.mkdir(claudeHome);
        return { claudeHome };
    });
    const legacyDirectory = path.join(f.root, 'legacy-home', '.claude-plusplus', 'session-stats');
    const legacyDestination = path.join(legacyDirectory, `${BRIDGE}.json`);
    await fs.mkdir(legacyDirectory, { recursive: true });
    const legacy = Buffer.from('legacy snapshot left untouched');
    await fs.writeFile(legacyDestination, legacy);
    const destination = path.join(f.root, 'custom-config', '.session-stats', `${BRIDGE}.json`);
    await f.publisher.start();
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')).stats, STATS);
    assert.equal((await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG })).directory,
        path.dirname(destination));
    await f.publisher.stop();
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(legacyDestination), legacy);
});

for (const location of ['workspace', 'workspace-child'])
test(`explicit Claude configuration at ${location} remains publishable`, async t => {
    let claudeHome;
    const f = await fixture(t, async ({ workspace }) => {
        claudeHome = location === 'workspace' ? workspace : path.join(workspace, '.custom-claude');
        await fs.mkdir(claudeHome, { recursive: true });
        return { claudeHome };
    });
    await f.publisher.start();
    const destination = path.join(claudeHome, '.session-stats', `${BRIDGE}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')).stats, STATS);
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
});

test('snapshot publisher rejects relative Claude configuration directories', () => {
    assert.throws(() => createSnapshotPublisher({ claudeHome: 'relative-config' }));
});

test('local access exports only the published fixed directory and rechecks the session before a grant', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const expected = { localSessionId: LOCAL, cliSessionId: CLI, bridgeSessionId: BRIDGE,
        organizationId: ORG, accountId: ACCOUNT, directory: f.directory };
    assert.deepEqual(f.publisher.listLocalSnapshotAccess(), [expected]);
    assert.equal(await f.publisher.verifyLocalSnapshotAccess(expected), true);
    assert.equal(await f.publisher.verifyLocalSnapshotAccess({ ...expected, directory: f.claudeHome }), false);
    assert.equal(await f.publisher.verifyLocalSnapshotAccess({ ...expected, cliSessionId: ACCOUNT }), false);
    await f.write({ ...f.row, cliSessionId: ACCOUNT });
    assert.equal(await f.publisher.verifyLocalSnapshotAccess(expected), false);
    await f.publisher.stop();
    assert.deepEqual(f.publisher.listLocalSnapshotAccess(), []);
});

test('unpublished and disabled RC sessions do not request snapshot directory access', async t => {
    const f = await fixture(t);
    assert.deepEqual(f.publisher.listLocalSnapshotAccess(), []);
    await f.write({ ...f.row, remoteControlUserEnabled: false });
    await f.publisher.start();
    assert.deepEqual(f.publisher.listLocalSnapshotAccess(), []);
});

test('snapshot access rejects a directory replaced by a junction after publication', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const [candidate] = f.publisher.listLocalSnapshotAccess();
    await fs.rename(f.directory, `${f.directory}-original`);
    await fs.symlink(f.workspace, f.directory, 'junction');
    assert.equal(await f.publisher.verifyLocalSnapshotAccess(candidate), false);
});

test('snapshot access rejects a newly ambiguous local identity before the next publisher poll', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const [candidate] = f.publisher.listLocalSnapshotAccess();
    const duplicate = path.join(f.claudeData, 'claude-code-sessions', PUBLISHER, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(duplicate), { recursive: true });
    await fs.writeFile(duplicate, JSON.stringify(f.row));
    assert.equal(await f.publisher.verifyLocalSnapshotAccess(candidate), false);
});

test('publisher defaults to CLAUDE_CONFIG_DIR when the caller has not supplied a resolved root', async t => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    t.after(() => {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
    });
    let claudeHome;
    const f = await fixture(t, async ({ root }) => {
        claudeHome = path.join(root, 'environment-config');
        await fs.mkdir(claudeHome);
        process.env.CLAUDE_CONFIG_DIR = claudeHome;
        return { claudeHome: undefined };
    });
    await f.publisher.start();
    const destination = path.join(claudeHome, '.session-stats', `${BRIDGE}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')).stats, STATS);
    assert.equal((await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG })).directory,
        path.dirname(destination));
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('an unset CLAUDE_CONFIG_DIR publishes inside the default home Claude hidden snapshot directory', async t => {
    const names = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    t.after(() => {
        for (const [name, value] of previous) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
    const f = await fixture(t, async ({ root }) => {
        const userHome = path.join(root, 'default-home');
        await fs.mkdir(path.join(userHome, '.claude'), { recursive: true });
        process.env.HOME = userHome;
        process.env.USERPROFILE = userHome;
        delete process.env.CLAUDE_CONFIG_DIR;
        return { claudeHome: undefined };
    });
    await f.publisher.start();
    const destination = path.join(f.root, 'default-home', '.claude', '.session-stats', `${BRIDGE}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')).stats, STATS);
    assert.equal((await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG })).directory,
        path.dirname(destination));
    await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('remote snapshot reads reuse the committed local sample without recomputing or exposing mutable cache', async t => {
    let samples = 0;
    const f = await fixture(t, { store: { async getStats() { samples++; return STATS; } } });
    await f.publisher.start();
    const local = await f.publisher.readLocal(LOCAL);
    const published = await f.snapshot(), before = samples;
    const remote = await f.publisher.readRemoteSnapshot(BRIDGE.replace('session_', 'cse_'), { organizationId: ORG });
    assert.deepEqual(remote, published);
    assert.equal(remote.revision, local.snapshotRevision);
    assert.equal(remote.stats.totalTokens, local.totalTokens);
    remote.stats.totalTokens = 999;
    assert.deepEqual(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }), published);
    assert.equal(samples, before);
});

test('remote snapshots require an exact supported bridge organization and agent selection', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    for (const [bridge, options] of [[BRIDGE, {}], [BRIDGE, { organizationId: ACCOUNT }],
        [LOCAL, { organizationId: ORG }], ['../snapshot', { organizationId: ORG }],
        ['session_unknown', { organizationId: ORG }], [BRIDGE, { organizationId: ORG, agentId: '../a' }],
        [BRIDGE, { organizationId: ORG, agentId: 'missing' }]])
        assert.equal(await f.publisher.readRemoteSnapshot(bridge, options), null);
});

test('remote snapshots reject a newly ambiguous bridge before the next publication poll', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
        sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI }));
    assert.equal(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }), null);
});

test('metadata source advertises only the real directory regardless of child count', async t => {
    let samples = 0, lists = 0;
    const f = await fixture(t, { store: {
        async getStats() { samples++; return STATS; },
        async listAgents() { lists++; return Array.from({ length: 65 }, (_, i) => `child_${i}`); },
        async getAgentStats(id, agentId) { samples++; return { ...STATS, threadId: id, agentId }; },
    } });
    assert.deepEqual(f.publisher.listRemoteBindings(), []);
    await f.publisher.start();
    assert.deepEqual(f.publisher.listRemoteBindings(), [{ bridgeSessionId: BRIDGE,
        organizationId: ORG, accountId: ACCOUNT }]);
    const before = { samples, lists }, published = await f.snapshot();
    const location = await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG });
    assert.deepEqual(location, { bridgeSessionId: BRIDGE, organizationId: ORG, publisherId: PUBLISHER,
        generatedAt: published.generatedAt, directory: f.directory });
    assert.deepEqual({ samples, lists }, before, 'directory lookup does not enumerate or recalculate children');
    assert.equal(f.publisher.readRemoteSnapshots, undefined, 'bulk exporter is removed');
    location.directory = 'changed';
    assert.equal((await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG })).directory, f.directory);
    await f.publisher.stop();
    assert.deepEqual(f.publisher.listRemoteBindings(), []);
    assert.equal(await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG }), null);
});

test('metadata directory requires a fresh exact binding and honors cancellation', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    assert.equal(await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ACCOUNT }), null);
    assert.equal(await f.publisher.readRemoteLocation('../foreign', { organizationId: ORG }), null);
    const controller = new AbortController(); controller.abort();
    assert.equal(await f.publisher.readRemoteLocation(BRIDGE,
        { organizationId: ORG, signal: controller.signal }), null);
    f.setClock(131000);
    assert.equal(await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG }), null);
});

test('metadata directory lookup cancellation releases validation without altering the local sample', async t => {
    const f = await fixture(t), controller = new AbortController();
    await f.publisher.start();
    const published = await f.snapshot();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close', readSnapshot: () =>
        f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG, signal: controller.signal }) });
    controller.abort();
    try { assert.equal(await within(paused.local), null); }
    finally { paused.release(); }
    assert.equal((await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG })).directory, f.directory);
    assert.deepEqual(await f.snapshot(), published);
});

test('metadata directory rejects identity changes during source verification', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close', readSnapshot: () =>
        f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG }) });
    try { await f.write({ ...f.row, cliSessionId: SECOND_CLI }); }
    finally { paused.release(); }
    assert.equal(await paused.local, null);
});

for (const change of ['ambiguous', 'disabled', 'publisher'])
test(`metadata directory rejects ${change} ownership changes before the next poll`, async t => {
    const f = await fixture(t);
    await f.publisher.start();
    if (change === 'ambiguous') {
        await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
            sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI }));
    } else if (change === 'disabled') await f.write({ ...f.row, remoteControlUserEnabled: false });
    else await fs.writeFile(f.destination, JSON.stringify({ ...await f.snapshot(), publisherId: OTHER_PUBLISHER }));
    assert.equal(await f.publisher.readRemoteLocation(BRIDGE, { organizationId: ORG }), null);
});

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
    assert.equal(await fs.stat(path.join(f.directory, '.gitignore')).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(f.workspace, '.claude')).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(f.workspace, '.gitignore')).then(() => true, () => false), false);
});

test('device I/O failure exposes only a verified, fresh local sample until publication recovers', async t => {
    const f = await fixture(t);
    let failure = true;
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (from, to) => {
        if (failure && to === f.destination) throw Object.assign(new Error('Device unavailable'), { code: 'EIO' });
        return rename(from, to);
    });
    const local = await f.publisher.readLocal(LOCAL);
    assert.deepEqual(local, { ...STATS, threadId: LOCAL, snapshotSync: 'local-only' });
    await assert.rejects(f.snapshot(), { code: 'ENOENT' });
    await f.publisher.readLocal(LOCAL, { waitForPoll: false }); // Register selection before the clock jumps.
    await f.publisher.start();
    f.setClock(131000);
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
    failure = false;
    const shared = await f.publisher.readLocal(LOCAL);
    const disk = await f.snapshot();
    assert.equal(shared.snapshotRevision, disk.revision);
    assert.deepEqual(disk.stats, STATS);
    assert.equal(shared.snapshotSync, undefined);
});

test('a local-only sample cannot survive loss of its Desktop binding', async t => {
    const f = await fixture(t);
    const rename = fs.rename;
    t.mock.method(fs, 'rename', (from, to) => to === f.destination
        ? Promise.reject(Object.assign(new Error('Read-only volume'), { code: 'EROFS' })) : rename(from, to));
    assert.equal((await f.publisher.readLocal(LOCAL)).snapshotSync, 'local-only');
    await f.write({ ...f.row, cliSessionId: OTHER_PUBLISHER });
    assert.notEqual((await f.publisher.readLocal(LOCAL, { waitForPoll: false }))?.status, 'ok');
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

test('a sample delayed by identity confirmation keeps its original collection time', async t => {
    let time = 100000, sampled = false;
    const f = await fixture(t, { now: () => time,
        resolveWorkspace: async () => { if (sampled) time = 200000; return null; },
        store: { async getStats() { sampled = true; return STATS; } } });
    await f.publisher.start();
    assert.equal((await f.snapshot()).generatedAt, 100000);
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
    await f.publisher.start();
    assert.equal((await f.snapshot()).generatedAt, 200000);
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'ok');
});

test('same-parent checks wait for the next fresh cohort instead of joining a proof already in progress', async t => {
    let f, probing = false, blockRead = false, enteredRead, releaseRead;
    const readReady = new Promise(resolve => { enteredRead = resolve; });
    const blockedRead = new Promise(resolve => { releaseRead = resolve; });
    const gates = [], events = [];
    f = await fixture(t, { resolveWorkspace: async () => {
        if (probing) {
            const number = gates.length + 1;
            events.push(`proof-${number}`);
            await new Promise(resolve => { gates.push(resolve); });
        }
        return { workspaceRoot: f.workspace, evidenceKey: 'stable-proof', verify: async () => true };
    } });
    await f.publisher.start();
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    await f.publisher.start();
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file !== f.destination) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
            const result = await handle.read(...readArgs);
            if (blockRead) {
                blockRead = false; enteredRead(); await blockedRead;
                events.push('snapshot-read-complete');
            }
            return result;
        } };
    });
    const untilGate = async count => {
        const deadline = Date.now() + 500;
        while (gates.length < count) {
            if (Date.now() >= deadline) throw new Error('Expected a new fresh identity proof');
            await new Promise(resolve => setTimeout(resolve, 2));
        }
    };
    probing = true; blockRead = true;
    const first = f.publisher.readLocal(LOCAL, { waitForPoll: false });
    let second, third;
    try {
        await untilGate(1);
        second = f.publisher.readLocal(LOCAL, { waitForPoll: false });
        third = f.publisher.readLocal(LOCAL, { waitForPoll: false });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(gates.length, 1);
        gates[0]();
        await within(readReady);
        await untilGate(2);
        releaseRead();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(gates.length, 2);
        gates[1]();
        await untilGate(3);
        assert.ok(events.indexOf('proof-2') < events.indexOf('snapshot-read-complete'));
        assert.ok(events.indexOf('proof-3') > events.indexOf('snapshot-read-complete'));
    } finally {
        probing = false; releaseRead();
        for (const release of gates) release();
    }
    for (const sample of await Promise.all([first, second, third])) assert.equal(sample.status, 'ok');
});

test('an unchanged sample before heartbeat performs no snapshot I/O or redundant publication proof', async t => {
    let time = 100000, sampled = false, confirmation = false, redundantProofs = 0;
    const f = await fixture(t, { now: () => time, resolveWorkspace: async () => {
        if (sampled) { if (confirmation) redundantProofs++; else confirmation = true; }
        return null;
    }, store: { async getStats() { sampled = true; return STATS; } } });
    await f.publisher.start();
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    await f.publisher.start();
    const first = await f.snapshot();
    sampled = false; confirmation = false; redundantProofs = 0;
    let snapshotOpens = 0;
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
        if (file === f.destination) snapshotOpens++;
        return originalOpen(file, ...args);
    });
    await f.publisher.start();
    assert.equal(snapshotOpens, 0);
    assert.equal(redundantProofs, 0);
    assert.deepEqual(await f.snapshot(), first);
    const beforeRead = snapshotOpens;
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'ok');
    assert.ok(snapshotOpens > beforeRead);
    const beforeHeartbeat = snapshotOpens;
    time += 10000;
    await f.publisher.start();
    assert.ok(snapshotOpens > beforeHeartbeat);
    assert.equal((await f.snapshot()).generatedAt, time);
});

test('global discovery cohorts never reuse a scan begun before their caller or sampled data', async t => {
    let probing = false, releaseSample;
    const blockedSample = new Promise(resolve => { releaseSample = resolve; });
    const events = [], gates = [];
    const f = await fixture(t, { store: {
        async getStats() {
            if (probing) { await blockedSample; events.push('sample-complete'); }
            return STATS;
        },
        async listAgents() { return []; }, async getAgentStats() { return STATS; },
    } });
    await f.publisher.start();
    const sessionsRoot = path.dirname(path.dirname(path.dirname(f.metadata)));
    const originalOpendir = fs.opendir;
    t.mock.method(fs, 'opendir', async (directory, ...args) => {
        if (directory === sessionsRoot && probing) {
            events.push(`scan-${gates.length + 1}`);
            await new Promise(resolve => { gates.push(resolve); });
        }
        return originalOpendir(directory, ...args);
    });
    const untilGate = async count => {
        const deadline = Date.now() + 500;
        while (gates.length < count) {
            if (Date.now() >= deadline) throw new Error('Expected a new global identity scan');
            await new Promise(resolve => setTimeout(resolve, 2));
        }
    };
    probing = true;
    const background = f.publisher.start();
    let selected, prioritized;
    try {
        await untilGate(1);
        selected = f.publisher.readLocal(LOCAL, { agentId: 'missing' });
        await f.publisher.readLocal(LOCAL, { waitForPoll: false });
        prioritized = f.publisher.start();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(gates.length, 1);
        gates[0]();
        await untilGate(2);
        releaseSample();
        const deadline = Date.now() + 500;
        while (!events.includes('sample-complete')) {
            if (Date.now() >= deadline) throw new Error('Parent sampling did not finish');
            await new Promise(resolve => setTimeout(resolve, 2));
        }
        assert.ok(events.indexOf('scan-2') < events.indexOf('sample-complete'));
        gates[1]();
        await untilGate(3);
        assert.ok(events.indexOf('scan-3') > events.indexOf('sample-complete'));
    } finally {
        probing = false;
        releaseSample();
        for (const release of gates) release();
        await Promise.all([background, selected, prioritized]);
    }
});

async function within(promise, timeoutMs = 500) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Local snapshot read waited for background collection')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

async function committedLocal(f) {
    const deadline = Date.now() + 1000;
    for (;;) {
        const sample = await f.publisher.readLocal(LOCAL, { waitForPoll: false });
        if (sample?.status === 'ok') return sample;
        if (Date.now() >= deadline) throw new Error('A fast parent did not publish independently');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

test('a new fast parent selection publishes without waiting for the timer', async t => {
    const f = await fixture(t);
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
    assert.equal((await committedLocal(f)).turns, 2);
    assert.equal((await f.snapshot()).stats.turns, 2);
});

const SECOND_LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const SECOND_CLI = '99999999-9999-4999-8999-999999999999';

async function addUnrelated(f) {
    await fs.writeFile(path.join(path.dirname(f.metadata), SECOND_LOCAL + '.json'), JSON.stringify({ ...f.row,
        sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI, bridgeSessionIds: ['session_unrelated'] }));
}

async function addDuplicate(f) {
    const directory = path.join(path.dirname(path.dirname(path.dirname(f.metadata))), CLI, ORG);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, LOCAL + '.json'), JSON.stringify(f.row));
}

test('switching the selected parent releases the old wait without blocking background parents', async t => {
    let entered, release, selected = false, time = 100000;
    const ready = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { now: () => time, pollMs: 5, store: { async getStats(id) {
        if (id === CLI) { entered(); await blocked; }
        return { ...STATS, turns: id === SECOND_CLI && selected ? 9 : 2 };
    } } });
    await addUnrelated(f);
    const thirdLocal = 'local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await fs.writeFile(path.join(path.dirname(f.metadata), thirdLocal + '.json'), JSON.stringify({ ...f.row,
        sessionId: thirdLocal, cliSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', bridgeSessionIds: ['session_third'] }));
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    const starting = f.publisher.start();
    try {
        await within(ready);
        const deadline = Date.now() + 500;
        const third = path.join(f.directory, 'session_third.json');
        while (!await fs.stat(third).then(() => true, () => false)) {
            if (Date.now() >= deadline) throw new Error('A selected hung parent blocked unrelated background parents');
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        selected = true; time += 10001;
        await f.publisher.readLocal(SECOND_LOCAL, { waitForPoll: false });
        const target = path.join(f.directory, 'session_unrelated.json');
        await within((async () => {
            while (JSON.parse(await fs.readFile(target, 'utf8')).stats.turns !== 9)
                await new Promise(resolve => setTimeout(resolve, 5));
        })());
    } finally { release(); await starting; }
});

test('an older queued missing-parent prune cannot remove a newer valid publication', async t => {
    let time = 100000, writing = false, absent = false, restored = false;
    let enteredWrite, releaseWrite, sawMissing, sawRestored;
    const writingReady = new Promise(resolve => { enteredWrite = resolve; });
    const blockedWrite = new Promise(resolve => { releaseWrite = resolve; });
    const missingReady = new Promise(resolve => { sawMissing = resolve; });
    const restoredReady = new Promise(resolve => { sawRestored = resolve; });
    let sample = STATS;
    const f = await fixture(t, { now: () => time, store: {
        async getStats() { return sample; },
        async listAgents() { if (restored) sawRestored(); return []; },
        async getAgentStats() { return STATS; },
    } });
    await f.publisher.start();
    const originalRename = fs.rename, originalLstat = fs.lstat;
    const sessionsRoot = path.dirname(path.dirname(path.dirname(f.metadata)));
    let missingChecks = 0;
    t.mock.method(fs, 'rename', async (source, destination) => {
        if (destination === f.destination && writing) { enteredWrite(); await blockedWrite; }
        return originalRename(source, destination);
    });
    t.mock.method(fs, 'lstat', async (file, ...args) => {
        const result = await originalLstat(file, ...args);
        if (absent && file === sessionsRoot && ++missingChecks >= 2) sawMissing();
        return result;
    });
    time += 10001; sample = { ...STATS, turns: 9 }; writing = true;
    const updating = f.publisher.start();
    let missingRead, restoring;
    try {
        await within(writingReady);
        await f.write({ ...f.row, remoteControlUserEnabled: false });
        absent = true;
        missingRead = f.publisher.readLocal(LOCAL, { agentId: 'unknown' });
        await within(missingReady);
        await new Promise(resolve => setImmediate(resolve));
        absent = false;
        await f.write(f.row);
        restored = true;
        restoring = f.publisher.start();
        await within(restoredReady);
    } finally { releaseWrite(); await Promise.all([updating, missingRead, restoring]); }
    assert.equal((await f.snapshot()).stats.turns, 9);
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'ok');
});

test('requested targets publish independently on cold and warm polls while global sampling continues', async t => {
    let entered, release, block = true;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const calls = [];
    let sample = STATS;
    const f = await fixture(t, { store: { async getStats(id) {
        calls.push(id);
        if (id === SECOND_CLI && block) { entered(); await wait; }
        return sample;
    } } });
    await addUnrelated(f);
    await f.write({ ...f.row, bridgeSessionIds: [BRIDGE, 'session_target_second'] });
    let discoveries = 0;
    const sessions = path.dirname(path.dirname(path.dirname(f.metadata)));
    const originalOpendir = fs.opendir;
    t.mock.method(fs, 'opendir', async (directory, ...args) => {
        if (directory === sessions) discoveries++;
        return originalOpendir(directory, ...args);
    });
    await f.publisher.readLocal(SECOND_LOCAL, { waitForPoll: false });
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
    const poll = f.publisher.start();
    await within(ready);
    let fresh;
    try {
        assert.equal((await committedLocal(f)).status, 'ok');
        assert.equal((await f.snapshot()).stats.turns, 2);
        const second = JSON.parse(await fs.readFile(path.join(f.directory, 'session_target_second.json'), 'utf8'));
        assert.equal(second.stats.turns, 2);
        assert.deepEqual(calls, [CLI, SECOND_CLI]);
        let settled = false;
        fresh = f.publisher.readLocal(LOCAL).then(value => { settled = true; return value; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
    } finally { release(); await poll; }
    assert.equal((await fresh).status, 'ok');
    const unrelated = JSON.parse(await fs.readFile(path.join(f.directory, 'session_unrelated.json'), 'utf8'));
    assert.equal(unrelated.stats.turns, 2);
    assert.equal(discoveries, 4);
    block = false; calls.length = 0; discoveries = 0;
    await f.publisher.start();
    assert.deepEqual(calls, [CLI, SECOND_CLI]);
    assert.equal(discoveries, 2);
    sample = { status: 'unavailable', usageComplete: false };
    await f.publisher.start();
    calls.length = 0; discoveries = 0;
    await f.publisher.start();
    assert.deepEqual(calls, [CLI, SECOND_CLI]);
    assert.equal(discoveries, 2);
});

test('a duplicate introduced while collecting a priority target prevents its early publication', async t => {
    let f, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    f = await fixture(t, { store: { async getStats(id) {
        if (id === CLI) await addDuplicate(f);
        else { entered(); await wait; }
        return STATS;
    } } });
    await addUnrelated(f);
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    const poll = f.publisher.start();
    await within(ready);
    try {
        assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
        await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
    } finally { release(); await poll; }
});

test('the final global confirmation invalidates an early priority sample when a duplicate appears later', async t => {
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { store: { async getStats(id) {
        if (id === SECOND_CLI) { entered(); await wait; }
        return STATS;
    } } });
    await addUnrelated(f);
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    const poll = f.publisher.start();
    await within(ready);
    try {
        assert.equal((await committedLocal(f)).status, 'ok');
        await addDuplicate(f);
    } finally { release(); await poll; }
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false }))?.status, 'unavailable');
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('final priority invalidation cleans user storage without reopening the migrated workspace snapshot', async t => {
    let currentRoot, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, async ({ workspace }) => {
        currentRoot = workspace;
        return { resolveWorkspace: async () => ({ workspaceRoot: await fs.realpath(currentRoot),
            evidenceKey: currentRoot, verify: async () => true }),
        store: { async getStats(id) { if (id === SECOND_CLI) { entered(); await wait; } return STATS; } } };
    });
    await addUnrelated(f);
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    const poll = f.publisher.start();
    await within(ready);
    let oldSample;
    try {
        await committedLocal(f);
        oldSample = await f.snapshot();
        const legacy = path.join(f.workspace, '.claude', 'session-stats', `${BRIDGE}.json`);
        await fs.mkdir(path.dirname(legacy), { recursive: true }); await fs.writeFile(legacy, JSON.stringify(oldSample));
        const next = path.join(f.root, 'next-workspace');
        await fs.mkdir(next); currentRoot = next;
        const originalOpen = fs.open;
        const guarded = t.mock.method(fs, 'open', async (file, ...args) => {
            if (file === legacy) throw new Error('Old workspace must not be read');
            return originalOpen(file, ...args);
        });
        release(); await poll;
        assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false }))?.status, 'unavailable');
        await f.publisher.stop();
        assert.equal(guarded.mock.calls.some(call => call.arguments[0] === legacy), false);
        guarded.mock.restore();
        assert.deepEqual(JSON.parse(await fs.readFile(legacy, 'utf8')), oldSample);
    } finally { release(); await poll; }
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('lost workspace proof after early publication stays unavailable until a fresh discovery recovers', async t => {
    let unsafe = false, blocked = true, entered, release;
    const ready = new Promise(resolve => { entered = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, {
        resolveWorkspace: async binding => unsafe && binding.cliSessionId === CLI ? { unavailable: true } : null,
        store: { async getStats(id) {
            if (id === SECOND_CLI && blocked) { entered(); await wait; }
            return STATS;
        } },
    });
    await addUnrelated(f);
    await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    const poll = f.publisher.start();
    await within(ready);
    try {
        assert.equal((await committedLocal(f)).status, 'ok');
        unsafe = true;
    } finally { release(); await poll; }
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false }))?.status, 'unavailable');
    unsafe = false; blocked = false;
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'ok');
});

test('binding changes and stop before early publication cannot expose a priority sample', async t => {
    for (const action of ['binding', 'stop']) await t.test(action, async t => {
        let entered, enteredSecond, release;
        const ready = new Promise(resolve => { entered = resolve; });
        const secondReady = new Promise(resolve => { enteredSecond = resolve; });
        const wait = new Promise(resolve => { release = resolve; });
        const f = await fixture(t, { store: { async getStats(id) {
            if (id === CLI) { entered(); await wait; }
            else enteredSecond();
            return STATS;
        } } });
        await addUnrelated(f);
        await f.publisher.readLocal(LOCAL, { waitForPoll: false });
        const poll = f.publisher.start();
        await within(Promise.all([ready, secondReady]));
        let stopping;
        try {
            if (action === 'binding') await f.write({ ...f.row, cliSessionId: SECOND_CLI });
            else stopping = f.publisher.stop();
        } finally { release(); await poll; await stopping; }
        assert.notEqual((await f.publisher.readLocal(LOCAL, { waitForPoll: false }))?.status, 'ok');
        await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
    });
});

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
        assert.deepEqual((await fs.readdir(f.directory)).sort(), [`${BRIDGE}.json`]);
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

test('refuses a linked Claude configuration directory without writing outside it', async t => {
    let outside;
    const f = await fixture(t, async ({ root }) => {
        outside = path.join(root, 'outside');
        const claudeHome = path.join(root, 'config-alias');
        await fs.mkdir(outside);
        await fs.symlink(outside, claudeHome, 'junction');
        return { claudeHome };
    });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');
    assert.deepEqual(await fs.readdir(outside), []);
});

test('a linked session-stats directory cannot redirect generated files into a project', async t => {
    const f = await fixture(t);
    await fs.symlink(f.workspace, f.directory, 'junction');
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).snapshotUnavailableReason, 'publish-failed');
    assert.deepEqual(await fs.readdir(f.workspace), []);
});

for (const level of ['config-root', 'session-stats'])
test(`${level} replaced during a snapshot write cannot redirect publication or cleanup into a project`, async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const original = await f.snapshot();
    const directory = level === 'config-root' ? f.claudeHome : f.directory;
    const moved = path.join(f.root, 'moved-storage');
    const open = fs.open;
    let replaced = false;
    t.mock.method(fs, 'open', async (file, flags, ...args) => {
        const handle = await open(file, flags, ...args);
        if (!replaced && path.dirname(file) === f.directory && flags === 'wx') {
            const close = handle.close.bind(handle);
            handle.close = async () => {
                await close();
                replaced = true;
                await fs.rename(directory, moved);
                await fs.symlink(f.workspace, directory, 'junction');
            };
        }
        return handle;
    });
    f.setClock(110000); f.setStats({ ...STATS, turns: 9 });
    await f.publisher.start();
    await f.publisher.stop();
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(f.workspace), []);
    const relative = path.relative(directory, f.destination);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(moved, relative), 'utf8')), original);
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

test('incomplete refresh retains the last shared valid sample without extending its lifetime', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const committed = await f.snapshot();
    f.setStats({ status: 'incomplete', usageComplete: false });
    f.setClock(120000);
    const read = await f.publisher.readLocal(LOCAL);
    assert.equal(read.status, 'ok');
    assert.equal(read.snapshotRevision, committed.revision);
    assert.equal(read.snapshotGeneratedAt, committed.generatedAt);
    assert.deepEqual(await f.snapshot(), committed);
    f.setClock(130001);
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');
    assert.equal((await f.snapshot()).generatedAt, committed.generatedAt);
    f.setStats({ ...STATS, turns: 3 });
    const recovered = await f.publisher.readLocal(LOCAL);
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.turns, 3);
    assert.ok(recovered.snapshotRevision > committed.revision);
});

test('incomplete refresh cannot preserve a snapshot after its binding is disabled', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    f.setStats({ status: 'incomplete', usageComplete: false });
    await f.write({ ...f.row, remoteControlUserEnabled: false });
    assert.equal(await f.publisher.readLocal(LOCAL), null);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
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

test('stop preserves a newer same-publisher snapshot that this binding did not commit', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const replacement = { ...await f.snapshot(), revision: 999, stats: { ...STATS, turns: 99 } };
    await fs.writeFile(f.destination, JSON.stringify(replacement));
    await f.publisher.stop();
    assert.deepEqual(await f.snapshot(), replacement);
});

test('publication and stop leave legacy workspace snapshots and ignore rules byte-for-byte intact', async t => {
    const f = await fixture(t), legacy = path.join(f.workspace, '.claude', 'session-stats');
    await fs.mkdir(legacy, { recursive: true });
    const original = Buffer.from('legacy unknown snapshot\0'), ignore = '# existing workspace rules\n*.json\n';
    await fs.writeFile(path.join(legacy, `${BRIDGE}.json`), original);
    await fs.writeFile(path.join(legacy, '.gitignore'), ignore);
    const open = fs.open;
    const guard = t.mock.method(fs, 'open', async (file, ...args) => {
        if (path.dirname(file) === legacy) throw new Error('Legacy project files must not be opened');
        return open(file, ...args);
    });
    await f.publisher.start();
    assert.deepEqual((await f.snapshot()).stats, STATS);
    await f.publisher.stop();
    guard.mock.restore();
    assert.deepEqual(await fs.readFile(path.join(legacy, `${BRIDGE}.json`)), original);
    assert.equal(await fs.readFile(path.join(legacy, '.gitignore'), 'utf8'), ignore);
    assert.deepEqual((await fs.readdir(legacy)).sort(), ['.gitignore', `${BRIDGE}.json`]);
    assert.deepEqual(await fs.readdir(f.directory), []);
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

test('different Desktop workspace paths publish only in fixed user storage', async t => {
    const f = await fixture(t);
    const original = path.join(f.root, 'original-repository');
    const active = path.join(f.root, 'active-workspace');
    await fs.mkdir(original);
    await fs.mkdir(active);
    await f.write({ ...f.row, originCwd: original, worktreePath: active });
    await f.publisher.start();
    assert.deepEqual((await f.snapshot()).stats, STATS);
    for (const unused of [original, active, f.workspace])
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

async function pauseLocalValidation(t, f, { timeoutMs = 5000, holdMs = 5000, stage = 'before-open',
    readSnapshot = () => f.publisher.readLocal(LOCAL, { waitForPoll: false }) } = {}) {
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
        // Pause the local validation itself; unchanged sampling no longer opens the snapshot.
        if (!released && file === destination && flags === 'r' && ++reads === 1) {
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
    const read = readSnapshot();
    const local = Promise.race([read, deadline]);
    void local.catch(() => {});
    try {
        await Promise.race([ready, deadline, read.then(() => {
            if (!paused) throw new Error('Local read completed without pausing snapshot validation');
        })]);
    } catch (error) { release(); throw error; }
    return { local, release };
}

for (const change of ['publisher', 'stats', 'revision', 'rebound', 'ambiguous', 'expired'])
test(`remote snapshot validation rejects ${change} changes across its asynchronous file read`, async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const stage = ['publisher', 'stats', 'revision'].includes(change) ? 'before-open' : 'after-close';
    const paused = await pauseLocalValidation(t, f, { stage,
        readSnapshot: () => f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }) });
    try {
        if (change === 'rebound') await f.write({ ...f.row, cliSessionId: SECOND_CLI });
        else if (change === 'ambiguous') {
            await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
                sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI }));
        } else if (change === 'expired') f.setClock(131000);
        else {
            const replacement = await f.snapshot();
            if (change === 'publisher') replacement.publisherId = OTHER_PUBLISHER;
            if (change === 'stats') replacement.stats.totalTokens = 999;
            if (change === 'revision') replacement.revision++;
            await fs.writeFile(f.destination, JSON.stringify(replacement));
        }
    } finally { paused.release(); }
    assert.equal(await paused.local, null);
});

test('remote snapshot cancellation releases a blocked read without invalidating its cached sample', async t => {
    const f = await fixture(t), controller = new AbortController();
    await f.publisher.start();
    const published = await f.snapshot();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close',
        readSnapshot: () => f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG, signal: controller.signal }) });
    controller.abort();
    try { assert.equal(await within(paused.local), null); }
    finally { paused.release(); }
    assert.equal(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG, signal: controller.signal }), null);
    assert.deepEqual(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }), published);
});

test('remote snapshot stop releases a blocked read and never restarts publication', async t => {
    const f = await fixture(t);
    assert.equal(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }), null);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close',
        readSnapshot: () => f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }) });
    try {
        await f.publisher.stop();
        assert.equal(await within(paused.local), null);
    } finally { paused.release(); }
    assert.equal(await f.publisher.readRemoteSnapshot(BRIDGE, { organizationId: ORG }), null);
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('a workspace alias never redirects the fixed snapshot destination', async t => {
    const f = await fixture(t);
    const alias = path.join(f.root, 'workspace-alias');
    await fs.symlink(f.workspace, alias, 'junction');
    await f.write({ ...f.row, cwd: alias });
    await f.publisher.start();
    assert.equal(f.destination, await fs.realpath(f.destination));
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

test('a newer unavailable publication invalidates an older successful local sample', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const paused = await pauseLocalValidation(t, f, { stage: 'after-close' });
    f.setStats({ ...STATS, status: 'unavailable', usageComplete: false });
    try { assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable'); }
    finally { paused.release(); }
    const local = await paused.local;
    assert.equal(local.status, 'unavailable');
    assert.equal(local.snapshotRevision, undefined);
    assert.equal((await f.snapshot()).stats.status, 'unavailable');
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

test('snapshot storage containing a workspace is rejected before any generated write', async t => {
    for (const location of ['workspace-is-storage', 'workspace-in-storage', 'home-junction']) {
        await t.test(location, async t => {
            const f = await fixture(t, async ({ root, workspace }) => {
                if (location === 'home-junction') {
                    const claudeHome = path.join(root, 'home-alias'); await fs.symlink(workspace, claudeHome, 'junction');
                    return { claudeHome };
                }
                return {};
            });
            if (location.startsWith('workspace-')) {
                const workspace = location === 'workspace-is-storage' ? f.directory : path.join(f.directory, 'project');
                await fs.mkdir(workspace, { recursive: true }); await f.write({ ...f.row, cwd: workspace });
            }
            await f.publisher.start();
            const result = await f.publisher.readLocal(LOCAL);
            assert.equal(result.status, 'unavailable');
            assert.equal(result.snapshotRevision, undefined);
            assert.equal(await fs.stat(f.destination).then(() => true, () => false), false);
            assert.equal(await fs.stat(path.join(f.directory, '.gitignore')).then(() => true, () => false), false);
        });
    }
});

test('snapshot storage containing another discovered workspace prevents all publication there', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory);
    await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
        sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI, cwd: f.directory, bridgeSessionIds: ['session_second'] }));
    await f.publisher.start();
    assert.deepEqual(await fs.readdir(f.directory), []);
});

test('a second workspace discovered by final confirmation also blocks overlapping user storage', async t => {
    let f, sampled = false;
    f = await fixture(t, { store: { async getStats() {
        if (!sampled) {
            sampled = true;
            await fs.writeFile(path.join(path.dirname(f.metadata), `${SECOND_LOCAL}.json`), JSON.stringify({ ...f.row,
                sessionId: SECOND_LOCAL, cliSessionId: SECOND_CLI, cwd: f.directory, bridgeSessionIds: ['session_second'] }));
        }
        return STATS;
    } } });
    await fs.mkdir(f.directory);
    await f.publisher.start();
    assert.equal(sampled, true);
    assert.deepEqual(await fs.readdir(f.directory), []);
});

test('a new organization binding takes over one user filename without old-owner cleanup deleting it', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const before = await f.snapshot(), nextOrg = '99999999-9999-4999-8999-999999999999';
    const nextMetadata = path.join(f.claudeData, 'claude-code-sessions', ACCOUNT, nextOrg, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(nextMetadata), { recursive: true });
    await fs.rename(f.metadata, nextMetadata);
    f.setStats({ ...STATS, turns: 9 });
    await f.publisher.start();
    const after = await f.snapshot();
    assert.equal(after.organizationId, nextOrg);
    assert.equal(after.stats.turns, 9);
    assert.ok(after.revision > before.revision);
    assert.deepEqual(await fs.readdir(f.workspace), []);
    await f.publisher.stop();
    await assert.rejects(fs.stat(f.destination), { code: 'ENOENT' });
});

test('publication ignores unavailable tweak roots and never creates a workspace ignore file', async t => {
    const f = await fixture(t, { watchedTweaksRoot: 'Z:\\unavailable-tweaks' });
    const opendir = fs.opendir;
    t.mock.method(fs, 'opendir', async (directory, ...args) => {
        if (directory === 'Z:\\unavailable-tweaks') throw Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' });
        return opendir(directory, ...args);
    });
    await f.publisher.start();
    assert.deepEqual((await f.snapshot()).stats, STATS);
    assert.deepEqual(await fs.readdir(f.workspace), []);
});

test('Windows case variants of the same physical user home retain their fixed destination',
    { skip: process.platform !== 'win32' }, async t => {
        const f = await fixture(t, async ({ claudeHome }) => ({ claudeHome: claudeHome.toUpperCase() }));
        await f.publisher.start();
        assert.deepEqual((await f.snapshot()).stats, STATS);
        assert.deepEqual(await fs.readdir(f.workspace), []);
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
    const legacyDirectory = path.join(f.workspace, '.claude', 'session-stats');
    const legacy = path.join(legacyDirectory, `${BRIDGE}.json`);
    await fs.mkdir(legacyDirectory, { recursive: true });
    await fs.writeFile(legacy, JSON.stringify(initial));
    const worktree = path.join(f.root, 'worktree');
    await fs.mkdir(worktree);
    currentRoot = worktree; rootKey = 'worktree';
    f.setStats({ ...STATS, turns: 4, tps: 8 });
    const originalOpen = fs.open.bind(fs);
    const spy = t.mock.method(fs, 'open', async (file, ...args) => {
        if (path.resolve(file) === path.resolve(legacy)) throw new Error('Old workspace must not be read');
        return originalOpen(file, ...args);
    });
    const local = await f.publisher.readLocal(LOCAL);
    assert.equal(local.status, 'ok');
    assert.equal(local.tps, 8);
    const migrated = await f.snapshot();
    assert.equal(migrated.stats.turns, 4);
    assert.equal(migrated.stats.tps, 8);
    assert.ok(migrated.revision > initial.revision);
    spy.mock.restore();
    assert.deepEqual(JSON.parse(await fs.readFile(legacy, 'utf8')), initial);
    assert.deepEqual(await fs.readdir(worktree), []);
});

test('a rechecked Desktop binding resolves duplicate parent and child sources without a live registry', async t => {
    const { createSessionStore } = require('../src/session-store.cjs');
    let store, selected;
    const f = await fixture(t, async ({ root, workspace }) => {
        const claudeHome = path.join(root, 'claude');
        const stale = path.join(claudeHome, 'projects', 'stale');
        selected = path.join(claudeHome, 'projects', 'selected');
        await fs.mkdir(stale, { recursive: true });
        await fs.mkdir(selected, { recursive: true });
        const lines = (...rows) => rows.map(row => JSON.stringify(row) + '\n').join('');
        const answer = (id, output, extra = {}) => ({ type: 'assistant', sessionId: CLI, ...extra,
            message: { id, role: 'assistant', model: 'test', usage: { input_tokens: 10,
                cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } } });
        const prefix = lines(answer('first', 5), { type: 'relocated', sessionId: CLI, relocatedCwd: workspace });
        await fs.writeFile(path.join(stale, `${CLI}.jsonl`), prefix);
        await fs.writeFile(path.join(selected, `${CLI}.jsonl`), prefix + lines(answer('second', 7)));
        for (const [directory, output] of [[stale, 999], [selected, 13]]) {
            const children = path.join(directory, CLI, 'subagents');
            await fs.mkdir(children, { recursive: true });
            await fs.writeFile(path.join(children, 'agent-a.jsonl'), lines(answer('child', output,
                { agentId: 'a', isSidechain: true })));
        }
        store = createSessionStore({ claudeHome });
        t.after(() => store.dispose());
        return { store, resolveWorkspace: async () => null };
    });
    assert.equal((await store.getStats(CLI)).status, 'not-found');
    await f.publisher.start();
    assert.equal((await f.snapshot()).stats.totalTokens, 32);
    const child = JSON.parse(await fs.readFile(path.join(f.directory, `${BRIDGE}.agent-a.json`), 'utf8'));
    assert.equal(child.stats.totalTokens, 23);
    await f.write({ ...f.row, cliSessionId: '99999999-9999-4999-8999-999999999999' });
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
});
