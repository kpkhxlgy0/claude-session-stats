'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { discoverSnapshotBindings } = require('../src/snapshot-bindings.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CLI = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const OTHER = 'local_55555555-5555-4555-8555-555555555555';
const BRIDGE = 'session_666666666666666666666666';

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-bindings-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const claudeData = path.join(root, 'desktop');
    const workspaceRoot = path.join(root, 'workspace');
    await fs.mkdir(workspaceRoot);
    const row = { sessionId: LOCAL, cliSessionId: CLI, originCwd: path.join(root, 'original'),
        cwd: workspaceRoot, bridgeSessionIds: [BRIDGE],
        isArchived: false, remoteControlAutoEligible: true };
    async function write(value = row, account = ACCOUNT, org = ORG, local = LOCAL) {
        const directory = path.join(claudeData, 'claude-code-sessions', account, org);
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${local}.json`);
        await fs.writeFile(file, JSON.stringify(value));
        return file;
    }
    return { root, claudeData, workspaceRoot, row, write };
}

test('discovers explicit bridge bindings in exact account/org layout and canonical workspace', async t => {
    const f = await fixture(t);
    await f.write({ ...f.row, bridgeSessionIds: [BRIDGE, 'cse_777777777777777777777777'] });
    const bindings = await discoverSnapshotBindings(f.claudeData);
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map(({ accountId, organizationId, localSessionId, cliSessionId,
        workspaceRoot, bridgeSessionId }) => ({ accountId, organizationId, localSessionId,
        cliSessionId, workspaceRoot, bridgeSessionId })), [
        { accountId: ACCOUNT, organizationId: ORG, localSessionId: LOCAL, cliSessionId: CLI,
            workspaceRoot: await fs.realpath(f.workspaceRoot), bridgeSessionId: BRIDGE },
        { accountId: ACCOUNT, organizationId: ORG, localSessionId: LOCAL, cliSessionId: CLI,
            workspaceRoot: await fs.realpath(f.workspaceRoot), bridgeSessionId: 'session_777777777777777777777777' },
    ]);
});

test('accepts omitted userEnabled and false autoEligible with Desktop cwd fallback', async t => {
    const f = await fixture(t);
    await f.write({ ...f.row, worktreePath: '', remoteControlAutoEligible: false });
    assert.equal((await discoverSnapshotBindings(f.claudeData)).length, 1);
});

test('rejects archived, unavailable, disabled and malformed metadata instead of inventing a binding', async t => {
    const f = await fixture(t);
    for (const change of [{ isArchived: true }, { transcriptUnavailable: true },
        { remoteControlUserEnabled: false }, { sessionId: OTHER }, { cliSessionId: '../wrong' },
        { bridgeSessionIds: undefined }, { bridgeSessionIds: [] }, { bridgeSessionIds: ['../escape'] },
        { cwd: 'relative' }, { worktreePath: 'relative' }, { cwd: undefined }]) {
        await f.write({ ...f.row, ...change });
        assert.deepEqual(await discoverSnapshotBindings(f.claudeData), [], JSON.stringify(change));
    }
    await f.write(f.row, 'not-an-account');
    await fs.rm(path.join(f.claudeData, 'claude-code-sessions', ACCOUNT), { recursive: true });
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData), []);
});

test('uses Desktop worktreePath before cwd and never selects a differing originCwd', async t => {
    const f = await fixture(t);
    const original = path.join(f.root, 'original');
    const worktree = path.join(f.root, 'active-workspace');
    await fs.mkdir(original);
    await fs.mkdir(worktree);
    await f.write({ ...f.row, originCwd: original, worktreePath: worktree });
    assert.equal((await discoverSnapshotBindings(f.claudeData))[0]?.workspaceRoot, await fs.realpath(worktree));
});

test('duplicate local or bridge identities across files invalidate all conflicting mappings', async t => {
    const f = await fixture(t);
    await f.write();
    await f.write(f.row, CLI);
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData), []);
    await fs.rm(path.join(f.claudeData, 'claude-code-sessions', CLI), { recursive: true });
    await f.write({ ...f.row, sessionId: OTHER }, ACCOUNT, ORG, OTHER);
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData), []);
});

test('does not follow metadata directory junctions or oversized records', async t => {
    const f = await fixture(t);
    const file = await f.write();
    await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData), []);
    await f.write();
    const sessions = path.join(f.claudeData, 'claude-code-sessions');
    const moved = path.join(f.root, 'moved-account');
    await fs.rename(path.join(sessions, ACCOUNT), moved);
    await fs.symlink(moved, path.join(sessions, ACCOUNT), 'junction');
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData), []);
});
