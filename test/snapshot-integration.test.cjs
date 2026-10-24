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

const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_Integration123';
const relative = '.claude/session-stats/session_Integration123.json';
function turn(id, seconds, output) {
    const timestamp = n => new Date(Date.UTC(2026, 9, 24, 0, 0, n)).toISOString();
    return [{ type: 'user', sessionId: CLI, uuid: 'user-' + id, timestamp: timestamp(seconds),
        message: { role: 'user', content: 'fixture' } },
    { type: 'assistant', sessionId: CLI, uuid: 'assistant-' + id, timestamp: timestamp(seconds + 10),
        message: { role: 'assistant', id, usage: { input_tokens: 10, cache_creation_input_tokens: 20,
            cache_read_input_tokens: 70, output_tokens: output } } }].map(r => JSON.stringify(r) + '\n').join('');
}

test('local JSONL, atomic snapshot and RC receiver share exactly the same two successive samples', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-integration-'));
    const workspace = path.join(root, 'workspace'), claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config');
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG);
    const logs = path.join(claudeHome, 'projects', 'fixture');
    await Promise.all([fs.mkdir(workspace, { recursive: true }), fs.mkdir(metadata, { recursive: true }), fs.mkdir(logs, { recursive: true })]);
    await fs.writeFile(path.join(metadata, LOCAL + '.json'), JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: workspace, originCwd: workspace, bridgeSessionIds: [BRIDGE], isArchived: false }));
    const log = path.join(logs, CLI + '.jsonl');
    await fs.writeFile(log, turn('m1', 0, 40));
    let time = 100000, connected = true, sequence = 0;
    const events = [], store = createSessionStore({ claudeHome });
    const publisher = createSnapshotPublisher({ claudeData, store, now: () => time, pollMs: 600000 });
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
                    encoding: 'utf-8', anchor: { kind: 'workspace_root' } });
                const contents = await fs.readFile(path.join(workspace, relative), 'utf8');
                events.push({ sequence_num: ++sequence, payload: { type: 'control_response', response: {
                    request_id: request.request_id, subtype: 'success', response: { contents, absPath: relative, anchor: 'workspace_root' } } } });
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
});
