'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createDesktopForkResolver } = require('../src/fork-metadata.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CHILD = '33333333-3333-4333-8333-333333333333';
const PARENT = '44444444-4444-4444-8444-444444444444';
const CHILD_LOCAL = 'local_55555555-5555-4555-8555-555555555555';
const PARENT_LOCAL = 'local_66666666-6666-4666-8666-666666666666';
const CUTOFF = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const INCOMPLETE = { incomplete: true };

async function fixture(t) {
    const claudeData = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-fork-metadata-'));
    t.after(() => fs.rm(claudeData, { recursive: true, force: true }));
    const child = { sessionId: CHILD_LOCAL, cliSessionId: CHILD,
        forkedFromSessionId: PARENT_LOCAL, forkedAtMessageUuid: CUTOFF };
    const parent = { sessionId: PARENT_LOCAL, cliSessionId: PARENT, isArchived: true };
    async function write(row, account = ACCOUNT, org = ORG, local = row.sessionId) {
        const directory = path.join(claudeData, 'claude-code-sessions', account, ...(org === null ? [] : [org]));
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${local}.json`);
        await fs.writeFile(file, JSON.stringify(row));
        return file;
    }
    const childFile = await write(child), parentFile = await write(parent);
    return { claudeData, child, parent, childFile, parentFile, write,
        resolver: createDesktopForkResolver({ claudeData }) };
}

test('resolves native local fork pointers to CLI identity and the first excluded UUID', async t => {
    const f = await fixture(t);
    const fork = await f.resolver.resolveFork(CHILD.toUpperCase());
    assert.equal(fork.parentSessionId, PARENT);
    assert.equal(fork.cutoffMessageUuid, CUTOFF);
    assert.equal(await fork.verify(), true);
    assert.deepEqual(Object.keys(fork).sort(), ['cutoffMessageUuid', 'parentSessionId', 'verify']);
});

test('resolves a native fork in the flat account metadata layout', async t => {
    const f = await fixture(t);
    await fs.rm(path.dirname(f.childFile), { recursive: true });
    await f.write(f.child, ACCOUNT, null);
    await f.write(f.parent, ACCOUNT, null);
    const fork = await f.resolver.resolveFork(CHILD);
    assert.equal(fork?.parentSessionId, PARENT);
    assert.equal(fork?.cutoffMessageUuid, CUTOFF);
    assert.equal(await fork.verify(), true);
    assert.equal(await f.resolver.resolveFork(PARENT), null);
});

test('rejects CLI duplicates between flat account and organization metadata layouts', async t => {
    const f = await fixture(t);
    const flatChild = await f.write(f.child, ACCOUNT, null);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    await fs.rm(flatChild);
    await f.write(f.parent, ACCOUNT, null);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('never resolves a parent across flat account and organization scopes', async t => {
    const f = await fixture(t);
    await fs.rm(f.childFile);
    const flatChild = await f.write(f.child, ACCOUNT, null);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    await fs.rm(flatChild);
    await f.write(f.child);
    await fs.rm(f.parentFile);
    await f.write(f.parent, ACCOUNT, null);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('verify rereads flat metadata bindings and rejects changed fork semantics', async t => {
    const f = await fixture(t);
    await fs.rm(path.dirname(f.childFile), { recursive: true });
    await f.write(f.child, ACCOUNT, null);
    await f.write(f.parent, ACCOUNT, null);
    const fork = await f.resolver.resolveFork(CHILD);
    assert.equal(fork?.parentSessionId, PARENT);
    await f.write({ ...f.child, forkedAtMessageUuid: OTHER }, ACCOUNT, null);
    assert.equal(await fork.verify(), false);
    await f.write(f.child, ACCOUNT, null);
    const next = await f.resolver.resolveFork(CHILD);
    await f.write({ ...f.parent, cliSessionId: OTHER }, ACCOUNT, null);
    assert.equal(await next.verify(), false);
});

test('accepts an absolute data path ending in a directory separator without looping', async t => {
    const f = await fixture(t);
    const execFile = require('node:util').promisify(require('node:child_process').execFile);
    const source = "const { createDesktopForkResolver } = require(process.argv[1]);"
        + "createDesktopForkResolver({ claudeData: process.argv[2] }).resolveFork(process.argv[3])"
        + ".then(async fork => process.stdout.write(JSON.stringify([fork.parentSessionId, await fork.verify()])));";
    const { stdout } = await execFile(process.execPath, ['-e', source,
        require.resolve('../src/fork-metadata.cjs'), `${f.claudeData}${path.sep}`, CHILD], { timeout: 2000 });
    assert.equal(stdout, '["44444444-4444-4444-8444-444444444444",true]');
});

test('allows an omitted cutoff and returns null for a uniquely mapped session without a fork', async t => {
    const f = await fixture(t);
    await f.write({ ...f.child, forkedAtMessageUuid: undefined });
    assert.equal((await f.resolver.resolveFork(CHILD)).cutoffMessageUuid, null);
    assert.equal(await f.resolver.resolveFork(PARENT), null);
    assert.equal(await f.resolver.resolveFork(OTHER), null);
    const empty = path.join(f.claudeData, 'empty');
    await fs.mkdir(empty);
    assert.equal(await createDesktopForkResolver({ claudeData: empty }).resolveFork(CHILD), null);
});

test('fails closed for invalid CLI identity and invalid data roots', async t => {
    const f = await fixture(t);
    for (const cli of [null, '', CHILD_LOCAL, '../private', `${CHILD}.json`, {}, 42])
        assert.deepEqual(await f.resolver.resolveFork(cli), INCOMPLETE);
    for (const claudeData of [null, undefined, '', 'relative', 42])
        assert.deepEqual(await createDesktopForkResolver({ claudeData }).resolveFork(CHILD), INCOMPLETE);
});

test('requires a unique CLI mapping across accounts even when duplicate records agree', async t => {
    const f = await fixture(t);
    await f.write(f.child, OTHER);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    await fs.rm(path.join(f.claudeData, 'claude-code-sessions', OTHER), { recursive: true });
    await f.write({ ...f.parent, sessionId: `local_${OTHER}` }, OTHER);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('requires the parent record in the same account and organization', async t => {
    const f = await fixture(t);
    await fs.rm(f.parentFile);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    await f.write(f.parent, OTHER);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    await fs.rm(path.join(f.claudeData, 'claude-code-sessions', OTHER), { recursive: true });
    await f.write(f.parent, ACCOUNT, OTHER);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('rejects mismatched persisted identities for either child or parent', async t => {
    const f = await fixture(t);
    for (const row of [{ ...f.child, sessionId: PARENT_LOCAL }, { ...f.child, sessionId: undefined }]) {
        await f.write(row, ACCOUNT, ORG, CHILD_LOCAL);
        assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    }
    await f.write(f.child);
    for (const change of [{ sessionId: CHILD_LOCAL }, { cliSessionId: '../private' }, { cliSessionId: null }]) {
        await f.write({ ...f.parent, ...change }, ACCOUNT, ORG, PARENT_LOCAL);
        assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    }
});

test('rejects malformed fork pointers, cutoffs and self-parent references', async t => {
    const f = await fixture(t);
    for (const change of [{ forkedFromSessionId: '' }, { forkedFromSessionId: PARENT },
        { forkedFromSessionId: '../private' }, { forkedFromSessionId: {} },
        { forkedFromSessionId: CHILD_LOCAL }, { forkedAtMessageUuid: '' },
        { forkedAtMessageUuid: 'message-private' }, { forkedAtMessageUuid: 42 },
        { forkedFromSessionId: undefined }]) {
        await f.write({ ...f.child, ...change });
        assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE, JSON.stringify(change));
    }
});

test('does not use title, archive, availability or business timestamps as fork identity', async t => {
    const f = await fixture(t);
    const fork = await f.resolver.resolveFork(CHILD);
    await f.write({ ...f.child, title: 'private title', updatedAt: Date.now(), isArchived: true,
        transcriptUnavailable: true, remoteControlUserEnabled: false });
    await f.write({ ...f.parent, title: 'changed private title', updatedAt: Date.now(), isArchived: false });
    assert.equal(await fork.verify(), true);
    assert.equal((await f.resolver.resolveFork(CHILD)).parentSessionId, PARENT);
});

test('verify rereads semantics and rejects changed child links and parent CLI identities', async t => {
    const f = await fixture(t);
    for (const change of [{ forkedAtMessageUuid: OTHER }, { forkedFromSessionId: CHILD_LOCAL },
        { cliSessionId: OTHER }, { sessionId: PARENT_LOCAL }]) {
        await f.write(f.child);
        const fork = await f.resolver.resolveFork(CHILD);
        await f.write({ ...f.child, ...change }, ACCOUNT, ORG, CHILD_LOCAL);
        assert.equal(await fork.verify(), false, JSON.stringify(change));
    }
    await f.write(f.child);
    const fork = await f.resolver.resolveFork(CHILD);
    await f.write({ ...f.parent, cliSessionId: OTHER });
    assert.equal(await fork.verify(), false);
});

test('verify rejects a newly ambiguous mapping and missing metadata', async t => {
    const f = await fixture(t);
    const fork = await f.resolver.resolveFork(CHILD);
    await f.write(f.child, OTHER);
    assert.equal(await fork.verify(), false);
    await fs.rm(path.join(f.claudeData, 'claude-code-sessions', OTHER), { recursive: true });
    await fs.rm(f.parentFile);
    assert.equal(await fork.verify(), false);
});

test('verify rejects file replacement even if fork semantics were copied unchanged', async t => {
    const f = await fixture(t);
    const fork = await f.resolver.resolveFork(CHILD);
    await fs.rename(f.childFile, `${f.childFile}.old`);
    await f.write(f.child);
    assert.equal(await fork.verify(), false);
});

test('rejects metadata directories masquerading as records and oversized or invalid JSON', async t => {
    const f = await fixture(t);
    for (const content of ['{broken', ' '.repeat(2 * 1024 * 1024 + 1)]) {
        await fs.writeFile(f.parentFile, content);
        assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
    }
    await fs.rm(f.parentFile);
    await fs.mkdir(f.parentFile);
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('does not follow an account junction when resolving native metadata', async t => {
    const f = await fixture(t);
    const account = path.join(f.claudeData, 'claude-code-sessions', ACCOUNT);
    const moved = path.join(f.claudeData, 'moved-account');
    await fs.rename(account, moved);
    await fs.symlink(moved, account, 'junction');
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});

test('rejects file changes during a bounded read instead of accepting a mixed snapshot', async t => {
    const f = await fixture(t);
    let changed = false;
    const hookedFs = { ...fs, async open(file, ...args) {
        const handle = await fs.open(file, ...args);
        if (file !== f.childFile) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), async read(...readArgs) {
            const result = await handle.read(...readArgs);
            if (!changed) {
                changed = true;
                await f.write({ ...f.child, forkedAtMessageUuid: OTHER, title: 'larger changed metadata' });
            }
            return result;
        } };
    } };
    assert.deepEqual(await createDesktopForkResolver({ claudeData: f.claudeData, fs: hookedFs }).resolveFork(CHILD), INCOMPLETE);
});

test('verify detects a child edit made after the child read while reading the parent', async t => {
    const f = await fixture(t);
    let armed = false;
    const hookedFs = { ...fs, async open(file, ...args) {
        const handle = await fs.open(file, ...args);
        if (file !== f.parentFile) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), async read(...readArgs) {
            const result = await handle.read(...readArgs);
            if (armed) {
                armed = false;
                await f.write({ ...f.child, forkedAtMessageUuid: OTHER, title: 'changed after read' });
            }
            return result;
        } };
    } };
    const fork = await createDesktopForkResolver({ claudeData: f.claudeData, fs: hookedFs }).resolveFork(CHILD);
    armed = true;
    assert.equal(await fork.verify(), false);
});

test('limits metadata directory traversal and never trusts a partial scan', async t => {
    const f = await fixture(t);
    const root = path.join(f.claudeData, 'claude-code-sessions');
    for (let index = 0; index < 512; index++) {
        const account = `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        await fs.mkdir(path.join(root, account));
    }
    assert.deepEqual(await f.resolver.resolveFork(CHILD), INCOMPLETE);
});
