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
const BRIDGE = 'session_Parent';
const PUBLISHER = '77777777-7777-4777-8777-777777777777';
const STATS = { turns: 2, steps: 3, totalTokens: 100, inputTokens: 60, outputTokens: 40,
    cachedInputTokens: 20, cacheHit: 1 / 3, tps: 4, usageComplete: true, status: 'ok' };

async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-publisher-')));
    const claudeData = path.join(root, 'desktop'), workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    const row = { sessionId: LOCAL, cliSessionId: CLI, cwd: workspace, bridgeSessionIds: [BRIDGE] };
    const write = value => fs.writeFile(metadata, JSON.stringify(value));
    await write(row);
    const calls = [], samples = new Map([['a', { ...STATS, turns: 3 }], ['b', { ...STATS, turns: 7 }]]);
    let agents = ['a', 'b'];
    const store = { async getStats(id) { assert.equal(id, CLI); return STATS; },
        async listAgents(id, context) { assert.equal(id, CLI); calls.push(['list', context]); return agents; },
        async getAgentStats(id, agentId, context) {
            assert.equal(id, CLI); calls.push(['stats', agentId, context]);
            const value = samples.get(agentId);
            if (value instanceof Error) throw value;
            return value;
        } };
    const publisher = createSnapshotPublisher({ claudeData, store, now: () => 100000,
        publisherId: PUBLISHER, pollMs: 100000, ...options });
    const directory = path.join(workspace, '.claude', 'session-stats');
    const destination = agentId => path.join(directory,
        `${BRIDGE}${agentId === undefined ? '' : `.agent-${agentId}`}.json`);
    const snapshot = async agentId => JSON.parse(await fs.readFile(destination(agentId), 'utf8'));
    t.after(async () => { await publisher.stop(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, claudeData, workspace, metadata, row, write, calls, samples, publisher,
        directory, destination, snapshot, setAgents(value) { agents = value; } };
}

test('parent and siblings publish separate exact samples and local child reads use the shared revision', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const parent = await f.snapshot(), first = await f.snapshot('a'), second = await f.snapshot('b');
    assert.equal(parent.schemaVersion, 1); assert.equal(Object.hasOwn(parent, 'agentId'), false);
    assert.equal(first.schemaVersion, 2); assert.equal(first.agentId, 'a');
    assert.equal(first.stats.turns, 3); assert.equal(second.stats.turns, 7); assert.equal(parent.stats.turns, 2);
    const read = await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false });
    assert.deepEqual(read, { ...first.stats, threadId: LOCAL, agentId: 'a', snapshotGeneratedAt: first.generatedAt,
        snapshotRevision: first.revision, snapshotPublisherId: PUBLISHER });
    assert.equal((await f.publisher.readLocal(LOCAL, { waitForPoll: false })).turns, 2);
    const missing = await f.publisher.readLocal(LOCAL, { agentId: 'unknown', waitForPoll: false });
    assert.equal(missing.status, 'unavailable'); assert.equal(missing.agentId, 'unknown');
    assert.equal(missing.turns, null);
    for (const agentId of ['../a', 'a\n', '', null])
        assert.equal(await f.publisher.readLocal(LOCAL, { agentId, waitForPoll: false }), null);
});

test('repeated discovery and duplicate IDs never accumulate or mix sibling counts', async t => {
    const f = await fixture(t);
    f.setAgents(['a', 'a', 'b']);
    await f.publisher.start();
    const before = await f.snapshot('a');
    await f.publisher.start();
    assert.deepEqual(await f.snapshot('a'), before);
    assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal((await f.snapshot('b')).stats.turns, 7);
    assert.equal(f.calls.filter(call => call[0] === 'stats' && call[1] === 'a').length, 2);
    f.setAgents(['b']);
    await f.publisher.start();
    await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
});

test('a child collection or destination failure cannot invalidate parent or siblings', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    f.samples.set('a', new Error('unreadable child'));
    await f.publisher.start();
    assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal((await f.snapshot('b')).stats.turns, 7);
    await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
    await fs.writeFile(f.destination('a'), JSON.stringify(await f.snapshot('b')));
    f.samples.set('a', STATS);
    await f.publisher.start();
    assert.equal((await f.snapshot('a')).agentId, 'b');
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
    assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal((await f.snapshot('b')).stats.turns, 7);
    await f.publisher.stop();
    assert.equal((await f.snapshot('a')).agentId, 'b');
});

test('child ownership rejects parent, foreign agent, organization and replayed payloads', async t => {
    for (const tamper of ['parent', 'agent', 'org', 'revision']) await t.test(tamper, async t => {
        const f = await fixture(t);
        await f.publisher.start();
        const replacement = await f.snapshot(tamper === 'parent' ? undefined : 'a');
        if (tamper === 'agent') replacement.agentId = 'b';
        if (tamper === 'org') replacement.organizationId = ACCOUNT;
        if (tamper === 'revision') replacement.revision++;
        await fs.writeFile(f.destination('a'), JSON.stringify(replacement));
        const read = await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false });
        assert.equal(read.status, 'unavailable'); assert.equal(read.snapshotRevision, undefined);
        assert.deepEqual(await f.snapshot('a'), replacement);
        assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'b', waitForPoll: false })).status, 'ok');
    });
});

test('child IDs are bounded and malformed or overflowing discovery leaves parent publication intact', async t => {
    const f = await fixture(t);
    for (const agents of [['a', '../bad'], ['a', 'a\n'], new Array(1),
        Array.from({ length: 129 }, (_, index) => `agent${index}`)]) {
        f.setAgents(agents);
        await f.publisher.start();
        assert.equal((await f.snapshot()).stats.turns, 2);
        const names = await fs.readdir(f.directory);
        assert.equal(names.some(name => name.includes('.agent-')), false);
    }
});

test('child collection uses the same verified workspace proof and cannot publish after mapping changes', async t => {
    let activeRoot, f;
    const resolveWorkspace = async () => ({ workspaceRoot: activeRoot, evidenceKey: 'proof', verify: async () => true });
    f = await fixture(t, { resolveWorkspace });
    activeRoot = f.workspace;
    // A workspace proof reaches both list and sample APIs, with a verified callback.
    await f.publisher.start();
    assert.ok(f.calls.length);
    for (const call of f.calls) {
        const context = call.at(-1);
        assert.equal(context.workspaceRoot, f.workspace);
        assert.equal(await context.verify(), true);
        assert.equal(typeof context.resolveRelocation, 'function');
    }
    await f.write({ ...f.row, cliSessionId: ACCOUNT });
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
});

test('confirmed rediscovery removes child publication when parent metadata becomes ambiguous', async t => {
    const f = await fixture(t);
    await f.publisher.start();
    const other = path.join(f.claudeData, 'claude-code-sessions', CLI, ORG);
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(path.join(other, `${LOCAL}.json`), JSON.stringify(f.row));
    await f.publisher.start();
    for (const agentId of [undefined, 'a', 'b'])
        await assert.rejects(fs.stat(f.destination(agentId)), { code: 'ENOENT' });
});

test('parent-only legacy publication and cleanup preserve neighboring child v2 snapshots', async t => {
    const { createSnapshotProtocol } = require('../src/snapshot.cjs');
    const f = await fixture(t, { store: { async getStats() { return STATS; } } });
    await f.publisher.start();
    const foreign = createSnapshotProtocol().makeSnapshot({ bridgeSessionId: BRIDGE, organizationId: ORG,
        agentId: 'foreign' }, STATS, { publisherId: PUBLISHER, revision: 3, now: 100000 });
    await fs.writeFile(f.destination('foreign'), JSON.stringify(foreign));
    await f.publisher.start();
    assert.equal((await f.snapshot()).schemaVersion, 1);
    await f.publisher.stop();
    await assert.rejects(fs.stat(f.destination()), { code: 'ENOENT' });
    assert.deepEqual(await f.snapshot('foreign'), foreign);
});

test('same-round confirmed child rediscovery prevents an obsolete agent sample from publishing', async t => {
    let agents = ['a'], sampled = 0;
    const f = await fixture(t, { store: { async getStats() { return STATS; },
        async listAgents() { return agents; }, async getAgentStats() { sampled++; agents = ['b']; return STATS; } } });
    await f.publisher.start();
    assert.equal(sampled, 1);
    assert.equal((await f.snapshot()).stats.turns, 2);
    await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
});

test('unsafe child file links fail closed without changing the parent, sibling or link target', async t => {
    const f = await fixture(t);
    await fs.mkdir(f.directory, { recursive: true });
    const target = path.join(f.root, 'unrelated.json');
    await fs.writeFile(target, 'private');
    await fs.symlink(target, f.destination('a'), 'file');
    await f.publisher.start();
    assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal((await f.snapshot('b')).stats.turns, 7);
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false })).status, 'unavailable');
    await f.publisher.stop();
    assert.equal(await fs.readFile(target, 'utf8'), 'private');
    assert.equal((await fs.lstat(f.destination('a'))).isSymbolicLink(), true);
});

test('global child capacity is bounded independently from parent publication', async t => {
    const ids = Array.from({ length: 128 }, (_, index) => `a${index}`);
    let collected = 0;
    const f = await fixture(t, { store: { async getStats() { return STATS; },
        async listAgents() { return ids; }, async getAgentStats() { collected++; return null; } } });
    const directory = path.dirname(f.metadata);
    for (let index = 1; index < 33; index++) {
        const suffix = index.toString(16).padStart(12, '0');
        const sessionId = `local_44444444-4444-4444-8444-${suffix}`;
        await fs.writeFile(path.join(directory, `${sessionId}.json`), JSON.stringify({ ...f.row, sessionId,
            cliSessionId: `33333333-3333-4333-8333-${suffix}`, bridgeSessionIds: [`session_Parent${index}`] }));
    }
    await f.publisher.start();
    assert.equal(collected, 4096);
    assert.equal((await fs.readdir(f.directory)).filter(name => name.endsWith('.json')).length, 33);
    assert.equal((await f.snapshot()).stats.turns, 2);
});

test('real incremental child logs publish separate samples and replay never changes their counts', async t => {
    const { createSessionStore } = require('../src/session-store.cjs');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-published-log-'));
    const store = createSessionStore({ claudeHome: home });
    t.after(async () => { store.dispose(); await fs.rm(home, { recursive: true, force: true }); });
    const f = await fixture(t, { store });
    const directory = path.join(home, 'projects', 'project'), children = path.join(directory, CLI, 'subagents');
    await fs.mkdir(children, { recursive: true });
    const assistant = (id, agentId, output) => ({ type: 'assistant', sessionId: CLI, uuid: `row-${id}`,
        ...(agentId === undefined ? {} : { agentId, isSidechain: true }), message: {
            role: 'assistant', id, usage: { input_tokens: 10, cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0, output_tokens: output } } });
    await fs.writeFile(path.join(directory, `${CLI}.jsonl`), JSON.stringify(assistant('parent', undefined, 90)) + '\n');
    const childFile = path.join(children, 'agent-a.jsonl');
    const childRow = JSON.stringify(assistant('child', 'a', 7)) + '\n';
    await fs.writeFile(childFile, childRow);
    await f.publisher.start();
    assert.equal((await f.snapshot()).stats.totalTokens, 100);
    const first = await f.snapshot('a');
    assert.equal(first.stats.totalTokens, 17); assert.equal(first.stats.tps, null);
    await fs.appendFile(childFile, childRow);
    await f.publisher.start();
    assert.deepEqual(await f.snapshot('a'), first);
    const local = await f.publisher.readLocal(LOCAL, { agentId: 'a', waitForPoll: false });
    assert.equal(local.totalTokens, 17); assert.equal(local.snapshotRevision, first.revision);
    assert.equal((await f.snapshot()).stats.totalTokens, 100);
});
