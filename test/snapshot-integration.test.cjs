'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createMetadataPublisher } = require('../src/metadata-publisher.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createRemoteReader } = require('../src/remote-reader.cjs');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');
const { startMain } = require('../src/main.cjs');
const { createMetadataApi } = require('./helpers/metadata-api.cjs');

const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_Integration123';
function turn(id, seconds, output) {
    const timestamp = n => new Date(Date.UTC(2026, 9, 24, 0, 0, n)).toISOString();
    return [{ type: 'user', sessionId: CLI, uuid: 'user-' + id, parentUuid: null, timestamp: timestamp(seconds),
        message: { role: 'user', content: 'fixture' } },
    { type: 'assistant', sessionId: CLI, uuid: 'assistant-' + id, parentUuid: 'user-' + id, timestamp: timestamp(seconds + 10),
        message: { role: 'assistant', id, usage: { input_tokens: 10, cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70, output_tokens: output } } }].map(r => JSON.stringify(r) + '\n').join('');
}

for (const moved of [false, true, 'duplicate']) test(`local JSONL, metadata publisher and RC receiver share successive samples (CLI moved=${moved})`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-integration-')));
    const workspace = path.join(root, 'workspace'), claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config');
    const destination = path.join(claudeHome, '.session-stats', BRIDGE + '.json');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG);
    const logs = path.join(claudeHome, 'projects', 'fixture');
    await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(metadata, { recursive: true }),
        fs.mkdir(logs, { recursive: true })]);
    await fs.writeFile(path.join(metadata, LOCAL + '.json'), JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: workspace, originCwd: workspace, bridgeSessionIds: [BRIDGE], isArchived: false }));
    const active = moved ? path.join(workspace, 'current-directory') : workspace;
    const registry = path.join(claudeHome, 'sessions', '101.json');
    const registryRow = { pid: 101, sessionId: CLI, hostSessionId: LOCAL, bridgeSessionId: BRIDGE, cwd: active,
        startedAt: 1000, procStart: '123456', pidDomain: 'win32:fixture-host' };
    if (moved) {
        await fs.mkdir(active);
        await fs.mkdir(path.join(claudeHome, 'sessions'));
        await fs.writeFile(registry, JSON.stringify(registryRow));
    }
    const log = path.join(logs, CLI + '.jsonl');
    const marker = moved === 'duplicate' ? JSON.stringify({ type: 'relocated', sessionId: CLI, relocatedCwd: active }) + '\n' : '';
    await fs.writeFile(log, marker + turn('m1', 0, 40));
    const agentId = 'child_A', childDirectory = path.join(logs, CLI, 'subagents');
    const childRow = JSON.stringify({ type: 'assistant', sessionId: CLI, uuid: 'child-assistant',
        agentId, isSidechain: true, message: { role: 'assistant', id: 'child-message', usage: {
            input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 } } }) + '\n';
    const childFile = path.join(childDirectory, `agent-${agentId}.jsonl`);
    await fs.mkdir(childDirectory, { recursive: true });
    await fs.writeFile(childFile, childRow);
    let duplicate;
    if (moved === 'duplicate') {
        const directory = path.join(claudeHome, 'projects', 'earlier-copy');
        await fs.mkdir(directory);
        duplicate = path.join(directory, CLI + '.jsonl');
        await fs.writeFile(duplicate, marker);
    }
    let time = 100000;
    const store = createSessionStore({ claudeHome });
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        getProcessIdentities: async () => new Map([[101, { alive: true, procStart: '123456' }]]) });
    const publisher = createSnapshotPublisher({ claudeData, claudeHome, store, resolveWorkspace, now: () => time, pollMs: 600000 });
    const metadataApi = createMetadataApi({ bridgeSessionId: BRIDGE, organizationId: ORG, accountId: ACCOUNT,
        responseShape: moved === true ? 'response_shape' : 'session' });
    const metadataPublisher = createMetadataPublisher({ source: publisher, fetch: metadataApi.writerFetch,
        now: () => time, pollMs: 600000 });
    const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: 'https://claude.ai/code/' + BRIDGE });
    const editor = dom.window.document.querySelector('.ProseMirror');
    editor.getClientRects = () => [{ width: 100 }];
    editor.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
    dom.window.fetch = metadataApi.readerFetch;
    const receiver = createRemoteReader(dom.window, createSnapshotProtocol,
        { now: () => time, pollMs: 0, errorBackoffMs: 0 });
    const childReceiver = createRemoteReader(dom.window, createSnapshotProtocol, { now: () => time,
        pollMs: 0, errorBackoffMs: 0,
        resolveAgent: () => ({ sessionId: BRIDGE, agentId, remote: true }) });
    t.after(async () => { receiver.stop(); childReceiver.stop(); dom.window.close();
        await metadataPublisher.stop(); await publisher.stop(); store.dispose(); await fs.rm(root, { recursive: true }); });
    await publisher.start();
    const fields = ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheHit', 'tps',
        'usageComplete', 'snapshotGeneratedAt', 'snapshotRevision', 'snapshotPublisherId'];
    const local = await publisher.readLocal(LOCAL);
    const unpublished = await receiver.read();
    assert.equal(unpublished.status, 'unavailable');
    assert.equal(unpublished.totalTokens, null);
    await metadataPublisher.start();
    const remote = await receiver.read();
    assert.equal(local.tps, 4); assert.equal(local.totalTokens, 140);
    for (const field of fields) assert.equal(remote[field], local[field], field);
    assert.equal(remote.status, 'ok');
    assert.equal(metadataApi.writes().length, 1);
    assert.deepEqual(metadataApi.envelope().parent, JSON.parse(await fs.readFile(destination, 'utf8')));
    for (const duplicateChild of [false, true]) {
        if (duplicateChild) { time += 10000; await fs.appendFile(childFile, childRow); }
        await publisher.start();
        const childLocal = await publisher.readLocal(LOCAL, { agentId });
        await metadataPublisher.start();
        const childRemote = await childReceiver.read();
        assert.equal(childRemote.status, 'ok');
        assert.equal(childRemote.agentId, agentId);
        assert.equal(childRemote.totalTokens, 10);
        assert.equal(childRemote.outputTokens, 0);
        assert.equal(childRemote.steps, 1);
        assert.equal(childRemote.tps, null);
        for (const field of fields) assert.equal(childRemote[field], childLocal[field], field);
        assert.equal(metadataApi.envelope().parent.stats.totalTokens, 140);
        assert.equal(metadataApi.envelope().agents.length, 1);
        assert.deepEqual(metadataApi.envelope().agents[0], JSON.parse(await fs.readFile(
            path.join(claudeHome, '.session-stats', `${BRIDGE}.agent-${agentId}.json`), 'utf8')));
        const writes = metadataApi.writes().length;
        assert.deepEqual(await childReceiver.read(), childRemote);
        await metadataPublisher.start();
        assert.equal(metadataApi.writes().length, writes);
    }
    time += 10000;
    await fs.appendFile(log, turn('m2', 20, 60));
    await publisher.start();
    const nextLocal = await publisher.readLocal(LOCAL);
    await metadataPublisher.start();
    const nextRemote = await receiver.read();
    assert.equal(nextLocal.tps, 5); assert.equal(nextLocal.totalTokens, 300);
    assert.ok(nextLocal.snapshotRevision > local.snapshotRevision);
    for (const field of fields) assert.equal(nextRemote[field], nextLocal[field], field);
    if (moved) {
        const migrated = path.join(workspace, 'next-directory');
        await fs.mkdir(migrated);
        for (const cwd of [migrated, workspace]) {
            time += 10000;
            await fs.writeFile(registry, JSON.stringify({ ...registryRow, cwd }));
            await publisher.start();
            const relocatedLocal = await publisher.readLocal(LOCAL);
            await metadataPublisher.start();
            const relocatedRemote = await receiver.read();
            assert.equal(relocatedLocal.status, 'ok');
            assert.equal(relocatedLocal.totalTokens, 300);
            for (const field of fields) assert.equal(relocatedRemote[field], relocatedLocal[field], field);
            assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).stats.totalTokens, 300);
            await assert.rejects(fs.stat(path.join(cwd, '.claude', 'session-stats')), { code: 'ENOENT' });
        }
    }
    for (const directory of new Set([workspace, active]))
        await assert.rejects(fs.stat(path.join(directory, '.claude', 'session-stats')), { code: 'ENOENT' });
    metadataApi.session.connection_status = 'disconnected';
    const offline = await receiver.read();
    assert.equal(offline.status, 'unavailable'); assert.equal(offline.tps, null);
    assert.equal(offline.unavailableReason, 'offline');
    if (duplicate) {
        const last = structuredClone(metadataApi.envelope());
        await fs.appendFile(duplicate, turn('diverged', 30, 80));
        metadataApi.session.connection_status = 'connected';
        assert.notEqual((await publisher.readLocal(LOCAL)).status, 'ok');
        await metadataPublisher.start();
        assert.deepEqual(metadataApi.envelope(), last);
        time = last.parent.generatedAt + 30001;
        const invalid = await receiver.read();
        assert.equal(invalid.status, 'unavailable');
        assert.equal(invalid.tps, null);
        assert.equal(invalid.unavailableReason, 'snapshot-expired');
    }
});

test('main wires the CLI workspace resolver into its real publisher', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-main-workspace-')));
    const workspace = path.join(root, 'workspace'), active = path.join(workspace, 'child');
    const claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config');
    const destination = path.join(claudeHome, '.session-stats', BRIDGE + '.json');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG);
    await fs.mkdir(active, { recursive: true }); await fs.mkdir(metadata, { recursive: true });
    await fs.mkdir(path.join(claudeHome, 'sessions'), { recursive: true });
    await fs.writeFile(path.join(metadata, LOCAL + '.json'), JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: workspace, bridgeSessionIds: [BRIDGE] }));
    await fs.writeFile(path.join(claudeHome, 'sessions', '101.json'), JSON.stringify({ pid: 101,
        sessionId: CLI, hostSessionId: LOCAL, bridgeSessionId: BRIDGE, cwd: active,
        startedAt: 1000, procStart: '123456', pidDomain: 'win32:fixture-host' }));
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        getProcessIdentities: async () => new Map([[101, { alive: true, procStart: '123456' }]]) });
    const sample = { status: 'ok', turns: 1, steps: 1, totalTokens: 10, inputTokens: 4,
        outputTokens: 6, cachedInputTokens: 0, cacheHit: 0, tps: 3, usageComplete: true };
    let read;
    const controller = startMain({ manifest: { id: 'com.kpk.session-stats' },
        ipc: { handle(name, handler) { if (name === 'stats') read = handler; } }, log: { info() {} } }, {
        claudeData, claudeHome, resolveWorkspace, store: { getStats: async () => sample, dispose() {} },
        metadataPublisher: { start() {}, stop() {} },
        ipcMain: { handle() {}, removeHandler() {} } });
    t.after(async () => { await controller.stop(); await fs.rm(root, { recursive: true, force: true }); });
    let local;
    const deadline = Date.now() + 5000;
    do {
        local = await read(LOCAL);
        if (local.status === 'ok') break;
        await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(local.status, 'ok'); assert.equal(local.tps, 3);
    const published = JSON.parse(await fs.readFile(destination, 'utf8'));
    assert.equal(published.revision, local.snapshotRevision);
    assert.equal(published.stats.tps, local.tps);
    for (const directory of [workspace, active])
        await assert.rejects(fs.stat(path.join(directory, '.claude', 'session-stats')), { code: 'ENOENT' });
    await fs.writeFile(path.join(claudeHome, 'sessions', '101.json'), JSON.stringify({ pid: 101,
        sessionId: CLI, hostSessionId: 'local_conflict', bridgeSessionId: BRIDGE, cwd: active,
        startedAt: 1000, procStart: '123456', pidDomain: 'win32:fixture-host' }));
    const invalid = await read(LOCAL);
    assert.equal(invalid.status, 'unavailable');
    assert.equal(invalid.tps, null);
});

for (const returned of [true, false]) test(`bridge-less registry publishes proven relocated copies (returned=${returned})`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-registry-copies-')));
    const workspace = path.join(root, 'workspace');
    const worktree = path.join(workspace, '.claude', 'worktrees', 'presentation');
    const common = path.join(workspace, '.git');
    const claudeHome = path.join(root, 'config'), claudeData = path.join(root, 'desktop');
    const destination = path.join(claudeHome, '.session-stats', BRIDGE + '.json');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, LOCAL + '.json');
    const registry = path.join(claudeHome, 'sessions', '101.json');
    const first = path.join(claudeHome, 'projects', 'original', CLI + '.jsonl');
    const second = path.join(claudeHome, 'projects', 'worktree-copy', CLI + '.jsonl');
    for (const directory of [worktree, common, ...[metadata, registry, first, second].map(path.dirname)])
        await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), 'gitdir: fixture-only');
    await fs.writeFile(metadata, JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: workspace, bridgeSessionIds: [BRIDGE] }));
    const row = { pid: 101, sessionId: CLI, hostSessionId: LOCAL, cwd: returned ? workspace : worktree,
        startedAt: 1000, procStart: '123456', pidDomain: 'win32:fixture-host' };
    await fs.writeFile(registry, JSON.stringify(row));
    const prefix = turn('m1', 0, 40) + JSON.stringify({ type: 'relocated', sessionId: CLI, relocatedCwd: worktree }) + '\n';
    await fs.writeFile(second, prefix);
    await fs.writeFile(first, prefix + (returned ? turn('m2', 20, 60) : ''));
    let registered = true;
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        processCacheMs: 0, getProcessIdentities: async () => new Map([[101, { alive: true, procStart: '123456' }]]),
        execFile: (_command, args, _options, callback) => {
            if (args.includes('worktree')) return callback(null,
                `worktree ${workspace}\0\0${registered ? `worktree ${worktree}\0\0` : ''}`, '');
            const top = args[1] === worktree ? worktree : workspace;
            callback(null, `${common}\n${top}\n`, '');
        } });
    const store = createSessionStore({ claudeHome });
    const publisher = createSnapshotPublisher({ claudeData, claudeHome, store, resolveWorkspace, pollMs: 600000 });
    t.after(async () => { await publisher.stop(); store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    await publisher.start();
    const local = await publisher.readLocal(LOCAL);
    assert.equal(local.status, 'ok');
    assert.equal(local.totalTokens, returned ? 300 : 140);
    assert.equal(local.steps, returned ? 2 : 1);
    assert.equal(local.tps, returned ? 5 : 4);
    assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).stats.totalTokens, returned ? 300 : 140);
    for (const directory of [workspace, worktree])
        await assert.rejects(fs.stat(path.join(directory, '.claude', 'session-stats')), { code: 'ENOENT' });
    if (returned) {
        registered = false;
        assert.notEqual((await publisher.readLocal(LOCAL)).status, 'ok');
    } else {
        await fs.writeFile(registry, JSON.stringify({ ...row, bridgeSessionId: 'session_conflict' }));
        assert.equal((await publisher.readLocal(LOCAL)).status, 'unavailable');
    }
});
