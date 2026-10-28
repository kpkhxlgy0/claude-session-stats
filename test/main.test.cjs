'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startMain } = require('../src/main.cjs');
const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
function fixture(extra = {}) {
    let handler, disposed = false;
    const calls = [];
    const api = { manifest: { id: 'com.kpk.session-stats' },
        ipc: { handle(name, fn) { if (name === 'stats') handler = fn; } }, log: { info() {} } };
    const options = { claudeData: 'unused', claudeHome: 'unused', ipcMain: { handle() {}, removeHandler() {} },
        publisher: { start() {}, readLocal: async () => null, stop() {} },
        resolveSession: async (_, id) => id === LOCAL ? CLI : null,
        store: { getStats: async id => { calls.push(id); return { status: 'ok', threadId: id, turns: 3, tps: null }; },
            dispose() { disposed = true; } }, ...extra };
    const controller = startMain(api, options);
    return { read: id => handler(id), controller, calls, disposed: () => disposed };
}
test('maps explicit Desktop key to UUID and correlates response with requested route', async () => {
    const f = fixture();
    assert.deepEqual(await f.read(LOCAL), { status: 'ok', threadId: LOCAL, turns: 3, tps: null });
    assert.deepEqual(f.calls, [CLI]); f.controller.stop();
});

test('bound local route returns the exact published sample without a second statistics read', async () => {
    const sample = { status: 'ok', turns: 4, tps: 35.125, snapshotRevision: 7,
        snapshotGeneratedAt: 100000, snapshotPublisherId: CLI };
    let started = 0, stopped = 0;
    const f = fixture({ publisher: { start() { started++; },
        async readLocal(id) { assert.equal(id, LOCAL); return sample; }, stop() { stopped++; } } });
    assert.deepEqual(await f.read(LOCAL), { ...sample, threadId: LOCAL });
    assert.deepEqual(f.calls, []);
    assert.equal(started, 1);
    f.controller.stop(); f.controller.stop();
    assert.equal(stopped, 1);
});

test('failed publication cannot fall back to a differently calculated local sample', async () => {
    const f = fixture({ publisher: { start() {}, async readLocal() { return { status: 'unavailable', tps: null }; }, stop() {} } });
    assert.equal((await f.read(LOCAL)).status, 'unavailable');
    assert.deepEqual(f.calls, []);
    f.controller.stop();
});

test('renderer requests a committed sample without waiting for the global publication poll', async () => {
    const seen = [];
    const f = fixture({ publisher: { start() {}, stop() {}, async readLocal(id, options) {
        seen.push({ id, options });
        return { status: 'unavailable', tps: null };
    } } });
    assert.equal((await f.read(LOCAL)).status, 'unavailable');
    assert.deepEqual(seen, [{ id: LOCAL, options: { waitForPoll: false } }]);
    assert.deepEqual(f.calls, []);
    f.controller.stop();
});

test('stop during a snapshot read invalidates its late local reply', async () => {
    let finish;
    const f = fixture({ publisher: { start() {}, readLocal: () => new Promise(resolve => { finish = resolve; }), stop() {} } });
    const pending = f.read(LOCAL);
    f.controller.stop();
    if (finish) finish({ status: 'ok', turns: 1, tps: 99 });
    assert.equal((await pending).status, 'unavailable');
    assert.deepEqual(f.calls, []);
});

test('main registers the Remote Control bridge and removes it on stop', () => {
    const channels = new Map();
    const f = fixture({ ipcMain: { handle(name, handler) { channels.set(name, handler); },
        removeHandler(name) { channels.delete(name); } } });
    assert.equal(channels.has('claudepp:com.kpk.session-stats:remote-stats'), true);
    f.controller.stop(); assert.equal(channels.size, 0);
});
test('unknown mappings cannot fall back to most recent log', async () => {
    const f = fixture({ resolveSession: async () => null });
    assert.equal((await f.read(LOCAL)).status, 'unavailable'); assert.deepEqual(f.calls, []); f.controller.stop();
});
test('mapping changes during I/O cannot return statistics for the old session', async () => {
    let calls = 0;
    const f = fixture({ resolveSession: async () => ++calls === 1 ? CLI : null });
    assert.equal((await f.read(LOCAL)).status, 'unavailable'); f.controller.stop();
});
test('dispose is idempotent and pending work cannot publish afterwards', async () => {
    let resolve;
    const f = fixture({ resolveSession: async () => new Promise(r => { resolve = r; }) });
    const result = f.read(LOCAL);
    while (!resolve) await new Promise(done => setImmediate(done));
    f.controller.stop(); f.controller.stop(); resolve(CLI);
    assert.equal((await result).status, 'unavailable'); assert.deepEqual(f.calls, []);
    assert.equal(f.disposed(), true);
    assert.equal((await f.read(LOCAL)).status, 'unavailable');
});
test('dispose during final identity confirmation also invalidates reply', async () => {
    let resolveFinal, reads = 0;
    const f = fixture({ resolveSession: async () => ++reads === 1 ? CLI
        : new Promise(resolve => { resolveFinal = resolve; }) });
    const pending = f.read(LOCAL);
    while (!resolveFinal) await new Promise(resolve => setImmediate(resolve));
    f.controller.stop(); resolveFinal(CLI);
    assert.equal((await pending).status, 'unavailable');
});
