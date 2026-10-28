'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { createSessionStore } = require('../src/session-store.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createRemoteReader } = require('../src/remote-reader.cjs');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');
const { startMain } = require('../src/main.cjs');

const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_Integration123';
const relative = '.claude/session-stats/session_Integration123.json';
function turn(id, seconds, output) {
    const timestamp = n => new Date(Date.UTC(2026, 9, 24, 0, 0, n)).toISOString();
    return [{ type: 'user', sessionId: CLI, uuid: 'user-' + id, parentUuid: null, timestamp: timestamp(seconds),
        message: { role: 'user', content: 'fixture' } },
    { type: 'assistant', sessionId: CLI, uuid: 'assistant-' + id, parentUuid: 'user-' + id, timestamp: timestamp(seconds + 10),
        message: { role: 'assistant', id, usage: { input_tokens: 10, cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70, output_tokens: output } } }].map(r => JSON.stringify(r) + '\n').join('');
}

for (const moved of [false, true, 'duplicate']) test(`local JSONL, atomic snapshot and RC receiver share successive samples (CLI moved=${moved})`, async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-integration-')));
    const workspace = path.join(root, 'workspace'), claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG);
    const logs = path.join(claudeHome, 'projects', 'fixture');
    await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(metadata, { recursive: true }), fs.mkdir(logs, { recursive: true })]);
    await fs.writeFile(path.join(metadata, LOCAL + '.json'), JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: workspace, originCwd: workspace, bridgeSessionIds: [BRIDGE], isArchived: false }));
    const active = moved ? path.join(workspace, 'current-directory') : workspace;
    if (moved) {
        await fs.mkdir(active);
        await fs.mkdir(path.join(claudeHome, 'sessions'));
        await fs.writeFile(path.join(claudeHome, 'sessions', '101.json'), JSON.stringify({
            pid: 101, sessionId: CLI, hostSessionId: LOCAL, bridgeSessionId: BRIDGE, cwd: active,
            startedAt: 1000, procStart: '123456', pidDomain: 'win32:fixture-host' }));
    }
    const log = path.join(logs, CLI + '.jsonl');
    const marker = moved === 'duplicate' ? JSON.stringify({ type: 'relocated', sessionId: CLI, relocatedCwd: active }) + '\n' : '';
    await fs.writeFile(log, marker + turn('m1', 0, 40));
    let duplicate;
    if (moved === 'duplicate') {
        const directory = path.join(claudeHome, 'projects', 'earlier-copy');
        await fs.mkdir(directory);
        duplicate = path.join(directory, CLI + '.jsonl');
        await fs.writeFile(duplicate, marker);
    }
    let time = 100000, connected = true, sequence = 0;
    const events = [], store = createSessionStore({ claudeHome });
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        getProcessIdentities: async () => new Map([[101, { alive: true, procStart: '123456' }]]) });
    const publisher = createSnapshotPublisher({ claudeData, store, resolveWorkspace, now: () => time, pollMs: 600000 });
    const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: 'https://claude.ai/code/' + BRIDGE });
    const editor = dom.window.document.querySelector('.ProseMirror');
    editor.getClientRects = () => [{ width: 100 }];
    editor.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
    dom.window.fetch = async (raw, init) => {
        const url = new URL(raw); let body;
        assert.equal(url.origin, 'https://claude.ai');
        assert.equal(init.credentials, 'include');
        assert.equal(init.headers['x-organization-uuid'], ORG);
        if (url.pathname === '/v1/code/sessions/' + BRIDGE)
            body = { session: { id: BRIDGE.replace('session_', 'cse_'), environment_kind: 'bridge', connection_status: connected ? 'connected' : 'disconnected' } };
        else {
            assert.equal(url.pathname, '/v1/code/sessions/' + BRIDGE + '/events');
            if (init.method === 'POST') {
                const request = JSON.parse(init.body).events[0].payload;
                assert.equal(request.type, 'control_request');
                assert.deepEqual(request.request, { subtype: 'read_file', path: relative, max_bytes: 16384,
                    encoding: 'utf-8' });
                const contents = await fs.readFile(path.join(active, relative), 'utf8');
                events.push({ sequence_num: ++sequence, payload: { type: 'control_response', response: {
                    request_id: request.request_id, subtype: 'success', response: { contents, absPath: relative } } } });
                body = {};
            } else {
                const after = Number(url.searchParams.get('cursor') ?? 0);
                body = { data: url.searchParams.get('sort_order') === 'desc' ? events.slice(-1) : events.filter(e => e.sequence_num > after), resume_cursor: String(sequence) };
            }
        }
        return { ok: true, text: async () => JSON.stringify(body) };
    };
    const receiver = createRemoteReader(dom.window, createSnapshotProtocol,
        { now: () => time, pollMs: 0, errorBackoffMs: 0, responsePollMs: 0 });
    t.after(async () => { receiver.stop(); dom.window.close(); await publisher.stop(); store.dispose(); await fs.rm(root, { recursive: true }); });
    await publisher.start();
    const fields = ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheHit', 'tps',
        'usageComplete', 'snapshotGeneratedAt', 'snapshotRevision', 'snapshotPublisherId'];
    const local = await publisher.readLocal(LOCAL), remote = await receiver.read();
    assert.equal(local.tps, 4); assert.equal(local.totalTokens, 140);
    for (const field of fields) assert.equal(remote[field], local[field], field);
    assert.equal(remote.status, 'ok');
    time += 1000;
    await fs.appendFile(log, turn('m2', 20, 60));
    const nextLocal = await publisher.readLocal(LOCAL), nextRemote = await receiver.read();
    assert.equal(nextLocal.tps, 5); assert.equal(nextLocal.totalTokens, 300);
    assert.ok(nextLocal.snapshotRevision > local.snapshotRevision);
    for (const field of fields) assert.equal(nextRemote[field], nextLocal[field], field);
    connected = false;
    const offline = await receiver.read();
    assert.equal(offline.status, 'unavailable'); assert.equal(offline.tps, null);
    assert.equal(offline.unavailableReason, 'offline');
    if (duplicate) {
        await fs.appendFile(duplicate, turn('diverged', 30, 80));
        connected = true;
        assert.notEqual((await publisher.readLocal(LOCAL)).status, 'ok');
        const invalid = await receiver.read();
        assert.equal(invalid.status, 'unavailable');
        assert.equal(invalid.tps, null);
    }
});

test('main wires the CLI workspace resolver into its real publisher', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-main-workspace-')));
    const workspace = path.join(root, 'workspace'), active = path.join(workspace, 'child');
    const claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config');
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
        ipc: { handle(_name, handler) { read = handler; } }, log: { info() {} } }, {
        claudeData, claudeHome, resolveWorkspace, store: { getStats: async () => sample, dispose() {} },
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
    const published = JSON.parse(await fs.readFile(path.join(active, relative), 'utf8'));
    assert.equal(published.revision, local.snapshotRevision);
    assert.equal(published.stats.tps, local.tps);
    await assert.rejects(fs.stat(path.join(workspace, relative)), { code: 'ENOENT' });
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
    const publisher = createSnapshotPublisher({ claudeData, store, resolveWorkspace, pollMs: 600000 });
    t.after(async () => { await publisher.stop(); store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    await publisher.start();
    const local = await publisher.readLocal(LOCAL);
    assert.equal(local.status, 'ok');
    assert.equal(local.totalTokens, returned ? 300 : 140);
    assert.equal(local.steps, returned ? 2 : 1);
    assert.equal(local.tps, returned ? 5 : 4);
    const active = returned ? workspace : worktree;
    assert.equal(JSON.parse(await fs.readFile(path.join(active, relative), 'utf8')).stats.totalTokens, returned ? 300 : 140);
    if (returned) {
        registered = false;
        assert.notEqual((await publisher.readLocal(LOCAL)).status, 'ok');
    } else {
        await fs.writeFile(registry, JSON.stringify({ ...row, bridgeSessionId: 'session_conflict' }));
        assert.equal((await publisher.readLocal(LOCAL)).status, 'unavailable');
    }
});
