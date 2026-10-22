'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startMain } = require('../src/main.cjs');
const LOCAL = 'local_11111111-1111-4111-8111-111111111111';
const CLI = '22222222-2222-4222-8222-222222222222';
function fixture(extra = {}) {
    let handler, disposed = false;
    const calls = [];
    const api = { ipc: { handle(name, fn) { assert.equal(name, 'stats'); handler = fn; } }, log: { info() {} } };
    const options = { claudeData: 'unused', claudeHome: 'unused',
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
    const result = f.read(LOCAL); f.controller.stop(); f.controller.stop(); resolve(CLI);
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
