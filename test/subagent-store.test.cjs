'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSubagentStore } = require('../src/subagent-store.cjs');
const { createMetrics } = require('../src/metrics.cjs');
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
    for (let i = 0; i < 257; i++) {
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
        if (++checks === 2) await fs.writeFile(file, lines(user(), assistant('replacement', 99)));
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
        if (++checks === 2) await write('new-agent', lines(user({ agentId: 'new-agent' })));
        return true;
    } };
    await assert.rejects(store.listAgents(ID, context), /changed/);
    assert.deepEqual(await store.listAgents(ID, context), [AGENT, 'new-agent']);
});

test('a bounded child batch shares one parent location and pre/post source proof', async t => {
    const { home, parent, write } = await setup(t);
    const agents = Array.from({ length: 8 }, (_, i) => `batch-${i}`);
    for (const agent of agents) await write(agent, lines(assistant(agent, 40, { agentId: agent })));
    let locations = 0, proofs = 0;
    const store = createSubagentStore({ claudeHome: home,
        createMetrics: (sessionId, agentId) => createMetrics({ sessionId, agentId }),
        locateSource: async () => { locations++; return { path: parent, verify: async () => { proofs++; return true; } }; } });
    t.after(() => store.dispose());
    const samples = await store.getAgentStatsBatch(ID, agents);
    assert.deepEqual(samples.map(stats => [stats.agentId, stats.status, stats.totalTokens]),
        agents.map(agent => [agent, 'ok', 140]));
    assert.equal(locations, 1);
    assert.equal(proofs, 2);
});

test('child batches preserve duplicate positions, isolate bad children, and reject oversized requests before I/O', async t => {
    const { store, write } = await setup(t);
    await write();
    await write('bad', '{bad}\n');
    const samples = await store.getAgentStatsBatch(ID, [AGENT, 'bad', AGENT, '../unsafe', 'missing']);
    assert.deepEqual(samples.map(stats => stats.status), ['ok', 'incomplete', 'ok', 'unavailable', 'not-found']);
    assert.deepEqual(samples[0], samples[2]);
    assert.equal(samples[1].totalTokens, 0);
    assert.deepEqual(await store.getAgentStatsBatch('../parent', []), []);
    assert.equal((await store.getAgentStatsBatch('../parent', [AGENT]))[0].status, 'unavailable');
    for (const invalid of [undefined, null, 'agents', {}]) await assert.rejects(store.getAgentStatsBatch(ID, invalid), TypeError);
    await assert.rejects(store.getAgentStatsBatch(ID, Array(9).fill(AGENT)), RangeError);
});

test('a changed earlier child is rejected at batch completion while an unaffected sibling stays usable', async t => {
    const nativeFs = require('node:fs');
    let first, change = true;
    const { store, write } = await setup(t, { createMetrics: (sessionId, agentId) => {
        const metrics = createMetrics({ sessionId, agentId });
        return { snapshot: metrics.snapshot, ingest: row => {
            metrics.ingest(row);
            if (agentId === 'second' && change) {
                change = false;
                nativeFs.writeFileSync(first, lines(user(), assistant('replacement', 99)));
            }
        } };
    } });
    first = await write();
    await write('second', lines(assistant('second', 5, { agentId: 'second' })));
    const samples = await store.getAgentStatsBatch(ID, [AGENT, 'second']);
    assert.equal(samples[0].status, 'unavailable'); assert.equal(samples[0].totalTokens, 0);
    assert.equal(samples[1].status, 'ok'); assert.equal(samples[1].totalTokens, 105);
    assert.equal((await store.getAgentStats(ID, AGENT)).totalTokens, 199);
});

test('parent appends during a child batch invalidate every child without retaining tentative metrics', async t => {
    const nativeFs = require('node:fs');
    let parent, mutate = true;
    const { store, write, parent: parentFile } = await setup(t, { createMetrics: (sessionId, agentId) => {
        const metrics = createMetrics({ sessionId, agentId });
        return { snapshot: metrics.snapshot, ingest: row => {
            metrics.ingest(row);
            if (mutate) nativeFs.appendFileSync(parent, lines({ type: 'metadata' }));
        } };
    } });
    parent = parentFile;
    await write(); await write('second', lines(assistant('second', 5, { agentId: 'second' })));
    const samples = await store.getAgentStatsBatch(ID, [AGENT, 'second']);
    assert.deepEqual(samples.map(stats => [stats.status, stats.totalTokens]), [['incomplete', 0], ['incomplete', 0]]);
    mutate = false;
    assert.deepEqual((await store.getAgentStatsBatch(ID, [AGENT, 'second'])).map(stats => stats.totalTokens), [140, 105]);
});

test('workspace changes during ingestion and dispose during late proof completion cannot publish a batch', async t => {
    let valid = true;
    const fixture = await setup(t, { createMetrics: (sessionId, agentId) => {
        const metrics = createMetrics({ sessionId, agentId });
        return { snapshot: metrics.snapshot, ingest: row => { metrics.ingest(row); valid = false; } };
    } });
    await fixture.write();
    const context = { workspaceRoot: fixture.home, verify: async () => valid };
    assert.equal((await fixture.store.getAgentStatsBatch(ID, [AGENT], context))[0].status, 'unavailable');
    let verifyCount = 0, begin, release;
    const started = new Promise(resolve => { begin = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const store = createSubagentStore({ claudeHome: fixture.home,
        createMetrics: (sessionId, agentId) => createMetrics({ sessionId, agentId }),
        locateSource: async () => ({ path: fixture.parent, verify: async () => {
            if (++verifyCount === 2) { begin(); await gate; }
            return true;
        } }) });
    t.after(() => store.dispose());
    const pending = store.getAgentStatsBatch(ID, [AGENT]);
    await started; store.dispose(); release();
    assert.equal((await pending)[0].status, 'unavailable');
    assert.equal((await store.getAgentStatsBatch(ID, [AGENT]))[0].status, 'unavailable');
});

test('the child cache retains both active families instead of rereading beyond thirty-two agents', async t => {
    const ingested = new Map();
    const { store, write } = await setup(t, { createMetrics: (sessionId, agentId) => {
        const metrics = createMetrics({ sessionId, agentId });
        return { snapshot: metrics.snapshot, ingest: row => {
            ingested.set(agentId, (ingested.get(agentId) || 0) + 1); metrics.ingest(row);
        } };
    } });
    const agents = Array.from({ length: 57 }, (_, i) => `retained-${i}`);
    for (const agent of agents) await write(agent, lines(assistant(agent, 40, { agentId: agent })));
    for (let pass = 0; pass < 2; pass++) for (let start = 0; start < agents.length; start += 8) {
        const samples = await store.getAgentStatsBatch(ID, agents.slice(start, start + 8));
        assert.ok(samples.every(stats => stats.status === 'ok' && stats.totalTokens === 140));
    }
    assert.ok([...ingested.values()].every(count => count === 1));
    assert.equal(ingested.size, 57);
});

test('idle incomplete rows have an aggregate cache budget while completed metrics remain incremental', async t => {
    const created = new Map();
    const { store, write } = await setup(t, { createMetrics: (sessionId, agentId) => {
        created.set(agentId, (created.get(agentId) || 0) + 1);
        return createMetrics({ sessionId, agentId });
    } });
    const agents = ['partial-a', 'partial-b', 'partial-c'];
    const partial = '{"unfinished":"' + 'x'.repeat(6 * 1024 * 1024);
    for (const agent of agents) await write(agent, lines(assistant(agent, 40, { agentId: agent })) + partial);
    assert.ok((await store.getAgentStatsBatch(ID, agents)).every(stats => stats.totalTokens === 140));
    assert.equal(created.get(agents[0]), 1);
    assert.equal((await store.getAgentStats(ID, agents[0])).totalTokens, 140);
    assert.equal(created.get(agents[0]), 2);
});

test('overlapping batch and single reads share the same child reader without sharing caller proof', { timeout: 5000 }, async t => {
    const { store, write, subagents } = await setup(t);
    const file = await write();
    await write('second', lines(assistant('second', 5, { agentId: 'second' })));
    let opened, release;
    const started = new Promise(resolve => { opened = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const open = fs.open, realpath = fs.realpath;
    let opens = 0, directoryChecks = 0;
    t.mock.method(fs, 'open', async (target, ...args) => {
        const handle = await open(target, ...args);
        if (target === file) { opens++; opened(); await gate; }
        return handle;
    });
    t.mock.method(fs, 'realpath', async (...args) => {
        const resolved = await realpath(...args);
        if (args[0] === subagents && ++directoryChecks === 2) setImmediate(release);
        return resolved;
    });
    const batch = store.getAgentStatsBatch(ID, [AGENT, 'second']);
    await started;
    const single = store.getAgentStats(ID, AGENT);
    const [samples, sample] = await Promise.all([batch, single]);
    assert.equal(opens, 1);
    assert.deepEqual(samples[0], sample);
    assert.deepEqual(samples.map(stats => stats.totalTokens), [140, 105]);
});

test('one parent waiting for child I/O does not block a different parent batch', { timeout: 5000 }, async t => {
    const { store, write, directory } = await setup(t);
    const file = await write();
    const otherDirectory = path.join(directory, OTHER, 'subagents');
    await fs.mkdir(otherDirectory, { recursive: true });
    await fs.writeFile(path.join(directory, `${OTHER}.jsonl`), lines({ type: 'metadata' }));
    await fs.writeFile(path.join(otherDirectory, `agent-${AGENT}.jsonl`),
        lines(assistant('other-parent', 5, { sessionId: OTHER })));
    let opened, release;
    const started = new Promise(resolve => { opened = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const open = fs.open;
    t.mock.method(fs, 'open', async (target, ...args) => {
        const handle = await open(target, ...args);
        if (target === file) { opened(); await gate; }
        return handle;
    });
    const blocked = store.getAgentStatsBatch(ID, [AGENT]);
    await started;
    try {
        const other = await store.getAgentStatsBatch(OTHER, [AGENT]);
        assert.equal(other[0].status, 'ok'); assert.equal(other[0].totalTokens, 105);
    }
    finally { release(); }
    assert.equal((await blocked)[0].totalTokens, 140);
});

test('a replaced child directory cannot combine old-family and new-family metrics', async t => {
    const { store, write, subagents, home } = await setup(t);
    await write(); await write('second', lines(assistant('second', 5, { agentId: 'second' })));
    let checks = 0;
    const context = { workspaceRoot: home, verify: async () => {
        if (++checks === 2) {
            await fs.rename(subagents, path.join(home, 'previous-subagents'));
            await fs.mkdir(subagents);
            await write(AGENT, lines(assistant('new-first', 99)));
            await write('second', lines(assistant('new-second', 105, { agentId: 'second' })));
        }
        return true;
    } };
    const samples = await store.getAgentStatsBatch(ID, [AGENT, 'second'], context);
    assert.deepEqual(samples.map(stats => [stats.status, stats.totalTokens]), [['ok', 199], ['ok', 205]]);
});

test('dispose during the final child version check rejects the late completed batch', { timeout: 5000 }, async t => {
    const { store, write } = await setup(t);
    const file = await write();
    let begin, release, checks = 0;
    const started = new Promise(resolve => { begin = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const realpath = fs.realpath;
    t.mock.method(fs, 'realpath', async (...args) => {
        const resolved = await realpath(...args);
        if (args[0] === file && ++checks === 3) { begin(); await gate; }
        return resolved;
    });
    const pending = store.getAgentStatsBatch(ID, [AGENT]);
    await started; store.dispose(); release();
    const samples = await pending;
    assert.equal(samples[0].status, 'unavailable'); assert.equal(samples[0].totalTokens, 0);
});

test('batch and discovery use only fresh operation boundary context proofs even for duplicate sources', async t => {
    for (const duplicate of [false, true]) {
        const { store, write, home, parent } = await setup(t);
        const agents = Array.from({ length: 8 }, (_, i) => `boundary-${i}`);
        for (const agent of agents) await write(agent, lines(assistant(agent, 40, { agentId: agent })));
        if (duplicate) {
            const prefix = lines({ type: 'relocated', sessionId: ID, relocatedCwd: home });
            await fs.writeFile(parent, prefix);
            const other = path.join(home, 'projects', 'other');
            const children = path.join(other, ID, 'subagents');
            await fs.mkdir(children, { recursive: true });
            await fs.writeFile(path.join(other, `${ID}.jsonl`), prefix + lines({ type: 'metadata' }));
            for (const agent of agents) await fs.writeFile(path.join(children, `agent-${agent}.jsonl`),
                lines(assistant(agent, 55, { agentId: agent })));
        }
        let checks = 0;
        const context = { workspaceRoot: home, verify: async () => { checks++; return true; } };
        for (const action of ['cold', 'warm', 'discovery']) {
            checks = 0;
            if (action === 'discovery') assert.deepEqual(await store.listAgents(ID, context), agents);
            else assert.ok((await store.getAgentStatsBatch(ID, agents, context))
                .every(stats => stats.status === 'ok' && stats.totalTokens === (duplicate ? 155 : 140)));
            assert.equal(checks, 2, `${duplicate ? 'duplicate' : 'unique'} ${action}`);
        }
    }
});

test('operation contexts expire after success or failure and cannot poison the next source lookup', async t => {
    const { home, parent, write } = await setup(t);
    await write();
    const contexts = [];
    let fail = false;
    const store = createSubagentStore({ claudeHome: home,
        createMetrics: (sessionId, agentId) => createMetrics({ sessionId, agentId }),
        locateSource: async (_id, context) => {
            contexts.push(context);
            if (fail) throw new Error('lookup failed');
            return { path: parent, verify: () => context.verify() };
        } });
    t.after(() => store.dispose());
    const context = { workspaceRoot: home, verify: async () => true };
    assert.equal((await store.getAgentStatsBatch(ID, [AGENT], context))[0].status, 'ok');
    assert.notEqual(contexts[0], context);
    assert.equal(await contexts[0].verify(), false);
    fail = true;
    assert.equal((await store.getAgentStatsBatch(ID, [AGENT], context))[0].status, 'unavailable');
    assert.equal(await contexts[1].verify(), false);
    fail = false;
    assert.deepEqual(await store.listAgents(ID, context), [AGENT]);
    assert.equal(await contexts[2].verify(), false);
    assert.equal(await contexts[0].verify(), false);
});

test('replacing a workspace root or verification function during the operation invalidates its sample', async t => {
    for (const field of ['workspaceRoot', 'verify', 'resolveRelocation']) {
        let context;
        const { store, write, home } = await setup(t, { createMetrics: (sessionId, agentId) => {
            const metrics = createMetrics({ sessionId, agentId });
            return { snapshot: metrics.snapshot, ingest: row => {
                metrics.ingest(row);
                context[field] = field === 'workspaceRoot' ? path.join(home, 'other') : async () => true;
            } };
        } });
        await write();
        context = { workspaceRoot: home, verify: async () => true, resolveRelocation: async () => null };
        const stats = (await store.getAgentStatsBatch(ID, [AGENT], context))[0];
        assert.equal(stats.status, 'unavailable', field); assert.equal(stats.totalTokens, 0);
    }
});

test('a source confirmation that changes the external binding cannot pass the final operation boundary', async t => {
    for (const action of ['batch', 'discovery']) {
        const { home, parent, write } = await setup(t);
        await write();
        let valid = true, sourceChecks = 0;
        const store = createSubagentStore({ claudeHome: home,
            createMetrics: (sessionId, agentId) => createMetrics({ sessionId, agentId }),
            locateSource: async () => ({ path: parent, verify: async () => {
                if (++sourceChecks === 2) valid = false;
                return true;
            } }) });
        t.after(() => store.dispose());
        const context = { workspaceRoot: home, verify: async () => valid };
        if (action === 'discovery') await assert.rejects(store.listAgents(ID, context));
        else assert.equal((await store.getAgentStatsBatch(ID, [AGENT], context))[0].status, 'unavailable');
    }
});

test('parent and duplicate peer versions are rechecked after the final binding callback', async t => {
    for (const duplicate of [false, true]) for (const action of ['batch', 'discovery']) {
        const { store, write, home, parent } = await setup(t);
        await write();
        if (duplicate) {
            const prefix = lines({ type: 'relocated', sessionId: ID, relocatedCwd: home });
            await fs.writeFile(parent, prefix);
            const other = path.join(home, 'projects', 'other');
            const children = path.join(other, ID, 'subagents');
            await fs.mkdir(children, { recursive: true });
            await fs.writeFile(path.join(other, `${ID}.jsonl`), prefix + lines({ type: 'metadata' }));
            await fs.writeFile(path.join(children, `agent-${AGENT}.jsonl`), lines(user(), assistant()));
        }
        let checks = 0;
        const context = { workspaceRoot: home, verify: async () => {
            if (++checks % 2 === 0) await fs.appendFile(parent, lines({ type: 'metadata', changed: checks }));
            return true;
        } };
        if (action === 'discovery') await assert.rejects(store.listAgents(ID, context));
        else assert.notEqual((await store.getAgentStatsBatch(ID, [AGENT], context))[0].status, 'ok');
    }
});
