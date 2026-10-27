'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSessionSourceResolver } = require('../src/session-source.cjs');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-source-'));
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

test('identical peers and divergent continuations do not choose an arbitrary transcript', async t => {
    const f = await fixture(t);
    const one = await f.write('one', f.prefix);
    const two = await f.write('two', f.prefix);
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
    await fs.appendFile(one, lines([{ type: 'assistant', sessionId: ID, uuid: 'branch-one' }]));
    await fs.appendFile(two, lines([{ type: 'assistant', sessionId: ID, uuid: 'branch-two-with-more-bytes' }]));
    assert.equal(await f.resolver(ID, [one, two], f.context), null);
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

test('cached proof invalidates when a shorter file diverges or the chosen file is replaced', async t => {
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
    assert.equal(await f.resolver(ID, [shorter, longest], f.context), null);
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
