'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { createSnapshotAccess } = require('../src/snapshot-access.cjs');

const ORG = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CLI = '33333333-3333-4333-8333-333333333333';
const DIRECTORY = 'D:/Claude 配置/.session-stats';
const PAGE_URL = 'https://claude.ai/new';
const LOCAL = 'local_44444444-4444-4444-8444-444444444444';
const NEXT_LOCAL = 'local_55555555-5555-4555-8555-555555555555';
const binding = (suffix = 'one', change = {}) => ({ localSessionId: suffix === 'one' ? LOCAL : suffix === 'two' ? NEXT_LOCAL
    : `local_00000000-0000-4000-8000-${String(Number(suffix) + 1).padStart(12, '0')}`,
    cliSessionId: CLI, bridgeSessionId: `session_${suffix}`, organizationId: ORG,
    accountId: ACCOUNT, directory: DIRECTORY, ...change });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
    let clock = 100000, bindings = options.bindings ?? [binding()];
    const native = new Map(), gets = [], writes = [], scripts = [], logs = [], verifications = [];
    for (const candidate of bindings) native.set(candidate.localSessionId, {
        sessionId: candidate.localSessionId, bridgeSessionId: candidate.bridgeSessionId,
        bridgeSessionIds: [candidate.bridgeSessionId], additionalDirectories: [],
        remoteTarget: undefined, sshConfig: undefined,
    });
    const localSessions = {
        async getSession(id) {
            gets.push(id);
            return options.getSession ? options.getSession(id, native) : native.get(id);
        },
        async addDirectories(id, directories) {
            writes.push({ id, directories: [...directories] });
            const accepted = options.addDirectories ? await options.addDirectories(id, directories) : true;
            if (accepted === true) native.get(id).additionalDirectories.push(...directories);
            return accepted;
        },
    };
    const window = { location: { href: options.url ?? PAGE_URL }, 'claude.web': { LocalSessions: localSessions } };
    const context = vm.createContext({ window, URL, Date: options.pageDate ?? Date });
    const frame = { url: window.location.href, executeJavaScript(script) {
        scripts.push(script);
        return vm.runInContext(script, context);
    } };
    const sender = { mainFrame: frame, isDestroyed: () => false }, senders = [sender];
    const source = {
        listLocalSnapshotAccess: () => bindings,
        async verifyLocalSnapshotAccess(candidate) {
            verifications.push(candidate);
            return options.verify ? options.verify(candidate) : true;
        },
    };
    const controller = createSnapshotAccess({ source, getWebContents: () => senders, now: () => clock,
        pollMs: 60000, log: message => logs.push(message) });
    t.after(() => controller.stop());
    return { controller, frame, sender, senders, window, localSessions, native, gets, writes, scripts, logs, source, verifications,
        set bindings(value) { bindings = value; }, get bindings() { return bindings; },
        set clock(value) { clock = value; }, get clock() { return clock; } };
}

test('registers existing and newly discovered bindings once without sending identity fields to the native API', async t => {
    const f = fixture(t);
    await f.controller.start();
    assert.deepEqual(f.writes, [{ id: LOCAL, directories: [DIRECTORY] }]);
    assert.deepEqual(f.native.get(LOCAL).additionalDirectories, [DIRECTORY]);
    await f.controller.start();
    assert.equal(f.writes.length, 1);
    const next = binding('two');
    f.bindings = [...f.bindings, next];
    f.native.set(NEXT_LOCAL, { sessionId: NEXT_LOCAL, bridgeSessionIds: ['session_two'], additionalDirectories: [] });
    await f.controller.start();
    assert.deepEqual(f.writes.map(write => write.id), [LOCAL, NEXT_LOCAL]);
    assert.ok(f.logs.some(message => /accepted/.test(message)));
    assert.ok(f.logs.every(message => !/remote.read.*success|CLI permission|D:\//i.test(message)));
});

test('uses native exact directory membership instead of treating an ancestor directory as sufficient', async t => {
    const f = fixture(t);
    f.native.get(LOCAL).additionalDirectories = [DIRECTORY];
    await f.controller.start();
    assert.equal(f.writes.length, 0);
    f.native.get(LOCAL).additionalDirectories = ['D:/Claude 配置'];
    f.clock += 30000;
    await f.controller.start();
    assert.deepEqual(f.writes, [{ id: LOCAL, directories: [DIRECTORY] }]);
});

test('rechecks native permissions periodically and repairs a restored session that lost the directory', async t => {
    const f = fixture(t);
    await f.controller.start();
    f.native.get(LOCAL).additionalDirectories = [];
    f.clock += 29999;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
    f.clock++;
    await f.controller.start();
    assert.equal(f.writes.length, 2);
});

test('does not grant directory access for an unverified producer identity', async t => {
    const f = fixture(t, { verify: () => false });
    await f.controller.start();
    assert.equal(f.gets.length, 1);
    assert.equal(f.writes.length, 0);
});

test('rejects identity changes during producer verification', async t => {
    const gate = deferred();
    const f = fixture(t, { verify: () => gate.promise });
    const pending = f.controller.start();
    await turn();
    f.bindings = [binding('one', { accountId: ORG })];
    gate.resolve(true);
    await pending;
    assert.equal(f.gets.length, 1);
    assert.equal(f.writes.length, 0);
});

test('rejects identity changes while native getSession is pending', async t => {
    const gate = deferred();
    const f = fixture(t, { getSession: () => gate.promise });
    const pending = f.controller.start();
    await turn();
    assert.deepEqual(f.gets, [LOCAL]);
    f.bindings = [binding('one', { bridgeSessionId: 'session_changed' })];
    gate.resolve(f.native.get(LOCAL));
    await pending;
    assert.equal(f.writes.length, 0);
});

test('verifies producer metadata after native inspection before granting access', async t => {
    let readsAtVerification;
    const f = fixture(t, { verify: () => { readsAtVerification = f.gets.length; return false; } });
    await f.controller.start();
    assert.deepEqual(f.gets, [LOCAL]);
    assert.equal(readsAtVerification, 1);
    assert.equal(f.verifications.length, 1);
    assert.equal(f.writes.length, 0);
});

test('ignores conflicting producer bindings for the same local session', async t => {
    const f = fixture(t, { bindings: [binding(), binding('one', { cliSessionId: ACCOUNT })] });
    await f.controller.start();
    assert.equal(f.gets.length, 0);
    assert.equal(f.writes.length, 0);
});

test('multiple historical bridges for the same verified local identity grant the directory once', async t => {
    const f = fixture(t, { bindings: [binding(), binding('one', { bridgeSessionId: 'session_other' })] });
    f.native.get(LOCAL).bridgeSessionIds = ['session_one', 'session_other'];
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('retries another verified bridge alias when the native DTO exposes only its current singular bridge', async t => {
    const f = fixture(t, { bindings: [binding('one', { bridgeSessionId: 'session_old' }), binding()] });
    Object.assign(f.native.get(LOCAL), { bridgeSessionId: 'session_one', bridgeSessionIds: undefined });
    await f.controller.start();
    assert.equal(f.writes.length, 0);
    f.clock += 2000;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('rejects unsafe directories and incomplete identity records before native calls', async t => {
    for (const change of [
        { directory: 'D:/.session-stats' }, { directory: '/.session-stats' },
        { directory: 'D:/Claude 配置' }, { directory: 'D:/Claude 配置/.session-stats/' },
        { directory: 'D:/Claude 配置/../.session-stats' }, { directory: 'D:/.session-stats/../.session-stats' },
        { directory: '\\\\host\\share\\.session-stats' }, { directory: '//host/share/.session-stats' },
        { directory: '\\\\?\\D:\\Claude\\.session-stats' }, { directory: 'relative/.session-stats' },
        { directory: 'D:/con/.session-stats' }, { directory: 'D:/Claude 配置/.session-stats\n' },
        { directory: 'D:/Claude 配置:alternate/.session-stats' }, { directory: '/dev/.session-stats' },
        { localSessionId: 'session_one' }, { cliSessionId: '' }, { bridgeSessionId: LOCAL },
        { organizationId: '' }, { accountId: '' },
    ]) {
        const f = fixture(t, { bindings: [binding('one', change)] });
        await f.controller.start();
        assert.equal(f.gets.length, 0, JSON.stringify(change));
        assert.equal(f.writes.length, 0, JSON.stringify(change));
    }
});

test('accepts absolute private snapshot paths on Windows and POSIX', async t => {
    for (const directory of ['D:\\Claude 配置\\.session-stats', '/home/user/.claude/.session-stats']) {
        const f = fixture(t, { bindings: [binding('one', { directory })] });
        await f.controller.start();
        assert.deepEqual(f.writes, [{ id: LOCAL, directories: [directory] }]);
    }
});

test('uses only trusted main frames and accepts the Desktop app origin', async t => {
    for (const url of ['about:blank', 'http://claude.ai/new', 'https://claude.ai.evil.test/new',
        'https://claude.ai:444/new', 'https://user@claude.ai/new', 'app://localhost:123/new',
        'app://user@localhost/new', 'app://localhost.evil.test/new', 'file:///new']) {
        const f = fixture(t, { url });
        await f.controller.start();
        assert.equal(f.scripts.length, 0, url);
        assert.equal(f.writes.length, 0, url);
    }
    const f = fixture(t, { url: 'app://localhost/code/session_one' });
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('page script independently checks the captured URL before any native call', async t => {
    const f = fixture(t);
    f.window.location.href = 'https://evil.test/new';
    await f.controller.start();
    assert.equal(f.gets.length, 0);
    assert.equal(f.writes.length, 0);
});

test('navigation or main frame replacement during native inspection prevents the write', async t => {
    for (const replace of [false, true]) {
        const gate = deferred();
        const f = fixture(t, { getSession: () => gate.promise });
        const pending = f.controller.start();
        await turn();
        if (replace) f.sender.mainFrame = { ...f.frame };
        else f.frame.url = f.window.location.href = 'https://claude.ai/other';
        gate.resolve(f.native.get(LOCAL));
        await pending;
        assert.equal(f.writes.length, 0);
    }
});

test('native session must match the local ID and bridge and have no remote target or SSH configuration', async t => {
    for (const change of [
        { sessionId: 'local_other' }, { bridgeSessionId: 'session_other', bridgeSessionIds: [] },
        { bridgeSessionId: undefined, bridgeSessionIds: undefined },
        { remoteTarget: {} }, { remoteTarget: 'remote' }, { sshConfig: {} }, { sshConfig: 'host' },
        { additionalDirectories: '/arbitrary' },
    ]) {
        const f = fixture(t);
        Object.assign(f.native.get(LOCAL), change);
        await f.controller.start();
        assert.equal(f.writes.length, 0, JSON.stringify(change));
    }
});

test('a missing native bridge is retried after it becomes available', async t => {
    const f = fixture(t);
    delete f.window['claude.web'];
    await f.controller.start();
    assert.equal(f.writes.length, 0);
    f.window['claude.web'] = { LocalSessions: f.localSessions };
    f.clock += 2000;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('rotates trusted frames so a window without the native bridge cannot starve an eligible window', async t => {
    const f = fixture(t), window = { location: { href: PAGE_URL } };
    const context = vm.createContext({ window, URL });
    f.senders.unshift({ mainFrame: { url: PAGE_URL, executeJavaScript: script => vm.runInContext(script, context) } });
    await f.controller.start();
    assert.equal(f.writes.length, 0);
    f.clock += 2000;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('tries every bridge and frame combination instead of rotating both choices in lockstep', async t => {
    const f = fixture(t, { bindings: [binding('one', { bridgeSessionId: 'session_old' }), binding()] });
    Object.assign(f.native.get(LOCAL), { bridgeSessionId: 'session_one', bridgeSessionIds: undefined });
    const window = { location: { href: PAGE_URL } }, context = vm.createContext({ window, URL, Date });
    f.senders.push({ mainFrame: { url: PAGE_URL, executeJavaScript: script => vm.runInContext(script, context) } });
    for (let tick = 0; tick < 10 && !f.writes.length; tick++) {
        await f.controller.start();
        f.clock += 10000;
    }
    assert.equal(f.writes.length, 1);
});

test('a queued apply delivered after timeout and stop cannot grant directory access', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    // Keep the page clock behind the deadline so this checks cancellation
    // independently from the separate expired-command regression.
    const f = fixture(t, { pageDate: { now: () => 100000 } }), execute = f.frame.executeJavaScript, gate = deferred();
    let calls = 0, queued;
    f.frame.executeJavaScript = script => {
        if (++calls === 2) { queued = script; return gate.promise; }
        return execute(script);
    };
    const pending = f.controller.start();
    await turn();
    assert.ok(queued);
    t.mock.timers.tick(5000);
    await pending;
    await f.controller.stop();
    gate.resolve(await execute(queued));
    await turn();
    assert.equal(f.writes.length, 0);
});

test('an expired queued apply cannot grant access even before the controller is stopped', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const f = fixture(t), execute = f.frame.executeJavaScript, gate = deferred();
    let calls = 0, queued;
    f.frame.executeJavaScript = script => {
        if (++calls === 2) { queued = script; return gate.promise; }
        return execute(script);
    };
    const pending = f.controller.start();
    await turn();
    assert.ok(queued);
    t.mock.timers.tick(5000);
    await pending;
    gate.resolve(await execute(queued));
    await turn();
    assert.equal(f.writes.length, 0);
});

test('already granted native sessions do not repeat filesystem and workspace verification', async t => {
    const f = fixture(t);
    f.native.get(LOCAL).additionalDirectories = [DIRECTORY];
    await f.controller.start();
    f.clock += 30000;
    await f.controller.start();
    assert.equal(f.verifications.length, 0);
    assert.equal(f.writes.length, 0);
});

test('truthy nonboolean native grants are retried and never cached as accepted', async t => {
    const f = fixture(t, { addDirectories: () => 'true' });
    await f.controller.start();
    assert.equal(f.native.get(LOCAL).additionalDirectories.length, 0);
    assert.equal(f.logs.filter(message => /accepted/.test(message)).length, 0);
    f.clock += 2000;
    await f.controller.start();
    assert.equal(f.writes.length, 2);
});

test('timed out native reads do not accumulate unresolved native invocations', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred();
    const f = fixture(t, { getSession: () => gate.promise });
    const first = f.controller.start();
    await turn();
    t.mock.timers.tick(5000);
    await first;
    f.clock += 2000;
    const second = f.controller.start();
    await turn();
    assert.equal(f.gets.length, 1);
    await second;
    gate.resolve(f.native.get(LOCAL));
    await turn();
    f.clock += 4000;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('timed out producer verification does not accumulate repeated unresolved file checks', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred();
    const f = fixture(t, { verify: () => gate.promise });
    const first = f.controller.start();
    await turn();
    t.mock.timers.tick(5000);
    await first;
    f.clock += 2000;
    const second = f.controller.start();
    await turn();
    t.mock.timers.tick(5000);
    await second;
    assert.equal(f.verifications.length, 1);
    gate.resolve(true);
    await turn();
    f.clock += 4000;
    await f.controller.start();
    assert.equal(f.writes.length, 1);
});

test('failed native grants back off between two and ten seconds and accept only boolean true', async t => {
    let result = false;
    const f = fixture(t, { addDirectories: () => result });
    for (const delay of [0, 2000, 4000, 8000, 10000]) {
        if (delay) {
            f.clock += delay - 1;
            const count = f.writes.length;
            await f.controller.start();
            assert.equal(f.writes.length, count);
            f.clock++;
        }
        await f.controller.start();
    }
    assert.equal(f.writes.length, 5);
    assert.equal(f.logs.filter(message => /accepted/.test(message)).length, 0);
    result = true;
    f.clock += 10000;
    await f.controller.start();
    assert.equal(f.writes.length, 6);
    assert.equal(f.logs.filter(message => /accepted/.test(message)).length, 1);
});

test('stop prevents a late native inspection from dispatching addDirectories', async t => {
    const gate = deferred();
    const f = fixture(t, { getSession: () => gate.promise });
    const pending = f.controller.start();
    await turn();
    await f.controller.stop();
    gate.resolve(f.native.get(LOCAL));
    await pending;
    await turn();
    assert.equal(f.writes.length, 0);
    await f.controller.start();
    assert.equal(f.gets.length, 1);
});

test('stop during verification prevents the grant and resolves without waiting for producer IO', async t => {
    const gate = deferred();
    const f = fixture(t, { verify: () => gate.promise });
    const pending = f.controller.start();
    await turn();
    await f.controller.stop();
    gate.resolve(true);
    await pending;
    assert.equal(f.gets.length, 1);
    assert.equal(f.writes.length, 0);
});

test('one in-flight sweep is shared and each sweep has a bounded fair session budget', async t => {
    const gate = deferred(), bindings = Array.from({ length: 40 }, (_, index) => binding(String(index)));
    let blocked = true;
    const f = fixture(t, { bindings, getSession: async (id, native) => {
        if (blocked) await gate.promise;
        return native.get(id);
    } });
    const first = f.controller.start();
    await turn();
    const repeated = f.controller.start();
    assert.equal(f.gets.length, 1);
    blocked = false; gate.resolve();
    await Promise.all([first, repeated]);
    assert.ok(f.writes.length > 0 && f.writes.length <= 8);
    for (let tick = 0; tick < 20 && f.writes.length < 40; tick++) await f.controller.start();
    assert.equal(new Set(f.writes.map(write => write.id)).size, 40);
    assert.equal(f.writes.length, 40);
});
