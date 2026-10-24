'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const protocol = createSnapshotProtocol();
const binding = { bridgeSessionId: 'session_Test123', organizationId: '11111111-1111-4111-8111-111111111111' };
const producer = { publisherId: '22222222-2222-4222-8222-222222222222', revision: 1, now: 100000 };
const stats = { status: 'ok', turns: 2, steps: 3, totalTokens: 5200, inputTokens: 5000,
    outputTokens: 200, cachedInputTokens: 4000, cacheHit: .8, tps: 25.125, usageComplete: true };
const wire = () => ({ schemaVersion: 1, producer: 'claude-session-stats', ...binding,
    publisherId: producer.publisherId, revision: 1, generatedAt: 100000, stats: { ...stats } });

test('snapshot names are fixed to one validated bridge ID', () => {
    assert.equal(protocol.normalizeBridgeId('cse_Test123'), 'session_Test123');
    assert.equal(protocol.snapshotPath('cse_Test123'), '.claude/session-stats/session_Test123.json');
    for (const value of ['../other', 'session_../other', 'session_', 'session_a/b', null])
        assert.equal(protocol.snapshotPath(value), null);
});

test('publisher projects exact metrics and strips private source data', () => {
    const result = protocol.makeSnapshot({ ...binding, workspaceRoot: 'private path', cliSessionId: 'private id' },
        { ...stats, threadId: 'private local id', prompt: 'private prompt', extra: { secret: true } }, producer);
    assert.deepEqual(result, wire());
    assert.doesNotMatch(JSON.stringify(result), /private|secret|cliSessionId|workspaceRoot/);
});

test('matching completed snapshot preserves every numeric statistic without recomputation', () => {
    const result = protocol.parseSnapshot(JSON.stringify(wire()), { ...binding, now: 105000 });
    assert.deepEqual(result, { ok: true, snapshot: wire() });
});

test('snapshot validates session, organization, age and future clock skew', () => {
    const text = JSON.stringify(wire());
    assert.equal(protocol.parseSnapshot(text, { ...binding, bridgeSessionId: 'session_Other', now: 105000 }).reason, 'identity');
    assert.equal(protocol.parseSnapshot(text, { ...binding, organizationId: producer.publisherId, now: 105000 }).reason, 'identity');
    assert.equal(protocol.parseSnapshot(text, { ...binding, now: 130001 }).reason, 'expired');
    assert.equal(protocol.parseSnapshot(text, { ...binding, now: 94999 }).reason, 'future');
    assert.equal(protocol.parseSnapshot(text, { ...binding, now: 130000 }).ok, true);
});

test('malformed, oversized and non-whitelisted wire data cannot be accepted', () => {
    for (const text of ['{', 'null', 'x'.repeat(16385)])
        assert.equal(protocol.parseSnapshot(text, { ...binding, now: 105000 }).ok, false);
    for (const mutate of [s => s.schemaVersion = 2, s => s.producer = 'other', s => s.revision = 0,
        s => s.generatedAt = null, s => s.publisherId = '../bad', s => s.prompt = 'private',
        s => s.stats.outputTokens = -1, s => s.stats.turns = 1.5, s => s.stats.tps = 0,
        s => s.stats.cacheHit = 2, s => s.stats.usageComplete = 'true', s => s.stats.private = 'text',
        s => delete s.stats.steps]) {
        const snapshot = wire(); mutate(snapshot);
        assert.equal(protocol.parseSnapshot(JSON.stringify(snapshot), { ...binding, now: 105000 }).ok, false);
    }
});

test('unavailable source data cannot retain a previous numeric sample', () => {
    const result = protocol.makeSnapshot(binding, { ...stats, status: 'incomplete' }, producer);
    assert.equal(result?.stats.status, 'incomplete');
    assert.equal(result?.stats.tps, null);
    assert.equal(result?.stats.totalTokens, null);
    assert.equal(result?.stats.usageComplete, false);
});

test('snapshot factory runs standalone in an isolated renderer realm', () => {
    const isolated = vm.runInNewContext('(' + createSnapshotProtocol.toString() + ')()');
    assert.equal(isolated.snapshotPath('session_Test123'), '.claude/session-stats/session_Test123.json');
    assert.equal(isolated.parseSnapshot(JSON.stringify(wire()), { ...binding, now: 105000 }).snapshot?.stats.tps, 25.125);
});
