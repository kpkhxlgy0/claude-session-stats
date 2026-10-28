'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionSourceResolver } = require('../src/session-source.cjs');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-source-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const workspaceRoot = path.join(root, 'active');
    await fs.mkdir(workspaceRoot);
    let valid = true;
    const context = { workspaceRoot: await fs.realpath(workspaceRoot), verify: async () => valid };
    const marker = { type: 'relocated', sessionId: ID, relocatedCwd: workspaceRoot };
    const first = { type: 'assistant', sessionId: ID, uuid: 'first', markerOnly: true };
    const prefix = lines([first, marker]);
    async function write(name, text) {
        const directory = path.join(root, name);
        await fs.mkdir(directory, { recursive: true });
        const file = path.join(directory, `${ID}.jsonl`);
        await fs.writeFile(file, text);
        return file;
    }
    return { root, workspaceRoot, context, marker, first, prefix, write,
        resolver: createSessionSourceResolver(options), setValid: value => { valid = value; } };
}

test('selects one strict complete-byte extension regardless of project name and mtime', async t => {
    const f = await fixture(t);
    const shorter = await f.write('active-project', f.prefix);
    const longest = await f.write('original-project', f.prefix + lines([{ type: 'assistant', sessionId: ID, uuid: 'next' }]));
    await fs.utimes(shorter, new Date(), new Date(Date.now() + 60000));
    const source = await f.resolver(ID, [shorter, longest], f.context);
    assert.equal(source?.path, longest);
    assert.equal(await source.verify(), true);
});

test('duplicate files without live verified workspace proof remain ambiguous', async t => {
    const f = await fixture(t);
    const shorter = await f.write('one', f.prefix);
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal(await f.resolver(ID, [shorter, longest]), null);
    f.setValid(false);
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
});

test('identical complete peers choose the same path regardless of order or mtime', async t => {
    const f = await fixture(t);
    const one = await f.write('one', f.prefix);
    const two = await f.write('two', f.prefix);
    await fs.utimes(two, new Date(), new Date(Date.now() + 60000));
    assert.equal((await f.resolver(ID, [two, one], f.context))?.path, one);
    assert.equal((await f.resolver(ID, [one, two], f.context))?.path, one);
    const source = await f.resolver(ID, [one, two], f.context);
    await fs.writeFile(two, f.prefix.trimEnd());
    assert.equal(await source.verify(), false);
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
});

test('equal-length differences and divergent continuations never establish a source', async t => {
    const f = await fixture(t);
    const one = await f.write('one', f.prefix);
    const two = await f.write('two', f.prefix.replace('first', 'other'));
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
    await fs.writeFile(two, f.prefix);
    await fs.appendFile(one, lines([{ type: 'assistant', sessionId: ID, uuid: 'branch-one' }]));
    await fs.appendFile(two, lines([{ type: 'assistant', sessionId: ID, uuid: 'branch-two-with-more-bytes' }]));
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
});

test('returned-root history requires a fresh association proof for the relocation directory', async t => {
    const f = await fixture(t);
    const history = path.join(f.root, 'historical worktree');
    const prefix = lines([f.first, { ...f.marker, relocatedCwd: history }]);
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID, uuid: 'next' }]));
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
    let evidence = 'registered-history:identity-1';
    const context = { ...f.context, resolveRelocation: async cwd => cwd === history ? evidence : null };
    const source = await f.resolver(ID, [shorter, longest], context);
    assert.equal(source?.path, longest);
    assert.equal(await source.verify(), true);
    evidence = 'registered-history:identity-2';
    assert.equal(await source.verify(), false);
    evidence = null;
    assert.equal(await f.resolver(ID, [shorter, longest], context), null);
});

test('a repeated unproved historical marker is probed once per body scan', async t => {
    const f = await fixture(t);
    const history = path.join(f.root, 'unregistered');
    const prefix = lines(Array.from({ length: 20 }, () => ({ ...f.marker, relocatedCwd: history }))) + f.prefix;
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID }]));
    let attempts = 0;
    const context = { ...f.context, resolveRelocation: async () => { attempts++; return null; } };
    assert.equal((await f.resolver(ID, [shorter, longest], context))?.path, longest);
    assert.equal(attempts, 1);
});

test('different unproved historical markers stop at the per-scan proof budget', async t => {
    const f = await fixture(t);
    const prefix = lines(Array.from({ length: 100 }, (_, index) => ({ ...f.marker,
        relocatedCwd: path.join(f.root, `unregistered-${index}`) }))) + f.prefix;
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID }]));
    let attempts = 0;
    const context = { ...f.context, resolveRelocation: async () => { attempts++; return null; } };
    assert.equal(await f.resolver(ID, [shorter, longest], context), null);
    assert.equal(attempts, 4);
    assert.equal(await f.resolver(ID, [shorter, longest], context), null);
    assert.equal(attempts, 8);
    attempts = 0;
    const limited = createSessionSourceResolver({ maxRelocations: 2 });
    assert.equal(await limited(ID, [shorter, longest], context), null);
    assert.equal(attempts, 2);
});

test('an association changed during comparison cannot establish historical proof', async t => {
    const f = await fixture(t);
    const history = path.join(f.root, 'historical');
    const prefix = lines([{ ...f.marker, relocatedCwd: history }]);
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID }]));
    let checks = 0;
    const context = { ...f.context, resolveRelocation: async () => ++checks === 1 ? 'old-identity' : 'new-identity' };
    assert.equal(await f.resolver(ID, [shorter, longest], context), null);
});

test('nonterminated shorter files and wrong relocation identity or cwd fail closed', async t => {
    const f = await fixture(t);
    for (const rows of [[f.first], [f.first, { ...f.marker, sessionId: OTHER }],
        [f.first, { ...f.marker, relocatedCwd: f.root }]]) {
        const prefix = lines(rows);
        const shorter = await f.write('one', prefix);
        const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID, uuid: 'extra' }]));
        assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
    }
    const shorter = await f.write('one', f.prefix.trimEnd());
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
});

test('old proofs invalidate on divergence or replacement before complete copies get a fresh proof', async t => {
    const f = await fixture(t);
    const shorter = await f.write('one', f.prefix);
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID, uuid: 'next' }]));
    const source = await f.resolver(ID, [shorter, longest], f.context);
    await fs.appendFile(shorter, lines([{ type: 'assistant', sessionId: ID, uuid: 'divergent' }]));
    assert.equal(await source.verify(), false);
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
    await fs.writeFile(shorter, f.prefix);
    const restored = await f.resolver(ID, [shorter, longest], f.context);
    const replacement = await f.write('replacement', f.prefix);
    await fs.rename(replacement, longest);
    assert.equal(await restored.verify(), false);
    const identical = await f.resolver(ID, [shorter, longest], f.context);
    assert.equal(identical?.path, shorter);
    assert.equal(await identical.verify(), true);
    assert.equal(await restored.verify(), false);
});

test('unchanged cached proofs do not reopen transcript bodies and still recheck live identity', async t => {
    let opens = 0;
    const f = await fixture(t, { fs: { ...fs, open: async (...args) => { opens++; return fs.open(...args); } } });
    const shorter = await f.write('one', f.prefix);
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal((await f.resolver(ID, [shorter, longest], f.context))?.path, longest);
    const before = opens;
    assert.equal((await f.resolver(ID, [shorter, longest], f.context))?.path, longest);
    assert.equal(opens, before);
    f.setValid(false);
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
});

test('unsafe links, over-budget sources and excess candidates cannot establish proof', async t => {
    const f = await fixture(t, { maxBytes: 32, maxCandidates: 2 });
    const shorter = await f.write('one', f.prefix);
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
    const other = await f.write('three', f.prefix);
    assert.equal(await f.resolver(ID, [shorter, longest, other], f.context), null);
    const g = await fixture(t);
    const linked = await g.write('one', g.prefix);
    const extension = await g.write('two', g.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    await fs.link(linked, path.join(g.root, 'hardlink'));
    assert.equal(await g.resolver(ID, [linked, extension], g.context), null);
});

test('identical copies still require complete lines and stay within the total read budget', async t => {
    const f = await fixture(t);
    const one = await f.write('one', f.prefix.trimEnd());
    const two = await f.write('two', f.prefix.trimEnd());
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
    await fs.writeFile(one, f.prefix);
    await fs.writeFile(two, f.prefix);
    const resolver = createSessionSourceResolver({ maxBytes: Buffer.byteLength(f.prefix) * 2 + 5 });
    assert.equal(await resolver(ID, [one, two], f.context), null);
});

test('equal-copy comparison rejects a same-size rewrite during transcript I/O', async t => {
    let target, changed = false;
    const racedFs = { ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] !== target) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
            const result = await handle.read(...readArgs);
            if (!changed) {
                changed = true;
                const text = await fs.readFile(target, 'utf8');
                await fs.writeFile(target, text.replace('first', 'other'));
            }
            return result;
        } };
    } };
    const f = await fixture(t, { fs: racedFs });
    const one = await f.write('one', f.prefix);
    target = await f.write('two', f.prefix);
    assert.equal(await f.resolver(ID, [one, target], f.context), null);
    assert.equal(changed, true);
});

test('workspace changes during prefix checking cannot establish reusable proof', async t => {
    let f, changed = false;
    const racedFs = { ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (!changed) { changed = true; f.setValid(false); }
        return handle;
    } };
    f = await fixture(t, { fs: racedFs });
    const shorter = await f.write('one', f.prefix);
    const longest = await f.write('two', f.prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
});

test('old missing and UNC relocation targets are ignored without filesystem probing', async t => {
    const oldTargets = ['\\\\unavailable-server\\share\\old-worktree'];
    const guardedFs = { ...fs, realpath: async directory => {
        if (oldTargets.includes(directory)) throw new Error('Old relocation target must not be probed');
        return fs.realpath(directory);
    } };
    const f = await fixture(t, { fs: guardedFs });
    oldTargets.unshift(path.join(f.root, 'removed-worktree'));
    const prefix = lines(oldTargets.map(relocatedCwd => ({ ...f.marker, relocatedCwd }))) + f.prefix;
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal((await f.resolver(ID, [shorter, longest], f.context))?.path, longest);
});

test('real relocation callback never probes historical UNC or device markers while finding a local marker', async t => {
    const f = await fixture(t);
    const targets = ['\\\\unavailable-server\\share\\history', '//unavailable-server/share/history',
        '\\\\?\\C:\\history', '\\\\.\\pipe\\history', '\\??\\C:\\history'];
    const unsafe = new Set(targets.map(value => path.resolve(value)));
    const probes = [];
    const guardedFs = { ...fs, lstat: async file => {
        if (unsafe.has(file)) {
            probes.push(file);
            throw Object.assign(new Error('Remote/device path must not be probed'), { code: 'ENOENT' });
        }
        return fs.lstat(file);
    }, realpath: async file => {
        if (unsafe.has(file)) { probes.push(file); throw new Error('Remote/device path must not be probed'); }
        return fs.realpath(file);
    } };
    const claudeHome = path.join(f.root, 'claude');
    await fs.mkdir(path.join(claudeHome, 'sessions'), { recursive: true });
    const binding = { workspaceRoot: f.workspaceRoot, localSessionId: 'local_fixture', cliSessionId: ID,
        bridgeSessionId: 'session_fixture', metadataFile: path.join(f.root, 'desktop.json') };
    await fs.writeFile(path.join(claudeHome, 'sessions', '101.json'), JSON.stringify({ pid: 101,
        sessionId: ID, hostSessionId: binding.localSessionId, cwd: f.workspaceRoot,
        procStart: '123456', pidDomain: 'win32:fixture-host', startedAt: 1000 }));
    const resolveWorkspace = createCliWorkspaceResolver({ claudeHome, fs: guardedFs,
        platform: 'win32', hostname: 'fixture-host',
        getProcessIdentities: async () => new Map([[101, { alive: true, procStart: '123456' }]]) });
    let callbacks = 0;
    const context = { ...f.context, resolveRelocation: async cwd => {
        callbacks++;
        return (await resolveWorkspace.resolveRelocationVerified(binding, cwd))?.relocationEvidence ?? null;
    } };
    const prefix = lines(targets.map(relocatedCwd => ({ ...f.marker, relocatedCwd }))) + f.prefix;
    const shorter = await f.write('one', prefix);
    const longest = await f.write('two', prefix + lines([{ type: 'assistant', sessionId: ID }]));
    assert.equal((await f.resolver(ID, [shorter, longest], context))?.path, longest);
    assert.ok(callbacks > 0);
    assert.deepEqual(probes, []);
});
