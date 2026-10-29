'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CLI = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_recovery';
const PUBLISHER = '77777777-7777-4777-8777-777777777777';
const STATS = { turns: 2, steps: 3, totalTokens: 100, inputTokens: 60, outputTokens: 40,
    cachedInputTokens: 20, cacheHit: 1 / 3, tps: 4, usageComplete: true, status: 'ok' };

async function fixture(t, { children = [], ...options } = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-snapshot-recovery-')));
    const claudeData = path.join(root, 'desktop'), workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    const row = { sessionId: LOCAL, cliSessionId: CLI, cwd: workspace, bridgeSessionIds: [BRIDGE] };
    const writeBinding = value => fs.writeFile(metadata, JSON.stringify(value));
    await writeBinding(row);
    let stats = { ...STATS }, clock = 100000;
    const store = { async getStats() { return stats; }, async listAgents() { return children; },
        async getAgentStats() { return stats; } };
    const publisherOptions = { claudeData, store, now: () => clock, pollMs: 100000,
        publisherId: PUBLISHER, ...options };
    const publishers = [];
    const makePublisher = () => { const value = createSnapshotPublisher(publisherOptions); publishers.push(value); return value; };
    const publisher = makePublisher();
    const directory = path.join(workspace, '.claude', 'session-stats');
    const destination = agentId => path.join(directory, `${BRIDGE}${agentId === undefined ? '' : `.agent-${agentId}`}.json`);
    const backupDirectory = path.join(directory, 'corrupt-backups');
    const backup = (bytes, agentId) => path.join(backupDirectory,
        `${path.basename(destination(agentId))}.corrupt-${createHash('sha256').update(bytes).digest('hex')}.bak`);
    const seed = async (bytes, agentId) => {
        await fs.mkdir(directory, { recursive: true }); await fs.writeFile(destination(agentId), bytes);
    };
    const snapshot = async agentId => JSON.parse(await fs.readFile(destination(agentId), 'utf8'));
    t.after(async () => { for (const value of publishers) await value.stop(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, workspace, metadata, row, writeBinding, publisher, makePublisher, directory, destination,
        backupDirectory, backup, seed, snapshot, children, setStats(value) { stats = value; }, setClock(value) { clock = value; } };
}

for (const [label, bytes] of [['zero-filled', Buffer.alloc(487)], ['empty', Buffer.alloc(0)],
    ['whitespace', Buffer.from(' \n\t')], ['truncated', Buffer.from('{"schemaVersion":1,')],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0])]])
test(`${label} parent snapshots are durably backed up and rebuilt at cold start`, async t => {
    const f = await fixture(t);
    await f.seed(bytes);
    await f.publisher.start();
    const sample = await f.publisher.readLocal(LOCAL);
    assert.equal(sample.status, 'ok');
    const snapshot = await f.snapshot();
    assert.equal(sample.snapshotRevision, snapshot.revision);
    assert.deepEqual(snapshot.stats, STATS);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
    assert.deepEqual(await fs.readdir(f.backupDirectory), [path.basename(f.backup(bytes))]);
    await f.publisher.stop();
    await assert.rejects(fs.stat(f.destination()), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
});

test('zero-filled child snapshots recover only current child membership and retain exact bytes', async t => {
    const f = await fixture(t, { children: ['a'] });
    const bytes = Buffer.alloc(507);
    await f.seed(bytes, 'a'); await f.seed(bytes, 'missing');
    await f.publisher.start();
    const sample = await f.publisher.readLocal(LOCAL, { agentId: 'a' });
    const snapshot = await f.snapshot('a');
    assert.equal(sample.status, 'ok'); assert.equal(sample.snapshotRevision, snapshot.revision);
    assert.equal(snapshot.agentId, 'a'); assert.deepEqual(await fs.readFile(f.backup(bytes, 'a')), bytes);
    assert.deepEqual(await fs.readFile(f.destination('missing')), bytes);
    await assert.rejects(fs.stat(f.backup(bytes, 'missing')), { code: 'ENOENT' });
});

test('fully sampled ok metrics with incomplete usage can recover a corrupt snapshot', async t => {
    const f = await fixture(t);
    await f.seed(Buffer.alloc(1));
    f.setStats({ ...STATS, usageComplete: false });
    await f.publisher.start();
    const sample = await f.publisher.readLocal(LOCAL);
    assert.equal(sample.status, 'ok'); assert.equal(sample.usageComplete, false); assert.equal(sample.tps, 4);
});

for (const status of ['incomplete', 'unavailable', 'not-found'])
test(`${status} samples preserve corrupt destinations without creating backups`, async t => {
    const f = await fixture(t); const bytes = Buffer.alloc(487);
    await f.seed(bytes); f.setStats({ status, usageComplete: false });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    await assert.rejects(fs.stat(f.backupDirectory), { code: 'ENOENT' });
});

function validSnapshot(agentId) {
    return createSnapshotProtocol().makeSnapshot({ bridgeSessionId: BRIDGE, organizationId: ORG, agentId }, STATS,
        { publisherId: PUBLISHER, revision: 91, now: 100000 });
}

for (const [label, value] of [['unknown schema', { schemaVersion: 99 }], ['scalar', 0], ['null', null],
    ['foreign organization', { ...validSnapshot(), organizationId: ACCOUNT }],
    ['foreign bridge', { ...validSnapshot(), bridgeSessionId: 'session_other' }],
    ['foreign agent', validSnapshot('other')]])
test(`valid JSON with ${label} is preserved without recovery`, async t => {
    const f = await fixture(t); const bytes = Buffer.from(JSON.stringify(value));
    await f.seed(bytes); await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'unavailable');
    await f.publisher.stop();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    await assert.rejects(fs.stat(f.backupDirectory), { code: 'ENOENT' });
});

for (const kind of ['symbolic link', 'hard link', 'oversized file', 'directory'])
test(`corrupt destination ${kind} is refused and preserved`, async t => {
    const f = await fixture(t), bytes = Buffer.alloc(kind === 'oversized file' ? 16385 : 487);
    await fs.mkdir(f.directory, { recursive: true });
    const original = path.join(f.root, 'original'); await fs.writeFile(original, bytes);
    if (kind === 'symbolic link') await fs.symlink(original, f.destination(), 'file');
    else if (kind === 'hard link') await fs.link(original, f.destination());
    else if (kind === 'directory') await fs.mkdir(f.destination());
    else await f.seed(bytes);
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(original), bytes);
    if (kind === 'directory') assert.equal((await fs.lstat(f.destination())).isDirectory(), true);
    else assert.deepEqual(await fs.readFile(f.destination()), bytes);
    await assert.rejects(fs.stat(f.backupDirectory), { code: 'ENOENT' });
});

test('a linked backup directory is never traversed', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487), outside = path.join(f.root, 'outside');
    await f.seed(bytes); await fs.mkdir(outside);
    await fs.symlink(outside, f.backupDirectory, 'junction');
    await f.publisher.start();
    assert.deepEqual(await fs.readdir(outside), []);
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
});

for (const kind of ['different bytes', 'symbolic link', 'hard link'])
test(`an existing backup with ${kind} cannot authorize recovery`, async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487);
    await f.seed(bytes); await fs.mkdir(f.backupDirectory);
    const unrelated = path.join(f.root, 'unrelated'); await fs.writeFile(unrelated, bytes);
    if (kind === 'different bytes') await fs.writeFile(f.backup(bytes), 'keep');
    else if (kind === 'symbolic link') await fs.symlink(unrelated, f.backup(bytes), 'file');
    else await fs.link(unrelated, f.backup(bytes));
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(unrelated), bytes);
    if (kind === 'different bytes') assert.equal(await fs.readFile(f.backup(bytes), 'utf8'), 'keep');
});

test('backup sync failure preserves the original and retries by durably reusing its exact backup', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalOpen = fs.open; let failed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes) && !failed) {
            handle.sync = async () => { failed = true; throw new Error('Injected backup sync failure'); };
        }
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
    await f.publisher.start();
    const sample = await f.publisher.readLocal(LOCAL);
    assert.equal(sample.status, 'ok'); assert.equal(sample.snapshotRevision, (await f.snapshot()).revision);
    assert.deepEqual(await fs.readdir(f.backupDirectory), [path.basename(f.backup(bytes))]);
});

test('a partial backup write is cleaned up safely so the next refresh can recover automatically', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalOpen = fs.open; let failed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes) && !failed) {
            const write = handle.writeFile.bind(handle);
            handle.writeFile = async value => {
                failed = true; await write(value.subarray(0, 7)); throw new Error('Injected partial write failure');
            };
        }
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    await assert.rejects(fs.stat(f.backup(bytes)), { code: 'ENOENT' });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
});

test('an in-place unrelated backup rewrite after a failed write is preserved during cleanup', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487), unrelated = Buffer.from('externally replaced backup');
    await f.seed(bytes);
    const originalOpen = fs.open; let failed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes) && !failed) {
            const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
            handle.writeFile = async value => {
                failed = true; await write(value.subarray(0, 7)); throw new Error('Injected partial write failure');
            };
            handle.close = async () => { await close(); await fs.writeFile(file, unrelated); };
        }
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), unrelated);
});

test('a completed backup truncated externally during a sync failure is preserved even when it is an exact prefix', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487), truncated = bytes.subarray(0, 7);
    await f.seed(bytes);
    const originalOpen = fs.open; let failed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes) && !failed) handle.sync = async () => {
            failed = true; await fs.writeFile(file, truncated); throw new Error('Injected sync failure after external truncation');
        };
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), truncated);
});

test('restart reuses a durable backup left by a failed replacement without duplicating it', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalRename = fs.rename;
    const blocked = t.mock.method(fs, 'rename', async (from, to) => {
        if (to === f.destination()) throw new Error('Injected replacement failure');
        return originalRename(from, to);
    });
    await f.publisher.start(); await f.publisher.stop();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
    blocked.mock.restore();
    const restarted = f.makePublisher(); await restarted.start();
    assert.equal((await restarted.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readdir(f.backupDirectory), [path.basename(f.backup(bytes))]);
});

async function pauseBackup(t, f, bytes, agentId, afterClose = false) {
    let entered, release, paused = false;
    const ready = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    t.after(release);
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes, agentId) && !paused) {
            if (afterClose) {
                const close = handle.close.bind(handle);
                handle.close = async () => { await close(); paused = true; entered(); await blocked; };
            } else {
                const sync = handle.sync.bind(handle);
                handle.sync = async () => { paused = true; entered(); await blocked; return sync(); };
            }
        }
        return handle;
    });
    return { release, async ready() {
        let timer;
        try { await Promise.race([ready, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Backup did not reach sync')), 3000);
        })]); } finally { clearTimeout(timer); }
    } };
}

test('a valid destination repaired during backup is preserved even when it uses this publisher ID', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487);
    await f.publisher.start(); f.setClock(110000); await f.seed(bytes);
    const gate = await pauseBackup(t, f, bytes), starting = f.publisher.start();
    const repaired = JSON.stringify(validSnapshot());
    try { await gate.ready(); await fs.writeFile(f.destination(), repaired); }
    finally { gate.release(); await starting; }
    assert.equal(await fs.readFile(f.destination(), 'utf8'), repaired);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
});

for (const action of ['binding', 'workspace root', 'stop', 'child membership'])
test(`${action} changing during backup prevents a fresh recovery publication`, async t => {
    const child = action === 'child membership' ? 'a' : undefined;
    const f = await fixture(t, { children: child ? ['a'] : [] }), bytes = Buffer.alloc(487);
    await f.seed(bytes, child);
    const gate = await pauseBackup(t, f, bytes, child, action === 'workspace root');
    const starting = f.publisher.start(); let stopping, relocated;
    try {
        await gate.ready();
        if (action === 'binding') await f.writeBinding({ ...f.row, remoteControlUserEnabled: false });
        else if (action === 'workspace root') {
            relocated = path.join(f.root, 'relocated'); await fs.rename(f.workspace, relocated); await fs.mkdir(f.workspace);
        } else if (child) f.children.length = 0;
        else stopping = f.publisher.stop();
    } finally { gate.release(); await starting; await stopping; }
    const original = relocated ? path.join(relocated, '.claude', 'session-stats', path.basename(f.destination(child))) : f.destination(child);
    assert.deepEqual(await fs.readFile(original), bytes);
});

test('a live snapshot corrupted after a previous good sample recovers on the next heartbeat', async t => {
    const f = await fixture(t); await f.publisher.start();
    const previous = await f.snapshot(), bytes = Buffer.alloc(499); await f.seed(bytes);
    f.setClock(110000); await f.publisher.start();
    const sample = await f.publisher.readLocal(LOCAL);
    assert.equal(sample.status, 'ok'); assert.ok(sample.snapshotRevision > previous.revision);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
});

test('a changing destination cannot supply a corruption proof or trigger a backup', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalOpen = fs.open; let changed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.destination() && !changed) {
            const read = handle.read.bind(handle);
            handle.read = async (...values) => {
                const result = await read(...values);
                if (!changed) { changed = true; await fs.appendFile(file, '\0'); }
                return result;
            };
        }
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), Buffer.alloc(488));
    await assert.rejects(fs.stat(f.backupDirectory), { code: 'ENOENT' });
});

test('a different corrupt version arriving during backup survives until a new refresh proves it', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487), newer = Buffer.from('{"new":');
    await f.seed(bytes);
    const gate = await pauseBackup(t, f, bytes), starting = f.publisher.start();
    try { await gate.ready(); await fs.writeFile(f.destination(), newer); }
    finally { gate.release(); await starting; }
    assert.deepEqual(await fs.readFile(f.destination()), newer);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readFile(f.backup(newer)), newer);
});

test('read-only local validation leaves corruption intact until serialized publication recovers it', async t => {
    const f = await fixture(t); await f.publisher.start();
    await f.publisher.readLocal(LOCAL, { waitForPoll: false }); await f.publisher.start();
    const bytes = Buffer.alloc(487); await f.seed(bytes);
    const sample = await f.publisher.readLocal(LOCAL, { waitForPoll: false });
    assert.equal(sample.status, 'unavailable');
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    await assert.rejects(fs.stat(f.backupDirectory), { code: 'ENOENT' });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
});

test('backup and replacement data are synced before the original is atomically replaced', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalOpen = fs.open, originalRename = fs.rename, events = [];
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file === f.backup(bytes) || file.endsWith('.tmp')) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => { await sync(); events.push(file.endsWith('.tmp') ? 'replacement' : 'backup'); };
        }
        return handle;
    });
    t.mock.method(fs, 'rename', async (from, to) => {
        if (to === f.destination()) {
            assert.deepEqual(events, ['backup', 'replacement']);
            assert.deepEqual(await fs.readFile(to), bytes);
            assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
        }
        return originalRename(from, to);
    });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
});

test('replacement sync failure preserves the original and its durable backup for the next refresh', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    const originalOpen = fs.open; let failed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file.endsWith('.tmp') && !failed) handle.sync = async () => {
            failed = true; throw new Error('Injected replacement sync failure');
        };
        return handle;
    });
    await f.publisher.start();
    assert.deepEqual(await fs.readFile(f.destination()), bytes);
    assert.deepEqual(await fs.readFile(f.backup(bytes)), bytes);
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readdir(f.backupDirectory), [path.basename(f.backup(bytes))]);
});

test('concurrent filesystem readers see only the exact corrupt original or a complete recovery snapshot', async t => {
    const f = await fixture(t), bytes = Buffer.alloc(487); await f.seed(bytes);
    let finished = false, reads = 0;
    const starting = f.publisher.start().finally(() => { finished = true; });
    try {
        while (!finished || reads < 30) {
            const observed = await fs.readFile(f.destination()); reads++;
            if (observed.equals(bytes)) continue;
            const snapshot = JSON.parse(observed.toString('utf8'));
            assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.bridgeSessionId, BRIDGE);
            assert.deepEqual(snapshot.stats, STATS);
        }
    } finally { await starting; }
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
});

test('valid publications do not traverse backup directories or sync snapshot writes', async t => {
    const f = await fixture(t), outside = path.join(f.root, 'outside');
    await f.seed(JSON.stringify(validSnapshot())); await fs.mkdir(outside);
    await fs.symlink(outside, f.backupDirectory, 'junction');
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        handle.sync = async () => { throw new Error('Valid publication must not require a recovery sync'); };
        return handle;
    });
    await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL)).status, 'ok');
    assert.deepEqual(await fs.readdir(outside), []);
});
