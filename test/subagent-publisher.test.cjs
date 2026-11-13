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

async function within(promise, timeoutMs = 500) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Visible statistics waited for unrelated work')), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

async function waitForSnapshot(f, agentId, predicate = () => true) {
    const deadline = Date.now() + 1000;
    for (;;) {
        try { const snapshot = await f.snapshot(agentId); if (predicate(snapshot)) return snapshot; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (Date.now() >= deadline) throw new Error('Visible statistics waited for unrelated work');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-agent-publisher-')));
    const claudeData = path.join(root, 'desktop'), workspace = path.join(root, 'workspace');
    const claudeHome = path.join(root, 'home');
    await fs.mkdir(workspace);
    await fs.mkdir(claudeHome);
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
    const publisher = createSnapshotPublisher({ claudeData, claudeHome, store, now: () => 100000,
        publisherId: PUBLISHER, pollMs: 100000, ...options });
    const directory = path.join(claudeHome, '.session-stats');
    const destination = agentId => path.join(directory,
        `${BRIDGE}${agentId === undefined ? '' : `.agent-${agentId}`}.json`);
    const snapshot = async agentId => JSON.parse(await fs.readFile(destination(agentId), 'utf8'));
    let selected = 'a';
    const renew = () => publisher.setInterest('test_visible', [{ localSessionId: LOCAL },
        ...(selected ? [{ localSessionId: LOCAL, agentId: selected }] : [])]);
    renew();
    const start = publisher.start; publisher.start = () => { renew(); return start(); };
    const readLocal = publisher.readLocal;
    publisher.readLocal = (id, options = {}) => readLocal(id, { owner: 'test_visible', ...options });
    t.after(async () => { await publisher.stop(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, claudeData, workspace, claudeHome, metadata, row, write, calls, samples, publisher,
        directory, destination, snapshot, select(value) { selected = value; renew(); } };
}


test('only the viewed parent and selected child publish while an available sibling stays unread', async t => {
    const f = await fixture(t); await f.publisher.start();
    assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal((await f.snapshot('a')).stats.turns, 3);
    await assert.rejects(fs.stat(f.destination('b')), { code: 'ENOENT' });
    assert.deepEqual(f.calls.filter(call => call[0] === 'stats').map(call => call[1]), ['a']);
    assert.equal(f.calls.some(call => call[0] === 'list'), false);
});
test('switching selected children revokes old publication and samples only the new exact child', async t => {
    const f = await fixture(t); await f.publisher.start(); f.select('b'); await f.publisher.start();
    assert.equal((await f.snapshot('b')).stats.turns, 7);
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a' })).status, 'unavailable');
    await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
});
test('multiple viewer owners retain independent selected children until each releases', async t => {
    const f = await fixture(t); f.publisher.setInterest('other_window', [{ localSessionId: LOCAL, agentId: 'b' }]);
    await f.publisher.start(); assert.equal((await f.snapshot('b')).stats.turns, 7);
    f.select(null); await f.publisher.start();
    assert.equal((await f.publisher.readLocal(LOCAL, { owner: 'other_window', agentId: 'b' })).status, 'ok');
    f.publisher.releaseInterest('other_window');
    assert.equal((await f.publisher.readLocal(LOCAL, { owner: 'other_window', agentId: 'b' })).status, 'unavailable');
});
test('late child results cannot publish after a selection change or stop', async t => {
    for (const action of ['switch', 'stop']) await t.test(action, async t => {
        let entered, release; const ready = new Promise(r => entered = r), gate = new Promise(r => release = r);
        const f = await fixture(t, { store: { getStats: async () => STATS,
            async getAgentStats(id, agentId) { if (agentId === 'a') { entered(); await gate; } return { ...STATS, threadId: id, agentId }; } } });
        const starting = f.publisher.start(); await ready;
        if (action === 'switch') { f.select('b'); await f.publisher.start(); } else await f.publisher.stop();
        release(); await starting;
        await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
        if (action === 'switch') assert.equal((await f.snapshot('b')).agentId, 'b');
    });
});
test('a wrong explicit child identity is rejected without invalidating the selected parent', async t => {
    const f = await fixture(t, { store: { getStats: async () => STATS,
        getAgentStats: async id => ({ ...STATS, threadId: id, agentId: 'foreign' }) } });
    await f.publisher.start(); assert.equal((await f.snapshot()).stats.turns, 2);
    await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
});
test('a linked child destination cannot alter its target or prevent the selected parent from publishing', async t => {
    const f = await fixture(t); await fs.mkdir(f.directory); const outside = path.join(f.root, 'outside.json');
    await fs.writeFile(outside, 'private'); await fs.symlink(outside, f.destination('a'), 'file');
    await f.publisher.start(); assert.equal((await f.snapshot()).stats.turns, 2);
    assert.equal(await fs.readFile(outside, 'utf8'), 'private');
    assert.equal((await f.publisher.readLocal(LOCAL, { agentId: 'a' })).status, 'unavailable');
});
test('a conflicting parent introduced while the child is sampled prevents its pending publication', async t => {
    let f;
    f = await fixture(t, { store: { getStats: async () => STATS, async getAgentStats(id, agentId) {
        const directory = path.join(f.claudeData, 'claude-code-sessions', CLI, ORG);
        await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, `${LOCAL}.json`), JSON.stringify(f.row));
        return { ...STATS, threadId: id, agentId };
    } } });
    await f.publisher.start(); await assert.rejects(fs.stat(f.destination('a')), { code: 'ENOENT' });
});
test('real selected child logs remain incremental and an unselected sibling file is never opened', async t => {
    const { createSessionStore } = require('../src/session-store.cjs');
    const f = await fixture(t); const projects = path.join(f.claudeHome, 'projects', 'project');
    const children = path.join(projects, CLI, 'subagents'); await fs.mkdir(children, { recursive: true });
    const row = (id, agentId, output) => JSON.stringify({ type: 'assistant', sessionId: CLI, uuid: id,
        ...(agentId ? { agentId, isSidechain: true } : {}), message: { role: 'assistant', model: 'test', id,
            usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } } }) + '\n';
    await fs.writeFile(path.join(projects, `${CLI}.jsonl`), row('parent', null, 90));
    const chosen = path.join(children, 'agent-a.jsonl'), sibling = path.join(children, 'agent-b.jsonl');
    const original = row('child', 'a', 7); await fs.writeFile(chosen, original); await fs.writeFile(sibling, row('sibling', 'b', 99));
    await f.publisher.stop();
    const store = createSessionStore({ claudeHome: f.claudeHome });
    const publisher = createSnapshotPublisher({ claudeData: f.claudeData, claudeHome: f.claudeHome, store, pollMs: 100000 });
    t.after(async () => { await publisher.stop(); store.dispose(); });
    const open = fs.open; let siblingReads = 0;
    t.mock.method(fs, 'open', async (file, ...args) => { if (file === sibling) siblingReads++; return open(file, ...args); });
    publisher.setInterest('live_window', [{ localSessionId: LOCAL }, { localSessionId: LOCAL, agentId: 'a' }]);
    await publisher.start(); const first = await publisher.readLocal(LOCAL, { owner: 'live_window', agentId: 'a' });
    assert.equal(first.totalTokens, 17); await fs.appendFile(chosen, original);
    assert.equal((await publisher.readLocal(LOCAL, { owner: 'live_window', agentId: 'a' })).totalTokens, 17);
    assert.equal(siblingReads, 0);
});
