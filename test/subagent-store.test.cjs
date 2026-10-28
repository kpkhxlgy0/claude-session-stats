'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a123456';
function assistant(id = 'answer', output = 40, fields = {}) {
    return { type: 'assistant', uuid: `row-${id}`, sessionId: ID, agentId: AGENT, isSidechain: true,
        timestamp: '2026-10-28T00:00:02Z', requestId: `request-${id}`, message: {
            role: 'assistant', model: 'test', id, usage: { input_tokens: 10,
                cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: output } }, ...fields };
}
function user(fields = {}) {
    return { type: 'user', uuid: 'input', sessionId: ID, agentId: AGENT, isSidechain: true,
        timestamp: '2026-10-28T00:00:00Z', message: { role: 'user', content: 'child prompt' }, ...fields };
}
function lines(...rows) { return rows.map(row => JSON.stringify(row) + '\n').join(''); }
async function setup(t, options = {}) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-subagent-'));
    const directory = path.join(home, 'projects', 'project');
    const subagents = path.join(directory, ID, 'subagents');
    await fs.mkdir(subagents, { recursive: true });
    const parent = path.join(directory, `${ID}.jsonl`);
    await fs.writeFile(parent, lines(assistant('parent', 900, { isSidechain: false, agentId: undefined })));
    const store = createSessionStore({ claudeHome: home, ...options });
    t.after(async () => { store.dispose(); await fs.rm(home, { recursive: true, force: true }); });
    async function write(agentId = AGENT, content = lines(user(), assistant())) {
        const file = path.join(subagents, `agent-${agentId}.jsonl`);
        await fs.writeFile(file, content);
        return file;
    }
    return { home, directory, subagents, parent, store, write };
}

test('individual child totals are isolated from parent and sibling logs without fork inheritance', async t => {
    const { store, write } = await setup(t, { resolveFork: () => { throw new Error('child must not inherit'); } });
    await write(); await write('b765432', lines(assistant('sibling', 999, { agentId: 'b765432' })));
    const stats = await store.getAgentStats(ID, AGENT);
    assert.deepEqual(stats, { threadId: ID, agentId: AGENT, status: 'ok', turns: 1, steps: 1,
        totalTokens: 140, inputTokens: 100, outputTokens: 40, cachedInputTokens: 70,
        cacheHit: 0.7, tps: 20, usageComplete: true });
    assert.equal((await store.getStats(ID)).totalTokens, 1000);
    assert.deepEqual(await store.listAgents(ID), [AGENT, 'b765432']);
});

test('child reads incrementally complete partial rows and deduplicate response updates', async t => {
    const { store, write } = await setup(t);
    const file = await write(AGENT, lines(user(), assistant()) + JSON.stringify(assistant('next', 5)).slice(0, 90));
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 140);
    await fs.appendFile(file, JSON.stringify(assistant('next', 5)).slice(90) + '\n' + lines(assistant('answer', 60)));
    const results = await Promise.all(Array.from({ length: 8 }, () => store.getAgentStats(ID, AGENT)));
    for (const stats of results) {
        assert.equal(stats.totalTokens, 265); assert.equal(stats.steps, 2); assert.equal(stats.outputTokens, 65);
    }
    assert.deepEqual(await store.getAgentStats(ID, AGENT), results[0]);
});

test('child truncation, replacement, and same-size rewrites discard cached totals', async t => {
    const { store, write } = await setup(t);
    const file = await write(AGENT, lines(user(), assistant('first'), assistant('other')));
    assert.equal((await store.getAgentStats(ID, AGENT)).steps, 2);
    await fs.writeFile(file, lines(user(), assistant('fresh', 1)));
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 101);
    await fs.writeFile(file, lines(user(), assistant('fresh', 2)));
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 102);
    const replacement = await write('replacement', lines(user(), assistant('new', 3)));
    await fs.rename(replacement, file);
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 103);
});

test('incomplete child identity never exposes a plausible partial total', async t => {
    for (const fields of [
        { sessionId: OTHER }, { sessionId: undefined }, { agentId: 'foreign' }, { agentId: undefined },
        { isSidechain: false }, { isSidechain: undefined }
    ]) {
        const { store, write } = await setup(t);
        await write(AGENT, lines(user(), assistant(), assistant('copied', 999, fields)));
        const stats = await store.getAgentStats(ID, AGENT);
        assert.equal(stats.status, 'incomplete', JSON.stringify(fields));
        assert.equal(stats.totalTokens, 0); assert.equal(stats.steps, 0);
    }
});

test('corrupt or oversized complete child rows fail the whole sample closed', async t => {
    for (const content of ['{bad}\n', JSON.stringify({ content: 'x'.repeat(8 * 1024 * 1024) }) + '\n']) {
        const { store, write } = await setup(t);
        await write(AGENT, lines(user(), assistant()) + content);
        const stats = await store.getAgentStats(ID, AGENT);
        assert.equal(stats.status, 'incomplete'); assert.equal(stats.totalTokens, 0);
    }
});

test('unsafe IDs never traverse paths and missing children return not-found', async t => {
    const { store } = await setup(t);
    assert.equal((await store.getAgentStats(ID, AGENT)).status, 'not-found');
    for (const agentId of ['../outside', 'a/b', 'a\\b', 'a.b', '', 'x'.repeat(65), '\u8ba1\u7b97', null]) {
        assert.equal((await store.getAgentStats(ID, agentId)).status, 'unavailable');
    }
    assert.equal((await store.getAgentStats('../parent', AGENT)).status, 'unavailable');
    assert.deepEqual(await store.listAgents(OTHER), []);
    await assert.rejects(store.listAgents('../parent'));
});

test('directory listing is deterministic, direct-only, and fails instead of truncating at its bound', async t => {
    const { store, write, subagents } = await setup(t);
    await write('z'); await write('A'); await write('m_1');
    await fs.mkdir(path.join(subagents, 'nested')); await fs.writeFile(path.join(subagents, 'notes.txt'), 'ignore');
    assert.deepEqual(await store.listAgents(ID), ['A', 'm_1', 'z']);
    await Promise.all(Array.from({ length: 126 }, (_, i) => write(`child-${i}`)));
    await assert.rejects(store.listAgents(ID), /limit/i);
});

test('agent cache eviction cannot carry one agents totals into another', async t => {
    const { store, write } = await setup(t);
    for (let i = 0; i < 33; i++) {
        const agentId = `agent-${i}`;
        await write(agentId, lines(assistant('response', i, { agentId })));
        assert.equal((await store.getAgentStats(ID, agentId)).totalTokens, 100 + i);
    }
    await write('agent-0', lines(assistant('replaced', 77, { agentId: 'agent-0' })));
    assert.equal((await store.getAgentStats(ID, 'agent-0')).totalTokens, 177);
});

test('child reads and listings require current workspace context before and after sampling', async t => {
    const { store, write, home } = await setup(t);
    await write();
    const context = { workspaceRoot: home, verify: async () => false };
    assert.equal((await store.getAgentStats(ID, AGENT, context)).status, 'unavailable');
    await assert.rejects(store.listAgents(ID, context));
    let calls = 0;
    const changes = { workspaceRoot: home, verify: async () => ++calls === 1 };
    assert.equal((await store.getAgentStats(ID, AGENT, changes)).status, 'unavailable');
    calls = 0; await assert.rejects(store.listAgents(ID, changes));
    store.dispose();
    assert.equal((await store.getAgentStats(ID, AGENT)).status, 'unavailable');
    await assert.rejects(store.listAgents(ID));
});

test('duplicate parent sources use the same proven migration source for child paths', async t => {
    const { home, directory, store, write, parent } = await setup(t);
    const workspaceRoot = path.join(home, 'workspace'); await fs.mkdir(workspaceRoot);
    const prefix = lines(assistant('parent', 900, { isSidechain: false, agentId: undefined }),
        { type: 'relocated', sessionId: ID, relocatedCwd: workspaceRoot });
    await fs.writeFile(parent, prefix);
    const other = path.join(home, 'projects', 'other'); await fs.mkdir(other);
    await fs.writeFile(path.join(other, `${ID}.jsonl`), prefix + lines({ type: 'metadata' }));
    const otherAgents = path.join(other, ID, 'subagents'); await fs.mkdir(otherAgents, { recursive: true });
    await fs.writeFile(path.join(otherAgents, `agent-${AGENT}.jsonl`), lines(user(), assistant('selected', 55)));
    await write(AGENT, lines(user(), assistant('stale', 999)));
    const context = { workspaceRoot, verify: async () => true };
    assert.equal((await store.getAgentStats(ID, AGENT, context)).totalTokens, 155);
    assert.equal((await store.getAgentStats(ID, AGENT)).status, 'incomplete');
    await assert.rejects(store.listAgents(ID), /Incomplete/);
    assert.deepEqual(await store.listAgents(ID, context), [AGENT]);
    assert.equal(path.dirname(parent), directory);
});

test('linked child files are rejected by reads and discovery', async t => {
    const { store, write, subagents, home } = await setup(t);
    const outside = path.join(home, 'outside.jsonl');
    await fs.writeFile(outside, lines(user(), assistant('foreign', 999)));
    await fs.link(outside, path.join(subagents, `agent-${AGENT}.jsonl`));
    assert.equal((await store.getAgentStats(ID, AGENT)).status, 'unavailable');
    await assert.rejects(store.listAgents(ID), /Unsafe/);
    await fs.unlink(path.join(subagents, `agent-${AGENT}.jsonl`));
    await write();
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 140);
});

test('junction or symlink directories cannot redirect subagent reads or discovery', async t => {
    for (const target of ['subagents', 'session', 'projects']) {
        const { store, write, subagents, home } = await setup(t);
        await write();
        const directory = target === 'subagents' ? subagents : target === 'session'
            ? path.dirname(subagents) : path.join(home, 'projects');
        const moved = path.join(home, `redirected-${target}`);
        await fs.rename(directory, moved);
        await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
        assert.equal((await store.getAgentStats(ID, AGENT)).status, 'unavailable', target);
        await assert.rejects(store.listAgents(ID), /Unsafe/, target);
    }
});

test('a parent source change during child ingestion cannot expose cached or newly read totals', async t => {
    const nativeFs = require('node:fs');
    const { createMetrics } = require('../src/metrics.cjs');
    let parent;
    let mutate = false;
    const { store, write, parent: parentFile } = await setup(t, {
        createMetrics: (sessionId, agentId) => {
            const metrics = createMetrics({ sessionId, agentId });
            return { snapshot: metrics.snapshot, ingest: row => {
                metrics.ingest(row);
                if (mutate) nativeFs.appendFileSync(parent, lines({ type: 'metadata' }));
            } };
        }
    });
    parent = parentFile;
    const file = await write();
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 140);
    await fs.appendFile(file, lines(assistant('next', 5)));
    mutate = true;
    const stats = await store.getAgentStats(ID, AGENT);
    assert.equal(stats.status, 'incomplete'); assert.equal(stats.totalTokens, 0);
    mutate = false;
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 245);
});

test('rewritten child guards invalidate cached metrics even when the file also grows', async t => {
    const { store, write } = await setup(t);
    const file = await write();
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 140);
    await fs.writeFile(file, lines(user(), assistant('answer', 2), assistant('second', 8)));
    const stats = await store.getAgentStats(ID, AGENT);
    assert.equal(stats.totalTokens, 210); assert.equal(stats.outputTokens, 10);
});

test('a malformed agent filename makes discovery fail without returning a partial index', async t => {
    const { store, write, subagents } = await setup(t);
    await write();
    await fs.writeFile(path.join(subagents, 'agent-invalid.id.jsonl'), lines(user(), assistant()));
    await assert.rejects(store.listAgents(ID), /Unsafe/);
});

test('child replacement during final workspace confirmation discards the completed sample', async t => {
    const { store, write, home } = await setup(t);
    const file = await write();
    let checks = 0;
    const context = { workspaceRoot: home, verify: async () => {
        if (++checks === 4) await fs.writeFile(file, lines(user(), assistant('replacement', 99)));
        return true;
    } };
    const stats = await store.getAgentStats(ID, AGENT, context);
    assert.equal(stats.status, 'unavailable'); assert.equal(stats.totalTokens, 0);
    assert.equal((await store.getAgentStats(ID, AGENT, context)).totalTokens, 199);
});

test('discovery changes during its final workspace proof never return a partial list', async t => {
    const { store, write, home } = await setup(t);
    await write();
    let checks = 0;
    const context = { workspaceRoot: home, verify: async () => {
        if (++checks === 3) await write('new-agent', lines(user({ agentId: 'new-agent' })));
        return true;
    } };
    await assert.rejects(store.listAgents(ID, context), /changed/);
    assert.deepEqual(await store.listAgents(ID, context), [AGENT, 'new-agent']);
});
