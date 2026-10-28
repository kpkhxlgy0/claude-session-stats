'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const protocol = createSnapshotProtocol();
const binding = { bridgeSessionId: 'session_Parent', organizationId: '11111111-1111-4111-8111-111111111111' };
const producer = { publisherId: '22222222-2222-4222-8222-222222222222', revision: 7, now: 100000 };
const stats = { status: 'ok', turns: 2, steps: 3, totalTokens: 50, inputTokens: 40,
    outputTokens: 10, cachedInputTokens: 20, cacheHit: .5, tps: null, usageComplete: true };

test('agent paths require an exact bounded ASCII identity and leave parent paths unchanged', () => {
    assert.equal(protocol.snapshotPath('cse_Parent'), '.claude/session-stats/session_Parent.json');
    assert.equal(protocol.snapshotPath('cse_Parent', 'agent_A-1'),
        '.claude/session-stats/session_Parent.agent-agent_A-1.json');
    assert.equal(protocol.normalizeAgentId('A_-0'), 'A_-0');
    assert.equal(protocol.normalizeAgentId('x'.repeat(64)), 'x'.repeat(64));
    for (const invalid of ['', null, 1, '../a', 'a/b', 'a\\b', 'a.b', 'a\n', 'a\r\n', '中文', 'x'.repeat(65)]) {
        assert.equal(protocol.normalizeAgentId(invalid), null);
        assert.equal(protocol.snapshotPath('session_Parent', invalid), null);
        assert.equal(protocol.makeSnapshot({ ...binding, agentId: invalid }, stats, producer), null);
    }
});

test('parent v1 stays byte-shape compatible while child v2 adds only its agent identity', () => {
    const parent = protocol.makeSnapshot(binding, stats, producer);
    assert.equal(parent.schemaVersion, 1);
    assert.equal(Object.hasOwn(parent, 'agentId'), false);
    const child = protocol.makeSnapshot({ ...binding, agentId: 'child_A', private: 'secret' }, stats, producer);
    assert.deepEqual(child, { ...parent, schemaVersion: 2, agentId: 'child_A' });
    assert.equal(protocol.parseSnapshot(JSON.stringify(parent), { ...binding, now: 100001 }).ok, true);
    assert.deepEqual(protocol.parseSnapshot(JSON.stringify(child),
        { ...binding, agentId: 'child_A', now: 100001 }), { ok: true, snapshot: child });
});

test('readers require the exact parent, organization and agent and cannot cross envelope versions', () => {
    const parent = protocol.makeSnapshot(binding, stats, producer);
    const child = protocol.makeSnapshot({ ...binding, agentId: 'child_A' }, stats, producer);
    for (const expected of [binding, { ...binding, agentId: 'child_B' }, { ...binding, agentId: null },
        { ...binding, agentId: 'child_A\n' }, { ...binding, agentId: 'child_A', bridgeSessionId: 'session_Other' },
        { ...binding, agentId: 'child_A', organizationId: producer.publisherId }])
        assert.equal(protocol.parseSnapshot(JSON.stringify(child), { ...expected, now: 100001 }).ok, false);
    assert.equal(protocol.parseSnapshot(JSON.stringify(parent),
        { ...binding, agentId: 'child_A', now: 100001 }).ok, false);
    for (const mutate of [value => value.schemaVersion = 1, value => delete value.agentId,
        value => value.agentId = 'child_A\n', value => value.prompt = 'secret']) {
        const value = structuredClone(child); mutate(value);
        assert.equal(protocol.parseSnapshot(JSON.stringify(value),
            { ...binding, agentId: 'child_A', now: 100001 }).ok, false);
    }
});

test('child protocol remains self-contained with the existing timestamp and metric validation', () => {
    const isolated = vm.runInNewContext('(' + createSnapshotProtocol.toString() + ')()');
    const value = isolated.makeSnapshot({ ...binding, agentId: 'child_A' }, stats, producer);
    assert.equal(value.schemaVersion, 2);
    assert.equal(isolated.parseSnapshot(JSON.stringify(value),
        { ...binding, agentId: 'child_A', now: 130001 }).reason, 'expired');
    assert.equal(value.stats.tps, null);
});
