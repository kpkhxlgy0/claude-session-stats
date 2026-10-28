'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createCliWorkspaceResolver } = require('../src/cli-workspace.cjs');
const { createSnapshotPublisher } = require('../src/snapshot-publisher.cjs');

const CLI = '33333333-3333-4333-8333-333333333333';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const BRIDGE = 'session_666666666666666666666666';
const BIRTH = '134375438415690102';

function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function fixture(t, options = {}) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'claude-stats-cli-workspace-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const claudeHome = path.join(root, 'claude');
    const sessions = path.join(claudeHome, 'sessions');
    const desktop = path.join(root, 'desktop workspace');
    const active = path.join(root, 'active worktree');
    const second = path.join(root, 'second worktree');
    const foreign = path.join(root, 'foreign repository');
    const common = path.join(desktop, '.git');
    const foreignCommon = path.join(foreign, '.git');
    for (const directory of [sessions, desktop, active, second, common, foreignCommon])
        await fs.mkdir(directory, { recursive: true });
    const binding = { localSessionId: LOCAL, cliSessionId: CLI, bridgeSessionId: BRIDGE,
        accountId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
        workspaceRoot: await fs.realpath(desktop), metadataFile: path.join(root, 'desktop.json') };
    const row = { pid: 101, sessionId: CLI, cwd: active, startedAt: 1793070243330,
        procStart: BIRTH, pidDomain: 'win32:fixture-host', kind: 'interactive',
        entrypoint: 'claude-desktop', hostSessionId: LOCAL, bridgeSessionId: BRIDGE,
        updatedAt: 1793070243330 };
    const processes = new Map([[101, { alive: true, procStart: BIRTH }]]);
    const repositories = new Map([[desktop, common], [active, common], [second, common], [foreign, foreignCommon]]);
    let registered = [desktop, active, second];
    let processHook;
    let processQueries = 0;
    const gitCalls = [];
    const execFile = (command, args, _options, callback) => {
        if (command !== 'git') return callback(new Error(`Unexpected command: ${command}`));
        gitCalls.push(args);
        const cwd = args[1];
        const top = [...repositories.keys()].sort((a, b) => b.length - a.length).find(directory => inside(directory, cwd));
        if (!top) return callback(new Error('Not a Git repository'));
        if (args.includes('--git-common-dir') && args.includes('--show-toplevel'))
            return callback(null, repositories.get(top) + '\n' + top + '\n', '');
        if (args.includes('--git-common-dir')) return callback(null, repositories.get(top) + '\n', '');
        if (args.includes('--show-toplevel')) return callback(null, top + '\n', '');
        if (args.includes('worktree')) return callback(null,
            registered.map(directory => `worktree ${directory}\0HEAD 0000000000000000000000000000000000000000\0\0`).join(''), '');
        callback(new Error('Unexpected Git arguments'));
    };
    const resolver = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture-host',
        processCacheMs: 0, execFile, getProcessIdentities: async pids => {
            processQueries++;
            await processHook?.();
            return new Map(pids.filter(pid => processes.has(pid)).map(pid => [pid, processes.get(pid)]));
        }, ...options });
    async function write(change = {}, filename = '101.json') {
        const file = path.join(sessions, filename);
        await fs.writeFile(file, JSON.stringify({ ...row, ...change }));
        return file;
    }
    return { root, claudeHome, sessions, desktop, active, second, foreign, common, binding, row,
        resolver, write, processes, repositories, setRegistered: value => { registered = value; },
        execFile, gitCalls, setProcessHook: value => { processHook = value; },
        getProcessQueries: () => processQueries };
}

test('fresh verified resolution proves the current workspace with three Git calls each time', async t => {
    const f = await fixture(t);
    await f.write();
    assert.equal(typeof f.resolver.resolveVerified, 'function');
    const resolved = await f.resolver.resolveVerified(f.binding);
    assert.equal(resolved.workspaceRoot, await fs.realpath(f.active));
    assert.equal(typeof resolved.evidenceKey, 'string');
    assert.equal(resolved.verify, undefined);
    assert.equal(f.gitCalls.length, 3);
    assert.equal(f.getProcessQueries(), 1);
    assert.deepEqual(await f.resolver.resolveVerified(f.binding), resolved);
    assert.equal(f.gitCalls.length, 6);
    assert.equal(f.getProcessQueries(), 2);
    await f.write({ cwd: f.second });
    const changed = await f.resolver.resolveVerified(f.binding);
    assert.equal(changed.workspaceRoot, await fs.realpath(f.second));
    assert.notEqual(changed.evidenceKey, resolved.evidenceKey);
});

test('a fresh proof never joins an inspection started before its call', async t => {
    const f = await fixture(t);
    await f.write();
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    let paused = false;
    const resolver = createCliWorkspaceResolver({ claudeHome: f.claudeHome, platform: 'win32',
        hostname: 'fixture-host', getProcessIdentities: async () => f.processes,
        execFile: (command, args, options, callback) => {
            if (!paused && args.includes('worktree')) {
                paused = true;
                release = () => f.execFile(command, args, options, callback);
                entered();
            } else f.execFile(command, args, options, callback);
        } });
    assert.equal(typeof resolver.resolveVerified, 'function');
    const first = resolver.resolveVerified(f.binding);
    await waiting;
    try {
        await f.write({ cwd: f.second });
        let timer;
        const second = await Promise.race([resolver.resolveVerified(f.binding), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Fresh proof joined an older inspection')), 1000);
        })]).finally(() => clearTimeout(timer));
        assert.equal(second.workspaceRoot, await fs.realpath(f.second));
    } finally { release(); }
    assert.deepEqual(await first, { unavailable: true });
});

test('local snapshot reads use six Git calls and a fresh proof after snapshot I/O', async t => {
    const f = await fixture(t);
    await f.write();
    const claudeData = path.join(f.root, 'desktop-data');
    const metadata = path.join(claudeData, 'claude-code-sessions', f.binding.accountId, f.binding.organizationId,
        LOCAL + '.json');
    await fs.mkdir(path.dirname(metadata), { recursive: true });
    await fs.writeFile(metadata, JSON.stringify({ sessionId: LOCAL, cliSessionId: CLI,
        cwd: f.desktop, bridgeSessionIds: [BRIDGE] }));
    const publisher = createSnapshotPublisher({ claudeData, resolveWorkspace: f.resolver, pollMs: 600000,
        store: { getStats: async () => ({ status: 'ok', usageComplete: true, turns: 1, steps: 1,
            totalTokens: 10, inputTokens: 4, outputTokens: 6, cachedInputTokens: 0, cacheHit: 0, tps: 3 }) } });
    t.after(() => publisher.stop());
    await publisher.start();
    f.gitCalls.length = 0;
    const beforeQueries = f.getProcessQueries();
    assert.equal((await publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'ok');
    assert.equal(f.gitCalls.length, 6);
    assert.equal(f.getProcessQueries() - beforeQueries, 2);

    const originalOpen = fs.open;
    const snapshot = path.join(f.active, '.claude', 'session-stats', BRIDGE + '.json');
    let changed = false;
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await originalOpen(file, ...args);
        if (file !== snapshot || changed) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
            const result = await handle.read(...readArgs);
            changed = true;
            await f.write({ cwd: f.second });
            return result;
        } };
    });
    assert.equal((await publisher.readLocal(LOCAL, { waitForPoll: false })).status, 'unavailable');
    assert.equal(changed, true);
});

test('combined Git directory output rejects missing, extra, relative and control-bearing paths', async t => {
    const f = await fixture(t);
    await f.write();
    for (const output of [f.common + '\n', f.common + '\n' + f.desktop + '\nextra\n',
        f.common + '\nrelative\n', f.common + '\n\n', f.common + '\n' + f.desktop + '\r\n\n',
        f.common + '\n' + f.desktop + '\0\n', f.common + '\n' + f.desktop + '\t\n']) {
        const resolver = createCliWorkspaceResolver({ claudeHome: f.claudeHome, platform: 'win32',
            hostname: 'fixture-host', getProcessIdentities: async () => f.processes,
            execFile: (command, args, options, callback) => args.includes('rev-parse')
                ? callback(null, output, '') : f.execFile(command, args, options, callback) });
        assert.deepEqual(await resolver(f.binding), { unavailable: true }, JSON.stringify(output));
    }
});

test('no active matching registry preserves the ordinary Desktop workspace', async t => {
    const f = await fixture(t);
    assert.equal(await f.resolver(f.binding), null);
    await f.write({ sessionId: '77777777-7777-4777-8777-777777777777', hostSessionId: 'local_other',
        bridgeSessionId: 'session_other' });
    assert.equal(await f.resolver(f.binding), null);
    await f.write();
    f.processes.set(101, { alive: false });
    assert.equal(await f.resolver(f.binding), null);
});

test('entered, exited and switched registered worktrees follow fresh CLI cwd', async t => {
    const f = await fixture(t);
    await f.write();
    const entered = await f.resolver(f.binding);
    assert.equal(entered?.workspaceRoot, await fs.realpath(f.active));
    assert.equal(await entered.verify(), true);
    await f.write({ cwd: f.desktop });
    assert.equal(await entered.verify(), false);
    const exited = await f.resolver(f.binding);
    assert.equal(exited?.workspaceRoot, await fs.realpath(f.desktop));
    assert.equal(await exited.verify(), true);
    await f.write({ cwd: f.second });
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(f.second));
});

test('ordinary non-Git cwd and its real child remain valid without Git proof', async t => {
    const f = await fixture(t);
    f.repositories.clear();
    const child = path.join(f.desktop, 'plain child');
    await fs.mkdir(child);
    for (const cwd of [f.desktop, child]) {
        await f.write({ cwd });
        const resolved = await f.resolver(f.binding);
        assert.equal(resolved?.workspaceRoot, await fs.realpath(cwd));
        assert.equal(await resolved.verify(), true);
    }
});

test('idle updatedAt changes and equivalent atomic rewrites preserve semantic evidence', async t => {
    const f = await fixture(t);
    const file = await f.write({ updatedAt: 1 });
    const resolved = await f.resolver(f.binding);
    const replacement = path.join(f.sessions, 'replacement');
    await fs.writeFile(replacement, JSON.stringify({ ...f.row, updatedAt: 2 }));
    await fs.rename(replacement, file);
    assert.equal(await resolved.verify(), true);
    assert.equal((await f.resolver(f.binding)).evidenceKey, resolved.evidenceKey);
});

test('PID birth reuse, unknown process and foreign PID domain fail closed', async t => {
    const f = await fixture(t);
    await f.write();
    for (const process of [{ alive: true, procStart: '134375438415690103' }, { alive: true }, undefined]) {
        f.processes.set(101, process);
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    }
    f.processes.set(101, { alive: true, procStart: BIRTH });
    for (const change of [{ procStart: undefined }, { pidDomain: 'win32:other-host' }, { pid: 102 }]) {
        await f.write(change);
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    }
});

test('known local, bridge, CLI, account or organization conflicts never select a candidate', async t => {
    const f = await fixture(t);
    for (const change of [{ hostSessionId: 'local_other' }, { bridgeSessionId: 'session_other' },
        { sessionId: '77777777-7777-4777-8777-777777777777' }, { accountId: 'other' },
        { organizationId: 'other' }]) {
        await f.write(change);
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true }, JSON.stringify(change));
    }
});

test('two live matching registries are ambiguous, while a confirmed dead duplicate is ignored', async t => {
    const f = await fixture(t);
    await f.write();
    await f.write({ pid: 102, cwd: f.second, updatedAt: f.row.updatedAt + 100 }, '102.json');
    f.processes.set(102, { alive: true, procStart: BIRTH });
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    f.processes.set(102, { alive: false });
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(f.active));
    assert.equal(f.getProcessQueries(), 2);
});

test('relative, absent, symbolic and sibling-prefix directories are not trusted', async t => {
    const f = await fixture(t);
    const prefix = f.desktop + '-foreign';
    const linked = path.join(f.root, 'linked workspace');
    await fs.mkdir(prefix);
    await fs.symlink(f.active, linked, 'junction');
    for (const cwd of ['relative', '', path.join(f.root, 'missing'), linked, prefix]) {
        await f.write({ cwd });
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true }, cwd);
    }
});

test('different Git common directories and unregistered same-repository worktrees fail closed', async t => {
    const f = await fixture(t);
    await f.write({ cwd: f.foreign });
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    await f.write();
    f.setRegistered([f.desktop, f.second]);
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
});

test('a real subdirectory inside a registered moved worktree is supported', async t => {
    const f = await fixture(t);
    const child = path.join(f.active, 'source');
    await fs.mkdir(child);
    await f.write({ cwd: child });
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(child));
});

test('verify freshly rejects replaced PID, removed registration and changed registry identities', async t => {
    const f = await fixture(t);
    await f.write();
    const resolved = await f.resolver(f.binding);
    f.processes.set(101, { alive: true, procStart: '134375438415690103' });
    assert.equal(await resolved.verify(), false);
    f.processes.set(101, { alive: true, procStart: BIRTH });
    f.setRegistered([f.desktop]);
    assert.equal(await resolved.verify(), false);
    f.setRegistered([f.desktop, f.active]);
    await f.write({ bridgeSessionId: 'session_other' });
    assert.equal(await resolved.verify(), false);
});

test('bounded registry scans ignore keys and reject oversized or linked numeric records', async t => {
    const f = await fixture(t, { maxRegistryBytes: 512, maxRegistryEntries: 4 });
    await f.write();
    await fs.writeFile(path.join(f.sessions, '101.key'), 'unrelated secret');
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(f.active));
    await fs.writeFile(path.join(f.sessions, '101.json'), ' '.repeat(513));
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    await fs.rm(path.join(f.sessions, '101.json'));
    await fs.symlink(f.active, path.join(f.sessions, '101.json'), 'junction');
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
});

test('Git porcelain Windows slash paths identify the canonical registered worktree', async t => {
    const f = await fixture(t);
    f.setRegistered([f.desktop, f.active].map(directory => directory.replaceAll('\\', '/')));
    await f.write();
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(f.active));
});

test('a changed source during verification cannot confirm the previous workspace', async t => {
    const f = await fixture(t);
    await f.write();
    const resolved = await f.resolver(f.binding);
    f.setProcessHook(() => f.write({ cwd: f.second }));
    assert.equal(await resolved.verify(), false);
});

test('a matching registry rewritten during its read fails closed', async t => {
    let recordFile, replacement;
    const racedFs = { ...fs, open: async (...args) => {
        const handle = await fs.open(...args);
        if (args[0] !== recordFile) return handle;
        return { stat: () => handle.stat(), close: () => handle.close(), read: async (...readArgs) => {
            const result = await handle.read(...readArgs);
            await fs.writeFile(recordFile, JSON.stringify(replacement));
            return result;
        } };
    } };
    const f = await fixture(t, { fs: racedFs });
    recordFile = await f.write();
    replacement = { ...f.row, cwd: f.second, updatedAt: 1793070243331 };
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
});

test('native Windows process birth uses precise FileTime strings, then refuses PID reuse', async t => {
    const f = await fixture(t);
    await f.write();
    let birth = BIRTH;
    const resolver = createCliWorkspaceResolver({ claudeHome: f.claudeHome, platform: 'win32',
        hostname: 'fixture-host', processCacheMs: 0, execFile: (command, args, options, callback) => {
            if (command === 'powershell.exe') return callback(null,
                JSON.stringify([{ pid: 101, alive: true, procStart: birth }]), '');
            return f.execFile(command, args, options, callback);
        } });
    const resolved = await resolver(f.binding);
    assert.equal(resolved?.workspaceRoot, await fs.realpath(f.active));
    birth = '134375438415690103';
    assert.equal(await resolved.verify(), false);
});

test('short batch process cache expires while every verification still rereads registry identity', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, processCacheMs: 250 });
    await f.write();
    const resolved = await f.resolver(f.binding);
    assert.equal(await resolved.verify(), true);
    assert.equal(f.getProcessQueries(), 1);
    await f.write({ cwd: f.second });
    assert.equal(await resolved.verify(), false);
    assert.equal(f.getProcessQueries(), 1);
    await f.write();
    f.processes.set(101, { alive: true, procStart: '134375438415690103' });
    now = 1250;
    assert.equal(await resolved.verify(), false);
    assert.equal(f.getProcessQueries(), 2);
});

test('registry directory links and total scan limits cannot trigger a Desktop fallback', async t => {
    const f = await fixture(t, { maxRegistryTotalBytes: 32 });
    await f.write();
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    const moved = path.join(f.root, 'moved sessions');
    await fs.rename(f.sessions, moved);
    await fs.symlink(moved, f.sessions, 'junction');
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    const g = await fixture(t, { maxRegistryEntries: 1 });
    await g.write();
    await fs.writeFile(path.join(g.sessions, '102.key'), 'never read this');
    assert.deepEqual(await g.resolver(g.binding), { unavailable: true });
});

test('hard linked numeric registry records are rejected before reading their content', async t => {
    const f = await fixture(t);
    const file = await f.write();
    await fs.link(file, path.join(f.root, 'linked registry'));
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
});

test('a registry directory removed after a live match is unsafe during resolution', async t => {
    const f = await fixture(t);
    await f.write();
    f.setProcessHook(() => fs.rm(f.sessions, { recursive: true }));
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
});

test('a missing registry directory is an ordinary fallback without reading key files', async t => {
    const guardedFs = { ...fs, open: async (file, ...args) => {
        if (file.endsWith('.key')) throw new Error('Credential file must not be opened');
        return fs.open(file, ...args);
    } };
    const f = await fixture(t, { fs: guardedFs });
    await f.write();
    await fs.writeFile(path.join(f.sessions, '101.key'), 'never opened');
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(f.active));
    await fs.rm(f.sessions, { recursive: true });
    assert.equal(await f.resolver(f.binding), null);
});

test('moved directories require the exact Desktop host identity even when bridge is omitted', async t => {
    const f = await fixture(t);
    for (const change of [{ hostSessionId: undefined },
        { hostSessionId: undefined, bridgeSessionId: undefined }]) {
        await f.write(change);
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    }
});

test('new registries may omit bridge while host, CLI and process identity remain exact', async t => {
    const f = await fixture(t);
    for (const cwd of [f.active, f.desktop]) {
        await f.write({ cwd, bridgeSessionId: undefined });
        const resolved = await f.resolver(f.binding);
        assert.equal(resolved?.workspaceRoot, await fs.realpath(cwd));
        assert.equal(await resolved.verify(), true);
        await f.write({ cwd, bridgeSessionId: 'session_conflict' });
        assert.equal(await resolved.verify(), false);
        assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    }
});

test('returned-root relocation proof only accepts a fresh registered related workspace', async t => {
    const f = await fixture(t);
    await f.write({ cwd: f.desktop, bridgeSessionId: undefined });
    assert.equal(typeof f.resolver.resolveRelocationVerified, 'function');
    const root = await f.resolver.resolveVerified(f.binding);
    const history = await f.resolver.resolveRelocationVerified(f.binding, f.active);
    assert.equal(history.workspaceRoot, await fs.realpath(f.desktop));
    assert.equal(history.evidenceKey, root.evidenceKey);
    assert.equal(typeof history.relocationEvidence, 'string');
    assert.deepEqual(await f.resolver.resolveRelocationVerified(f.binding, f.foreign), { unavailable: true });
    f.setRegistered([f.desktop]);
    assert.deepEqual(await f.resolver.resolveRelocationVerified(f.binding, f.active), { unavailable: true });
    f.setRegistered([f.desktop, f.active]);
    f.processes.set(101, { alive: true, procStart: '134375438415690103' });
    assert.deepEqual(await f.resolver.resolveRelocationVerified(f.binding, f.active), { unavailable: true });
});

test('historical directory replacement during proof cannot confirm a relocation', async t => {
    const f = await fixture(t);
    await f.write({ cwd: f.desktop, bridgeSessionId: undefined });
    let replaced = false;
    const resolver = createCliWorkspaceResolver({ claudeHome: f.claudeHome, platform: 'win32',
        hostname: 'fixture-host', getProcessIdentities: async () => f.processes,
        execFile: async (command, args, options, callback) => {
            if (!replaced && args.includes('worktree')) {
                replaced = true;
                await fs.rename(f.active, f.active + '-old');
                await fs.mkdir(f.active);
            }
            f.execFile(command, args, options, callback);
        } });
    assert.equal(typeof resolver.resolveRelocationVerified, 'function');
    assert.deepEqual(await resolver.resolveRelocationVerified(f.binding, f.active), { unavailable: true });
});

test('historical UNC and Windows device paths are rejected before any filesystem probe', async t => {
    const targets = ['\\\\unavailable-server\\share\\history', '//unavailable-server/share/history',
        '\\/unavailable-server/share/history', '/\\unavailable-server/share/history',
        '\\\\?\\C:\\history', '//?/C:/history', '\\\\.\\pipe\\history', '//./pipe/history',
        '\\??\\C:\\history', '\\Device\\Mup\\unavailable-server\\share\\history'];
    const unsafe = new Set(targets.map(value => path.resolve(value)));
    const probes = [];
    const guardedFs = { ...fs, lstat: async file => {
        probes.push(file);
        if (unsafe.has(file)) throw Object.assign(new Error('Remote/device path must not be probed'), { code: 'ENOENT' });
        return fs.lstat(file);
    }, realpath: async file => {
        probes.push(file);
        if (unsafe.has(file)) throw new Error('Remote/device path must not be probed');
        return fs.realpath(file);
    } };
    const f = await fixture(t, { fs: guardedFs });
    await f.write({ cwd: f.desktop, bridgeSessionId: undefined });
    for (const cwd of targets) {
        probes.length = 0;
        assert.deepEqual(await f.resolver.resolveRelocationVerified(f.binding, cwd), { unavailable: true });
        assert.deepEqual(probes, [], cwd);
    }
    assert.equal((await f.resolver.resolveRelocationVerified(f.binding, f.active)).workspaceRoot,
        await fs.realpath(f.desktop));
});

test('nested foreign and unregistered worktrees cannot bypass Git association as Desktop children', async t => {
    const f = await fixture(t);
    const nested = path.join(f.desktop, 'nested worktree');
    const child = path.join(nested, 'source');
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(path.join(nested, '.git'), 'gitdir: fixture-only');
    f.repositories.set(nested, path.join(f.foreign, '.git'));
    await f.write({ cwd: child });
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    f.repositories.set(nested, f.common);
    assert.deepEqual(await f.resolver(f.binding), { unavailable: true });
    f.setRegistered([f.desktop, nested]);
    assert.equal((await f.resolver(f.binding))?.workspaceRoot, await fs.realpath(child));
});

test('same canonical Desktop roots retain legacy binding without platform birth guesses', async t => {
    for (const platform of ['win32', 'linux', 'darwin']) {
        const f = await fixture(t, { platform, getProcessIdentities: async () => {
            throw new Error('No process probe needed for the original Desktop root');
        } });
        await f.write({ cwd: f.desktop, hostSessionId: undefined, bridgeSessionId: undefined,
            procStart: undefined, pidDomain: undefined, startedAt: undefined });
        assert.equal(await f.resolver(f.binding), null, platform);
    }
});

test('unsupported native process platforms never guess moved-workspace birth formats', async t => {
    const f = await fixture(t);
    for (const platform of ['linux', 'darwin']) {
        await f.write({ pidDomain: `${platform}:fixture-host` });
        const resolver = createCliWorkspaceResolver({ claudeHome: f.claudeHome, platform,
            hostname: 'fixture-host', execFile: f.execFile });
        assert.deepEqual(await resolver(f.binding), { unavailable: true });
    }
});
