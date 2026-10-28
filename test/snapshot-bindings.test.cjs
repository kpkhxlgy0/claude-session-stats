'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { discoverSnapshotBindings, recheckSnapshotBinding } = require('../src/snapshot-bindings.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CLI = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const OTHER = 'local_55555555-5555-4555-8555-555555555555';
const BRIDGE = 'session_666666666666666666666666';

async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-bindings-')));
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
test('verified live workspace supersedes stale Desktop cwd and changes invalidate the binding', async t => {
    const f = await fixture(t);
    await f.write();
    const worktree = path.join(f.root, 'verified-worktree');
    await fs.mkdir(worktree);
    let evidence = 'pid:100:birth:1', valid = true;
    const resolveWorkspace = async binding => {
        assert.equal(binding.cliSessionId, CLI);
        assert.equal(binding.localSessionId, LOCAL);
        assert.equal(binding.bridgeSessionId, BRIDGE);
        assert.equal(binding.workspaceRoot, await fs.realpath(f.workspaceRoot));
        return { workspaceRoot: await fs.realpath(worktree), evidenceKey: evidence, verify: async () => valid };
    };
    const [binding] = await discoverSnapshotBindings(f.claudeData, { resolveWorkspace });
    assert.equal(binding.workspaceRoot, await fs.realpath(worktree));
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), true);
    evidence = 'pid:101:birth:2';
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), false);
    valid = false;
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData, { resolveWorkspace }), []);
});

test('unverifiable active workspace cannot fall back to the Desktop directory', async t => {
    const f = await fixture(t);
    await f.write();
    for (const result of [{ unavailable: true }, { workspaceRoot: 'relative', evidenceKey: 'x', verify: async () => true },
        { workspaceRoot: f.workspaceRoot, evidenceKey: 'x', verify: async () => false }]) {
        assert.deepEqual(await discoverSnapshotBindings(f.claudeData, { resolveWorkspace: async () => result }), []);
    }
    assert.equal((await discoverSnapshotBindings(f.claudeData, { resolveWorkspace: async () => null }))[0].workspaceRoot,
        await fs.realpath(f.workspaceRoot));
});

test('metadata changed during asynchronous workspace verification invalidates a prior binding', async t => {
    const f = await fixture(t);
    await f.write();
    let change = false;
    const resolveWorkspace = async () => ({ workspaceRoot: await fs.realpath(f.workspaceRoot),
        evidenceKey: 'stable', verify: async () => {
            if (change) await f.write({ ...f.row, remoteControlUserEnabled: false });
            return true;
        } });
    const [binding] = await discoverSnapshotBindings(f.claudeData, { resolveWorkspace });
    change = true;
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), false);
});

test('fresh verified resolver results are consumed once per discovery and recheck', async t => {
    const f = await fixture(t);
    await f.write();
    const active = path.join(f.root, 'active');
    await fs.mkdir(active);
    const worktree = await fs.realpath(active);
    let proofs = 0;
    const resolveWorkspace = async () => { throw new Error('Legacy resolution must not run'); };
    resolveWorkspace.resolveVerified = async () => {
        proofs++;
        return { workspaceRoot: worktree, evidenceKey: 'fresh-proof' };
    };
    const [binding] = await discoverSnapshotBindings(f.claudeData, { resolveWorkspace });
    assert.equal(binding?.workspaceRoot, worktree);
    assert.equal(proofs, 1);
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), true);
    assert.equal(proofs, 2);
});

test('targeted discovery scans all identities but resolves only the requested immutable binding', async t => {
    const f = await fixture(t);
    await f.write();
    await f.write({ ...f.row, sessionId: OTHER, cliSessionId: ACCOUNT, bridgeSessionIds: ['session_other'] }, ACCOUNT, ORG, OTHER);
    const target = (await discoverSnapshotBindings(f.claudeData)).find(binding => binding.localSessionId === LOCAL);
    const resolved = [];
    const resolveWorkspace = async binding => { resolved.push(binding.localSessionId); return null; };
    const bindings = await discoverSnapshotBindings(f.claudeData, { resolveWorkspace, onlyBindings: [target] });
    assert.deepEqual(bindings.map(binding => binding.localSessionId), [LOCAL]);
    assert.deepEqual(resolved, [LOCAL]);
    resolved.length = 0;
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData, { resolveWorkspace,
        onlyBindings: [{ ...target, cliSessionId: ACCOUNT }] }), []);
    assert.deepEqual(resolved, []);
});

for (const conflict of ['local', 'bridge']) test(`targeted discovery still rejects a ${conflict} conflict outside its account scope`, async t => {
    const f = await fixture(t);
    await f.write();
    const [target] = await discoverSnapshotBindings(f.claudeData);
    await f.write({ ...f.row, sessionId: conflict === 'local' ? LOCAL : OTHER,
        bridgeSessionIds: conflict === 'bridge' ? [BRIDGE] : ['session_conflict'] }, CLI, ORG,
        conflict === 'local' ? LOCAL : OTHER);
    const resolved = [];
    assert.deepEqual(await discoverSnapshotBindings(f.claudeData, { onlyBindings: [target],
        resolveWorkspace: async binding => { resolved.push(binding); return null; } }), []);
    assert.deepEqual(resolved, []);
});

test('targeted discovery freshly resolves a changed root instead of filtering by old workspace evidence', async t => {
    const f = await fixture(t);
    await f.write();
    const [target] = await discoverSnapshotBindings(f.claudeData);
    const moved = path.join(f.root, 'moved');
    await fs.mkdir(moved);
    await f.write({ ...f.row, cwd: moved });
    let supplied;
    const [current] = await discoverSnapshotBindings(f.claudeData, { onlyBindings: [target],
        resolveWorkspace: async binding => { supplied = binding.workspaceRoot; return null; } });
    assert.equal(supplied, await fs.realpath(moved));
    assert.equal(current.workspaceRoot, await fs.realpath(moved));
});

test('fresh verified resolver results still require a valid result shape', async t => {
    const f = await fixture(t);
    await f.write();
    const resolveWorkspace = async () => null;
    const array = Object.assign([], { workspaceRoot: f.workspaceRoot, evidenceKey: 'proof' });
    for (const result of [undefined, {}, { unavailable: true },
        array,
        { workspaceRoot: 'relative', evidenceKey: 'proof' },
        { workspaceRoot: f.workspaceRoot, evidenceKey: '' },
        { workspaceRoot: f.workspaceRoot, evidenceKey: 'x'.repeat(16385) }]) {
        resolveWorkspace.resolveVerified = async () => result;
        assert.deepEqual(await discoverSnapshotBindings(f.claudeData, { resolveWorkspace }), []);
    }
    resolveWorkspace.resolveVerified = async () => null;
    assert.equal((await discoverSnapshotBindings(f.claudeData, { resolveWorkspace }))[0]?.workspaceRoot,
        await fs.realpath(f.workspaceRoot));
});

test('recheck resolves only matching immutable identities before comparing a moved root', async t => {
    const f = await fixture(t);
    await f.write({ ...f.row, bridgeSessionIds: ['session_other', BRIDGE] });
    const worktree = path.join(f.root, 'active');
    await fs.mkdir(worktree);
    const resolvedRoot = await fs.realpath(worktree);
    const requested = [];
    const resolveWorkspace = async binding => {
        requested.push(binding.bridgeSessionId);
        return { workspaceRoot: resolvedRoot, evidenceKey: 'proof', verify: async () => true };
    };
    const binding = (await discoverSnapshotBindings(f.claudeData, { resolveWorkspace }))
        .find(candidate => candidate.bridgeSessionId === BRIDGE);
    requested.length = 0;
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), true);
    assert.deepEqual(requested, [BRIDGE]);
    for (const change of [{ accountId: CLI }, { organizationId: CLI }, { localSessionId: OTHER },
        { cliSessionId: ACCOUNT }, { bridgeSessionId: 'session_missing' }]) {
        requested.length = 0;
        assert.equal(await recheckSnapshotBinding({ ...binding, ...change }, { resolveWorkspace }), false);
        assert.deepEqual(requested, []);
    }
});

test('metadata changed during a fresh proof cannot confirm the previous binding', async t => {
    const f = await fixture(t);
    await f.write();
    let change = false;
    const resolveWorkspace = async () => null;
    resolveWorkspace.resolveVerified = async () => {
        if (change) await f.write({ ...f.row, remoteControlUserEnabled: false });
        return { workspaceRoot: await fs.realpath(f.workspaceRoot), evidenceKey: 'proof' };
    };
    const [binding] = await discoverSnapshotBindings(f.claudeData, { resolveWorkspace });
    change = true;
    assert.equal(await recheckSnapshotBinding(binding, { resolveWorkspace }), false);
});
