'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionSourceResolver } = require('../src/session-source.cjs');
const { createSessionStore } = require('../src/session-store.cjs');
const bindings = require('../src/snapshot-bindings.cjs');
const ID = '11111111-1111-4111-8111-111111111111';
const FIRST = '22222222-2222-4222-8222-222222222222';
const TIP = '33333333-3333-4333-8333-333333333333';
const NEXT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';
const ORG = '66666666-6666-4666-8666-666666666666';
const LOCAL = 'local_77777777-7777-4777-8777-777777777777';
const BRIDGE = 'session_DesktopTip';
const lines = (...rows) => rows.map(row => JSON.stringify(row) + '\n').join('');
const answer = (uuid, output = 5, fields = {}) => ({ type: 'assistant', sessionId: ID, uuid, parentUuid: null,
    message: { role: 'assistant', id: uuid, model: 'fixture', usage: { input_tokens: 10,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: output } }, ...fields });

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-desktop-tip-')));
    const claudeHome = path.join(root, 'config'), claudeData = path.join(root, 'desktop');
    const workspaceRoot = path.join(root, 'workspace');
    const shorter = path.join(claudeHome, 'projects', 'shorter', `${ID}.jsonl`);
    const longest = path.join(claudeHome, 'projects', 'longest', `${ID}.jsonl`);
    const metadata = path.join(claudeData, 'claude-code-sessions', ACCOUNT, ORG, `${LOCAL}.json`);
    for (const directory of [workspaceRoot, ...[shorter, longest, metadata].map(path.dirname)])
        await fs.mkdir(directory, { recursive: true });
    const marker = { type: 'relocated', sessionId: ID, relocatedCwd: path.join(root, 'removed-worktree') };
    const prefix = lines(answer(FIRST), marker);
    await fs.writeFile(shorter, prefix);
    await fs.writeFile(longest, prefix + lines(answer(TIP, 7)));
    const row = { sessionId: LOCAL, cliSessionId: ID, cwd: workspaceRoot,
        bridgeSessionIds: [BRIDGE], lastAssistantUuid: TIP };
    const writeMetadata = value => fs.writeFile(metadata, JSON.stringify(value));
    await writeMetadata(row);
    const [binding] = await bindings.discoverSnapshotBindings(claudeData);
    const context = { workspaceRoot, verify: () => bindings.recheckSnapshotBinding(binding),
        resolveAssistantTip: () => bindings.resolveSnapshotAssistantTip(binding) };
    const store = createSessionStore({ claudeHome });
    t.after(async () => { store.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, claudeHome, claudeData, workspaceRoot, shorter, longest, metadata, prefix, row,
        writeMetadata, binding, context, store, resolver: createSessionSourceResolver() };
}

test('an exact freshly attested assistant tip selects the complete extension after worktree deletion', async t => {
    const f = await fixture(t);
    const context = { ...f.context, resolveAssistantTip: async () => TIP };
    const source = await f.resolver(ID, [f.shorter, f.longest], context);
    assert.equal(source?.path, f.longest);
    assert.equal(await source.verify(), true);
    assert.equal(await f.resolver(ID, [f.shorter, f.longest]), null);
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], { ...context, resolveAssistantTip: undefined }), null);
});

test('assistant tip tracking bounds cannot hide a later independently proven relocation marker', async t => {
    const f = await fixture(t);
    const rows = Array.from({ length: 65537 }, (_, index) => ({ type: 'assistant', sessionId: ID,
        uuid: index.toString(16).padStart(8, '0') + '-2222-4222-8222-222222222222', message: { role: 'assistant' } }));
    const prefix = lines(...rows) + lines({ type: 'relocated', sessionId: ID, relocatedCwd: f.workspaceRoot });
    await fs.writeFile(f.shorter, prefix);
    await fs.writeFile(f.longest, prefix + lines({ type: 'metadata' }));
    for (const resolveAssistantTip of [undefined, async () => TIP]) {
        const resolver = createSessionSourceResolver();
        assert.equal((await resolver(ID, [f.shorter, f.longest], { ...f.context, resolveAssistantTip }))?.path, f.longest);
    }
});

test('a contained or shared tip, foreign assistant and incomplete extension cannot establish the last assistant', async t => {
    const f = await fixture(t);
    const context = { ...f.context, resolveAssistantTip: async () => TIP };
    for (const suffix of [lines(answer(TIP), answer(NEXT)), lines(answer(TIP, 7, { isSidechain: true })),
        lines(answer(TIP, 7, { sessionId: NEXT })), lines(answer(TIP, 7, { isSynthetic: true })),
        lines(answer(TIP, 7)).trimEnd()]) {
        await fs.writeFile(f.longest, f.prefix + suffix);
        assert.equal(await f.resolver(ID, [f.shorter, f.longest], context), null);
    }
    const shared = f.prefix + lines(answer(TIP));
    await fs.writeFile(f.shorter, shared);
    await fs.writeFile(f.longest, shared + lines({ type: 'metadata' }));
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], context), null);
    await fs.writeFile(f.longest, shared);
    assert.ok(await f.resolver(ID, [f.shorter, f.longest], context));
    const conflicting = f.prefix + lines(answer(TIP, 7, { isSidechain: true }));
    await fs.writeFile(f.shorter, conflicting);
    await fs.writeFile(f.longest, conflicting + lines(answer(TIP, 7)));
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], context), null);
});

test('tip proofs recheck fresh metadata, caller context and every candidate instead of lending a warm proof', async t => {
    assert.equal(typeof bindings.resolveSnapshotAssistantTip, 'function');
    const f = await fixture(t);
    const source = await f.resolver(ID, [f.shorter, f.longest], f.context);
    assert.equal(source?.path, f.longest);
    await f.writeMetadata({ ...f.row, lastAssistantUuid: FIRST });
    assert.equal(await source.verify(), false);
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], f.context), null);
    await f.writeMetadata(f.row);
    assert.ok(await f.resolver(ID, [f.shorter, f.longest], f.context));
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], { ...f.context, resolveAssistantTip: async () => null }), null);
    await fs.appendFile(f.shorter, lines(answer(NEXT)));
    assert.equal(await source.verify(), false);
    assert.equal(await f.resolver(ID, [f.shorter, f.longest], f.context), null);
});

test('Desktop tip proof rejects conflicting identities and a marker rewritten during exact binding verification', async t => {
    assert.equal(typeof bindings.resolveSnapshotAssistantTip, 'function');
    const f = await fixture(t);
    assert.equal(await bindings.resolveSnapshotAssistantTip(f.binding), TIP);
    for (const change of [{ cliSessionId: NEXT }, { sessionId: 'local_' + NEXT },
        { lastAssistantUuid: 'not-a-uuid' }, { remoteControlUserEnabled: false }]) {
        await f.writeMetadata({ ...f.row, ...change });
        assert.equal(await bindings.resolveSnapshotAssistantTip(f.binding), null);
    }
    await f.writeMetadata(f.row);
    const resolveWorkspace = async () => {
        await f.writeMetadata({ ...f.row, lastAssistantUuid: NEXT });
        return null;
    };
    assert.equal(await bindings.resolveSnapshotAssistantTip(f.binding, { resolveWorkspace }), null);
});

test('the caller global uniqueness proof invalidates a warm tip when another account claims its identity', async t => {
    assert.equal(typeof bindings.resolveSnapshotAssistantTip, 'function');
    const f = await fixture(t);
    const context = { ...f.context, verify: async () => (await bindings.discoverSnapshotBindings(f.claudeData)).length === 1
        && await bindings.recheckSnapshotBinding(f.binding) };
    const source = await f.resolver(ID, [f.shorter, f.longest], context);
    assert.ok(source);
    const conflicting = path.join(f.claudeData, 'claude-code-sessions', NEXT, ORG, `${LOCAL}.json`);
    await fs.mkdir(path.dirname(conflicting), { recursive: true });
    await fs.writeFile(conflicting, JSON.stringify(f.row));
    assert.equal(await source.verify(), false);
});

test('the targeted assistant tip helper reads only its exact record and never enumerates sibling metadata', async t => {
    assert.equal(typeof bindings.resolveSnapshotAssistantTip, 'function');
    const f = await fixture(t);
    const open = fs.open, opendir = fs.opendir;
    const files = [], directories = [];
    t.mock.method(fs, 'open', async (file, ...args) => { files.push(file); return open(file, ...args); });
    t.mock.method(fs, 'opendir', async (directory, ...args) => { directories.push(directory); return opendir(directory, ...args); });
    assert.equal(await bindings.resolveSnapshotAssistantTip(f.binding), TIP);
    assert.deepEqual(directories, []);
    assert.deepEqual(files, [f.metadata, f.metadata, f.metadata]);
});

test('publisher global confirmation rejects a tip sample when another account claims the binding after sampling', async t => {
    const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');
    const f = await fixture(t);
    const claudeHome = path.join(f.root, 'home');
    await fs.mkdir(claudeHome);
    let changed = false;
    const store = { getStats: async (...args) => {
        const stats = await f.store.getStats(...args);
        if (!changed) {
            assert.equal(stats.status, 'ok');
            changed = true;
            const conflicting = path.join(f.claudeData, 'claude-code-sessions', NEXT, ORG, `${LOCAL}.json`);
            await fs.mkdir(path.dirname(conflicting), { recursive: true });
            await fs.writeFile(conflicting, JSON.stringify(f.row));
        }
        return stats;
    } };
    const publisher = createSnapshotPublisher({ claudeData: f.claudeData, claudeHome, store, pollMs: 600000 });
    t.after(() => publisher.stop());
    await publisher.start();
    assert.equal(changed, true);
    assert.notEqual((await publisher.readLocal(LOCAL))?.status, 'ok');
    await assert.rejects(fs.stat(path.join(claudeHome, '.session-stats', `${BRIDGE}.json`)), { code: 'ENOENT' });
});

test('parent and child reads retain independent tip proofs through the final caller callback', async t => {
    assert.equal(typeof bindings.resolveSnapshotAssistantTip, 'function');
    const f = await fixture(t);
    const children = path.join(path.dirname(f.longest), ID, 'subagents');
    await fs.mkdir(children, { recursive: true });
    await fs.writeFile(path.join(children, 'agent-a.jsonl'), lines(answer(NEXT, 13, { agentId: 'a', isSidechain: true })));
    assert.equal((await f.store.getStats(ID, f.context)).totalTokens, 32);
    assert.equal((await f.store.getAgentStats(ID, 'a', f.context)).totalTokens, 23);
    assert.deepEqual(await f.store.listAgents(ID, f.context), ['a']);
    assert.equal((await f.store.getStats(ID)).status, 'not-found');
    for (const action of ['parent', 'child', 'discovery']) {
        await f.writeMetadata(f.row);
        let calls = 0;
        const context = { ...f.context, verify: async () => {
            if (++calls === 2) await f.writeMetadata({ ...f.row, lastAssistantUuid: NEXT });
            return true;
        } };
        if (action === 'parent') assert.notEqual((await f.store.getStats(ID, context)).status, 'ok');
        else if (action === 'child') assert.notEqual((await f.store.getAgentStats(ID, 'a', context)).status, 'ok');
        else await assert.rejects(f.store.listAgents(ID, context));
    }
});
