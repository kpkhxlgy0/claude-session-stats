'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const BIRTH = '134375438415690102';
const STATS = { turns: 2, steps: 3, totalTokens: 100, inputTokens: 60, outputTokens: 40,
    cachedInputTokens: 20, cacheHit: 1 / 3, tps: 4, usageComplete: true, status: 'ok' };

test('a 515-target history remains idle and computes only the two visible interests', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-scan-load-')));
    const claudeHome = path.join(root, 'home'), claudeData = path.join(root, 'desktop');
    const workspace = path.join(root, 'workspace'), sessions = path.join(claudeHome, 'sessions');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG);
    for (const directory of [workspace, sessions, metadata]) await fs.mkdir(directory, { recursive: true });
    let publisher;
    t.after(async () => { await publisher?.stop(); await fs.rm(root, { recursive: true, force: true }); });
    const parents = Array.from({ length: 26 }, (_, index) => {
        const suffix = (index + 1).toString(16).padStart(12, '0');
        return { cliSessionId: `33333333-3333-4333-8333-${suffix}`,
            localSessionId: `local_44444444-4444-4444-8444-${suffix}`,
            bridgeSessionId: `session_parent${index}`,
            agents: Array.from({ length: index < 21 ? 19 : 18 }, (_, child) => `child${child}`) };
    });
    for (const parent of parents) await fs.writeFile(path.join(metadata, `${parent.localSessionId}.json`), JSON.stringify({
        sessionId: parent.localSessionId, cliSessionId: parent.cliSessionId, cwd: workspace,
        bridgeSessionIds: [parent.bridgeSessionId] }));
    const processes = new Map();
    for (let index = 0; index < 2; index++) {
        const parent = parents[index], pid = 101 + index;
        processes.set(pid, { alive: true, procStart: BIRTH });
        await fs.writeFile(path.join(sessions, `${pid}.json`), JSON.stringify({ pid, sessionId: parent.cliSessionId,
            hostSessionId: parent.localSessionId, bridgeSessionId: parent.bridgeSessionId,
            procStart: BIRTH, pidDomain: 'win32:fixture-host', startedAt: 1, cwd: workspace }));
    }
    let registryScans = 0, metadataScans = 0, publications = 0;
    const opendir = fs.opendir, rename = fs.rename, open = fs.open;
    t.mock.method(fs, 'opendir', async (directory, ...args) => {
        if (directory === sessions) registryScans++;
        if (directory === path.join(claudeData, 'claude-code-sessions')) metadataScans++;
        return opendir(directory, ...args);
    });
    t.mock.method(fs, 'rename', async (...args) => { publications++; return rename(...args); });
    // Native file completions arrive in different callbacks. Keep that boundary
    // instead of starting every proof in one synchronous Promise.all cohort.
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (path.dirname(file) === path.join(claudeHome, '.session-stats'))
            await new Promise(resolve => setImmediate(resolve));
        return handle;
    });
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        processCacheMs: 2000, getProcessIdentities: async () => processes });
    const byCli = new Map(parents.map(parent => [parent.cliSessionId, parent]));
    const verified = async context => { assert.equal(await context.verify(), true); };
    const store = {
        async getStats(id, context) {
            await verified(context); await fs.stat(workspace); await verified(context);
            return { ...STATS, threadId: id };
        },
        async listAgents(id, context) {
            await verified(context); await fs.stat(workspace); await verified(context);
            return byCli.get(id).agents;
        },
        async getAgentStats(id, agentId, context) {
            await verified(context); return { ...STATS, threadId: id, agentId };
        },
        async getAgentStatsBatch(id, agents, context) {
            await verified(context); await fs.stat(workspace); await verified(context);
            return agents.map(agentId => ({ ...STATS, threadId: id, agentId }));
        },
    };
    let time = 100000;
    publisher = createSnapshotPublisher({ claudeHome, claudeData, store, resolveWorkspace,
        pollMs: 100000, now: () => time });
    await publisher.start();
    assert.equal(publications, 0);
    assert.equal(registryScans, 0);
    assert.equal(metadataScans, 0);
    publisher.setInterest('windowA', [{ localSessionId: parents[0].localSessionId },
        { localSessionId: parents[0].localSessionId, agentId: 'child0' }]);
    await publisher.start();
    assert.equal((await fs.readdir(path.join(claudeHome, '.session-stats'))).length, 2);
    assert.equal(publications, 2);
    const before = { registryScans, metadataScans, publications };
    publisher.releaseInterest('windowA');
    await publisher.start(); await publisher.start();
    assert.equal(registryScans, before.registryScans);
    assert.equal(metadataScans, before.metadataScans);
    assert.equal(publications, before.publications);
});
