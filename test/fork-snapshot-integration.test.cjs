'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { startMain } = require('../src/main.cjs');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createRemoteReader } = require('../src/remote-reader.cjs');

const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_ForkIntegration';
const relative = '.claude/session-stats/' + BRIDGE + '.json';
const timestamp = seconds => new Date(Date.UTC(2026, 9, 24) + seconds * 1000).toISOString();
function turn(sessionId, id, start, elapsed, output, parentUuid = null) {
    return [{ type: 'user', sessionId, uuid: 'user-' + id, parentUuid, timestamp: timestamp(start),
        message: { role: 'user', content: 'fixture input' } },
    { type: 'assistant', sessionId, uuid: 'assistant-' + id, parentUuid: 'user-' + id, timestamp: timestamp(start + elapsed),
        message: { role: 'assistant', id, content: [{ type: 'text', text: 'fixture response' }],
            usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: output } } }];
}
const encode = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

for (const mode of ['desktop-copy', 'sdk-rewritten']) {
    test(mode + ' fork includes inherited TPS in the production main and same RC snapshot after continuation and restart', async t => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-fork-integration-'));
        const claudeData = path.join(root, 'desktop'), claudeHome = path.join(root, 'config'), workspace = path.join(root, 'workspace');
        const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG), logs = path.join(claudeHome, 'projects', 'fixture');
        await Promise.all([fs.mkdir(metadata, { recursive: true }), fs.mkdir(logs, { recursive: true }), fs.mkdir(workspace)]);
        const parentMetadata = path.join(metadata, 'local_' + PARENT + '.json');
        await fs.writeFile(parentMetadata, JSON.stringify({ sessionId: 'local_' + PARENT, cliSessionId: PARENT, cwd: workspace }));
        await fs.writeFile(path.join(metadata, 'local_' + CHILD + '.json'), JSON.stringify({
            sessionId: 'local_' + CHILD, cliSessionId: CHILD, cwd: workspace, bridgeSessionIds: [BRIDGE],
            ...(mode === 'desktop-copy' ? { forkedFromSessionId: 'local_' + PARENT } : {}) }));
        const inherited = turn(PARENT, 'm1', 0, 5, 1000);
        const parentFile = path.join(logs, PARENT + '.jsonl'), childFile = path.join(logs, CHILD + '.jsonl');
        await fs.writeFile(parentFile, encode(inherited));
        const copied = mode === 'desktop-copy' ? inherited : inherited.map((row, i) => ({
            ...row, sessionId: CHILD, uuid: 'copy-' + row.uuid, parentUuid: i ? 'copy-' + inherited[i - 1].uuid : null,
            forkedFrom: { sessionId: PARENT, messageUuid: row.uuid },
            timestamp: i === inherited.length - 1 ? timestamp(3600) : row.timestamp }));
        await fs.writeFile(childFile, encode(copied));
        const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: 'https://claude.ai/code/' + BRIDGE });
        const editor = dom.window.document.querySelector('.ProseMirror');
        editor.getClientRects = () => [{ width: 100 }];
        editor.__reactFiber$test = { return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
        let sequence = 0, handler, controller;
        const events = [];
        dom.window.fetch = async (raw, init) => {
            const url = new URL(raw); let body;
            assert.equal(url.origin, 'https://claude.ai');
            assert.equal(init.credentials, 'include');
            assert.equal(init.headers['x-organization-uuid'], ORG);
            if (url.pathname === '/v1/code/sessions/' + BRIDGE)
                body = { session: { id: BRIDGE.replace('session_', 'cse_'), environment_kind: 'bridge', connection_status: 'connected' } };
            else {
                assert.equal(url.pathname, '/v1/code/sessions/' + BRIDGE + '/events');
                if (init.method === 'POST') {
                    const request = JSON.parse(init.body).events[0].payload;
                    assert.deepEqual(request.request, { subtype: 'read_file', path: relative, max_bytes: 16384,
                        encoding: 'utf-8' });
                    const contents = await fs.readFile(path.join(workspace, relative), 'utf8');
                    events.push({ sequence_num: ++sequence, payload: { type: 'control_response', response: {
                        request_id: request.request_id, subtype: 'success', response: { contents, absPath: relative } } } });
                    body = {};
                } else body = { data: url.searchParams.get('sort_order') === 'desc' ? events.slice(-1)
                    : events.filter(e => e.sequence_num > Number(url.searchParams.get('cursor') ?? 0)), resume_cursor: String(sequence) };
            }
            return { ok: true, text: async () => JSON.stringify(body) };
        };
        const receiver = createRemoteReader(dom.window, createSnapshotProtocol, { pollMs: 0, errorBackoffMs: 0, responsePollMs: 0 });
        const api = { manifest: { id: 'com.kpk.session-stats' }, log: { info() {} },
            ipc: { handle(name, fn) { assert.equal(name, 'stats'); handler = fn; } } };
        const options = { claudeData, claudeHome, ipcMain: { handle() {}, removeHandler() {} } };
        t.after(async () => { receiver.stop(); dom.window.close(); await controller?.stop(); await fs.rm(root, { recursive: true }); });
        controller = startMain(api, options);
        const fields = ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheHit',
            'tps', 'usageComplete', 'snapshotGeneratedAt', 'snapshotRevision', 'snapshotPublisherId'];
        async function compare(expected) {
            let local;
            const deadline = Date.now() + 5000;
            do {
                local = await handler('local_' + CHILD);
                if (local.status === 'ok' && local.tps === expected) break;
                await new Promise(resolve => setTimeout(resolve, 20));
            } while (Date.now() < deadline);
            const remote = await receiver.read();
            assert.equal(local.status, 'ok');
            assert.equal(local.tps, expected);
            assert.equal(remote.status, 'ok');
            for (const field of fields) assert.equal(remote[field], local[field], field);
            return local;
        }
        const initial = await compare(200);
        await fs.appendFile(parentFile, encode(turn(PARENT, 'parent-later', 10, 1, 10000, inherited.at(-1).uuid)));
        await fs.appendFile(childFile, encode(turn(CHILD, 'm2', 4000, 20, 1000, copied.at(-1).uuid)));
        const next = await compare(80);
        assert.ok(next.snapshotRevision > initial.snapshotRevision);
        assert.equal(next.steps, mode === 'desktop-copy' ? 1 : 2);
        await controller.stop();
        controller = startMain(api, options);
        await compare(80);
        await fs.unlink(parentFile);
        const missing = await compare(null);
        assert.equal(missing.steps, mode === 'desktop-copy' ? 1 : 2);
    });
}
