'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteBridge } = require('../src/remote-bridge.cjs');

const SCRIPT = '(() => null)()';
const CLEANUP_SCRIPT = '(() => undefined)()';
const URL = 'https://claude.ai/code/session_example-123';
const STATS = {
    threadId: 'session_example-123', source: 'remote_control', status: 'ok',
    turns: 3, steps: 2, totalTokens: 150, inputTokens: 100, outputTokens: 50,
    cachedInputTokens: 25, cacheHit: 0.25, tps: 12.5, usageComplete: true,
};

function fixture(t, { url = URL, execute = () => STATS, timeoutMs, cleanupScript } = {}) {
    let handler;
    const calls = [], removed = [];
    const frame = { url, executeJavaScript(...args) { calls.push(args); return execute(...args); } };
    const sender = { mainFrame: frame };
    const event = { senderFrame: frame, sender };
    const controller = createRemoteBridge({
        ipcMain: {
            handle(channel, callback) {
                assert.equal(channel, 'claudepp:session-stats:remote-stats');
                handler = callback;
            },
            removeHandler(channel) { removed.push(channel); },
        },
        manifestId: 'session-stats', script: SCRIPT, timeoutMs, cleanupScript,
    });
    t.after(() => controller.stop());
    return { read: (...args) => handler(...(args.length ? args : [event])),
        frame, sender, event, controller, calls, removed };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('runs only the fixed script and projects statistics without page extras', async t => {
    const f = fixture(t, { execute: () => ({ ...STATS,
        body: 'private conversation', credentials: 'secret', extra: { cookie: 'secret' } }) });
    assert.deepEqual(await f.read(f.event, 'window.credentials', { script: 'window.credentials' }), STATS);
    assert.deepEqual(f.calls, [[SCRIPT]]);
});

test('accepts the trusted app origin', async t => {
    const f = fixture(t, { url: 'app://localhost/code/session_example-123' });
    assert.deepEqual(await f.read(), STATS);
});

test('rejects absent events and subframes before reading page state', async t => {
    const f = fixture(t);
    for (const event of [null, {}, { sender: f.sender }, { senderFrame: f.frame },
        { senderFrame: { ...f.frame }, sender: f.sender }]) {
        assert.equal(await f.read(event), null);
    }
    assert.deepEqual(f.calls, []);
});

test('rejects untrusted and noncanonical origins before reading page state', async t => {
    const f = fixture(t);
    for (const url of ['', 'not a URL', 'http://claude.ai/code/session_example-123',
        'https://claude.ai.evil.test/code/session_example-123',
        'https://evil.test/?https://claude.ai', 'https://claude.ai:444/code/session_example-123',
        'https://user:password@claude.ai/code/session_example-123',
        'app://localhost.evil.test/code/session_example-123',
        'app://user:password@localhost/code/session_example-123',
        'app://localhost:123/code/session_example-123', 'file:///code/session_example-123']) {
        f.frame.url = url;
        assert.equal(await f.read(), null, url);
    }
    assert.deepEqual(f.calls, []);
});

test('discards a response after the main frame URL changes', async t => {
    const page = deferred();
    const f = fixture(t, { execute: () => page.promise });
    const pending = f.read();
    f.frame.url = 'https://claude.ai/code/session_other';
    page.resolve(STATS);
    assert.equal(await pending, null);
});

test('discards a response after the sender main frame identity changes', async t => {
    const page = deferred();
    const f = fixture(t, { execute: () => page.promise });
    const pending = f.read();
    f.sender.mainFrame = { ...f.frame };
    page.resolve(STATS);
    assert.equal(await pending, null);
});

test('discards a response after the event sender frame identity changes', async t => {
    const page = deferred();
    const f = fixture(t, { execute: () => page.promise });
    const pending = f.read();
    f.event.senderFrame = { ...f.frame };
    page.resolve(STATS);
    assert.equal(await pending, null);
});

test('returns null for missing page state and malformed remote identities', async t => {
    let response;
    const f = fixture(t, { execute: () => response });
    for (const value of [null, undefined, [], {}, { ...STATS, status: 'unavailable' },
        { ...STATS, source: 'local' }, { ...STATS, threadId: 'local_example-123' },
        { ...STATS, threadId: 'session_' }, { ...STATS, threadId: 'session_bad/path' },
        { ...STATS, threadId: 'session_' + 'x'.repeat(129) }, { ...STATS, usageComplete: 'true' }]) {
        response = value;
        assert.equal(await f.read(), null);
    }
});

test('preserves valid zero and maximum safe counts with incomplete usage', async t => {
    const f = fixture(t, { execute: () => ({ ...STATS,
        threadId: 'session_' + 'x'.repeat(128), turns: 0, steps: null,
        totalTokens: Number.MAX_SAFE_INTEGER, inputTokens: null, outputTokens: 0,
        cachedInputTokens: null, cacheHit: 0, tps: null, usageComplete: false }) });
    assert.deepEqual(await f.read(), {
        threadId: 'session_' + 'x'.repeat(128), source: 'remote_control', status: 'ok',
        turns: 0, steps: null, totalTokens: Number.MAX_SAFE_INTEGER, inputTokens: null,
        outputTokens: 0, cachedInputTokens: null, cacheHit: 0, tps: null, usageComplete: false,
    });
});

test('normalizes each missing or invalid count without discarding the session', async t => {
    let response = STATS;
    const f = fixture(t, { execute: () => response });
    for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens']) {
        for (const value of [undefined, null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3']) {
            response = { ...STATS, [field]: value };
            assert.deepEqual(await f.read(), { ...STATS, [field]: null }, `${field}: ${value}`);
        }
    }
});

test('bounds cache ratio and normalizes invalid token rates', async t => {
    let response = STATS;
    const f = fixture(t, { execute: () => response });
    for (const value of [undefined, null, -1, 1.01, NaN, Infinity, '0.5']) {
        response = { ...STATS, cacheHit: value };
        assert.deepEqual(await f.read(), { ...STATS, cacheHit: null });
    }
    response = { ...STATS, cacheHit: 1 };
    assert.deepEqual(await f.read(), { ...STATS, cacheHit: 1 });
    for (const value of [undefined, null, -1, 0, NaN, Infinity, '12']) {
        response = { ...STATS, tps: value };
        assert.deepEqual(await f.read(), { ...STATS, tps: null });
    }
});

test('validates and returns the same snapshot of page result fields', async t => {
    let idReads = 0, ratioReads = 0, rateReads = 0;
    const f = fixture(t, { execute: () => ({ ...STATS,
        get threadId() { return ++idReads === 1 ? 'session_example-123' : 'private conversation'; },
        get cacheHit() { return ++ratioReads === 1 ? 0.25 : '0.5'; },
        get tps() { return ++rateReads === 1 ? 12.5 : '12'; },
    }) });
    assert.deepEqual(await f.read(), STATS);
});

test('returns null for page execution errors and exceptions while projecting state', async t => {
    let execute = () => { throw new Error('page closed'); };
    const f = fixture(t, { execute: () => execute() });
    assert.equal(await f.read(), null);
    execute = () => Promise.reject(new Error('navigation destroyed execution context'));
    assert.equal(await f.read(), null);
    execute = () => ({ ...STATS, get turns() { throw new Error('invalid result'); } });
    assert.equal(await f.read(), null);
    Object.defineProperty(f.frame, 'url', { get() { throw new Error('frame destroyed'); } });
    assert.equal(await f.read(), null);
});

test('stop is idempotent and prevents future page reads', async t => {
    const f = fixture(t);
    f.controller.stop();
    f.controller.stop();
    assert.deepEqual(f.removed, ['claudepp:session-stats:remote-stats']);
    assert.equal(await f.read(), null);
    assert.deepEqual(f.calls, []);
});

test('stop settles pending work without waiting for the page script', async t => {
    const page = deferred();
    const f = fixture(t, { execute: () => page.promise });
    let result = 'pending';
    const pending = f.read().then(value => { result = value; });
    f.controller.stop();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(result, null);
    page.reject(new Error('late page error'));
    await pending;
});

test('times out an unresponsive page and ignores its late result', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const page = deferred();
    const f = fixture(t, { execute: () => page.promise, timeoutMs: 3000 });
    const pending = f.read();
    t.mock.timers.tick(2999);
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.equal(await pending, null);
    page.resolve(STATS);
});

test('clears the request timer on success, error, and stop', async t => {
    const cleared = [];
    const clear = global.clearTimeout;
    t.mock.method(global, 'clearTimeout', timer => { cleared.push(timer); clear(timer); });
    let execute = () => STATS;
    const f = fixture(t, { execute: () => execute() });
    await f.read();
    assert.equal(cleared.length, 1);
    execute = () => Promise.reject(new Error('page closed'));
    await f.read();
    assert.equal(cleared.length, 2);
    execute = () => new Promise(() => {});
    const pending = f.read();
    f.controller.stop();
    assert.equal(await pending, null);
    assert.equal(cleared.length, 3);
});

test('cleans up only accepted main frames once using the fixed cleanup script', async t => {
    const f = fixture(t, { cleanupScript: CLEANUP_SCRIPT });
    await f.read();
    await f.read();
    const otherCalls = [];
    const otherFrame = { url: 'app://localhost/code/session_second',
        executeJavaScript(script) { otherCalls.push(script); return STATS; } };
    await f.read({ senderFrame: otherFrame, sender: { mainFrame: otherFrame } });
    await f.read({ senderFrame: { ...f.frame }, sender: f.sender });
    const untrustedCalls = [];
    const untrustedFrame = { url: 'https://evil.test/',
        executeJavaScript(script) { untrustedCalls.push(script); return STATS; } };
    await f.read({ senderFrame: untrustedFrame, sender: { mainFrame: untrustedFrame } });
    f.controller.stop();
    f.controller.stop();
    assert.deepEqual(f.calls, [[SCRIPT], [SCRIPT], [CLEANUP_SCRIPT]]);
    assert.deepEqual(otherCalls, [SCRIPT, CLEANUP_SCRIPT]);
    assert.deepEqual(untrustedCalls, []);
});

test('skips cleanup after a frame navigates away, is replaced, or is destroyed', async t => {
    for (const change of [
        f => { f.frame.url = 'https://evil.test/'; },
        f => { f.sender.mainFrame = { ...f.frame }; },
        f => { Object.defineProperty(f.frame, 'url', { get() { throw new Error('destroyed'); } }); },
    ]) {
        const f = fixture(t, { cleanupScript: CLEANUP_SCRIPT });
        await f.read();
        change(f);
        f.controller.stop();
        assert.deepEqual(f.calls, [[SCRIPT]]);
    }
});

test('cleanup execution errors cannot interrupt disposal', async t => {
    for (const fail of [() => { throw new Error('page closed'); }, () => Promise.reject(new Error('page closed'))]) {
        const f = fixture(t, { cleanupScript: CLEANUP_SCRIPT,
            execute: script => script === CLEANUP_SCRIPT ? fail() : STATS });
        await f.read();
        assert.doesNotThrow(() => f.controller.stop());
        assert.deepEqual(f.removed, ['claudepp:session-stats:remote-stats']);
        assert.deepEqual(f.calls, [[SCRIPT], [CLEANUP_SCRIPT]]);
    }
});
