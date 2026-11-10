'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createMetadataProtocol } = require('../src/metadata-protocol.cjs');

const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = 1792886400000;
const STATS = { status: 'ok', turns: 7, steps: 13, totalTokens: 1400, inputTokens: 1000,
    outputTokens: 400, cachedInputTokens: 700, cacheHit: .7, tps: 20, usageComplete: true };
const expected = { bridgeSessionId: ID, organizationId: ORG };
const protocol = createMetadataProtocol(createSnapshotProtocol);

function sample(agentId, at = NOW, changes = {}) {
    return { ...createSnapshotProtocol().makeSnapshot({ ...expected, ...(agentId ? { agentId } : {}) }, STATS,
        { publisherId: PUBLISHER, revision: 1, now: at }), ...changes };
}

function envelope(parent = sample(), agents = []) {
    return { protocolVersion: 1, ...expected, publisherId: PUBLISHER,
        generatedAt: Math.max(...[parent, ...agents].filter(Boolean).map(item => item.generatedAt)), parent, agents };
}

test('builds one numeric envelope without summing parent and child usage', () => {
    const value = protocol.makeEnvelope([sample('child_B'), sample(), sample('child_A')], { ...expected, now: NOW });
    assert.equal(protocol.key, 'claudepp_session_stats');
    assert.deepEqual(value, envelope(sample(), [sample('child_A'), sample('child_B')]));
    assert.equal(value.parent.stats.totalTokens, 1400);
    assert.equal(value.agents[0].stats.totalTokens, 1400);
    assert.deepEqual(protocol.readSnapshot(value, { ...expected, now: NOW }), { ok: true, snapshot: sample() });
    assert.deepEqual(protocol.readSnapshot(JSON.stringify(value), { ...expected, agentId: 'child_B', now: NOW }),
        { ok: true, snapshot: sample('child_B') });
});

test('a newer child never extends the selected parent age or hides its future timestamp', () => {
    const value = envelope(sample(undefined, NOW - 30001), [sample('child_A')]);
    assert.equal(protocol.parseEnvelope(value, expected).ok, true);
    assert.deepEqual(protocol.readSnapshot(value, { ...expected, now: NOW }), { ok: false, reason: 'expired' });
    assert.equal(protocol.readSnapshot(value, { ...expected, agentId: 'child_A', now: NOW }).ok, true);
    const future = envelope(sample(undefined, NOW + 5001), [sample('child_A', NOW + 6000)]);
    assert.equal(protocol.parseEnvelope(future, expected).ok, true);
    assert.deepEqual(protocol.readSnapshot(future, { ...expected, now: NOW }), { ok: false, reason: 'future' });
});

test('an unrelated fresh parent never extends a selected child age', () => {
    const value = envelope(sample(), [sample('child_A', NOW - 30001), sample('child_B')]);
    assert.deepEqual(protocol.readSnapshot(value, { ...expected, agentId: 'child_A', now: NOW }),
        { ok: false, reason: 'expired' });
    assert.equal(protocol.readSnapshot(value, { ...expected, now: NOW }).ok, true);
});

test('uses the existing inclusive 30-second age and 5-second future boundaries', () => {
    for (const at of [NOW - 30000, NOW + 5000]) {
        assert.equal(protocol.readSnapshot(envelope(sample(undefined, at)), { ...expected, now: NOW }).ok, true);
    }
    assert.deepEqual(protocol.readSnapshot(envelope(), { ...expected, now: NaN }), { ok: false, reason: 'invalid' });
});

test('make omits expired samples and derives generatedAt from included snapshots only', () => {
    assert.deepEqual(protocol.makeEnvelope([sample(undefined, NOW - 30001), sample('child_A', NOW - 5)],
        { ...expected, now: NOW }), envelope(null, [sample('child_A', NOW - 5)]));
    assert.equal(protocol.makeEnvelope([sample(undefined, NOW - 30001)], { ...expected, now: NOW }), null);
    assert.equal(protocol.makeEnvelope([], { ...expected, now: NOW }), null);
    assert.equal(protocol.makeEnvelope([sample(undefined, NOW + 5001)], { ...expected, now: NOW }), null);
});

test('make rejects ambiguous publishers, duplicate agents and duplicate parents even when expired', () => {
    for (const values of [
        [sample(), sample()], [sample('child_A'), sample('child_A')],
        [sample(), sample('child_A', NOW, { publisherId: OTHER })],
        [sample(), sample('child_A', NOW - 30001, { publisherId: OTHER })],
        [sample(), sample(undefined, NOW - 30001)],
    ]) assert.equal(protocol.makeEnvelope(values, { ...expected, now: NOW }), null);
});

test('rejects wrong expected identities and any foreign nested identity or publisher', () => {
    for (const value of [
        envelope(sample(undefined, NOW, { bridgeSessionId: 'session_Other' })),
        envelope(sample(undefined, NOW, { organizationId: OTHER })),
        envelope(sample(), [sample('child_A', NOW, { publisherId: OTHER })]),
        { ...envelope(), bridgeSessionId: 'session_Other' },
        { ...envelope(), organizationId: OTHER },
        { ...envelope(), publisherId: OTHER },
    ]) {
        assert.deepEqual(protocol.parseEnvelope(value, expected), { ok: false, reason: 'identity' });
    }
    assert.deepEqual(protocol.parseEnvelope(envelope(), { ...expected, organizationId: OTHER }),
        { ok: false, reason: 'identity' });
    assert.equal(protocol.makeEnvelope([sample(undefined, NOW, { bridgeSessionId: 'session_Other' })],
        { ...expected, now: NOW }), null);
    assert.equal(protocol.makeEnvelope([sample()], { ...expected, bridgeSessionId: 'cse_Test123', now: NOW }).parent.bridgeSessionId, ID);
});

test('missing parent or exact selected child never falls back to another snapshot', () => {
    assert.deepEqual(protocol.readSnapshot(envelope(null, [sample('child_A')]), { ...expected, now: NOW }),
        { ok: false, reason: 'missing' });
    assert.deepEqual(protocol.readSnapshot(envelope(), { ...expected, agentId: 'child_A', now: NOW }),
        { ok: false, reason: 'missing' });
    assert.deepEqual(protocol.readSnapshot(envelope(), { ...expected, agentId: '../bad', now: NOW }),
        { ok: false, reason: 'identity' });
    assert.deepEqual(protocol.parseEnvelope(undefined, expected), { ok: false, reason: 'missing' });
});

test('every nested snapshot must pass the snapshot protocol even when it is not selected', () => {
    const invalid = sample('child_A'); invalid.stats.tps = -1;
    assert.deepEqual(protocol.readSnapshot(envelope(sample(), [invalid]), { ...expected, now: NOW }),
        { ok: false, reason: 'invalid' });
    assert.deepEqual(protocol.parseEnvelope(envelope(sample('child_A')), expected), { ok: false, reason: 'invalid' });
    assert.deepEqual(protocol.parseEnvelope(envelope(null, [sample()]), expected), { ok: false, reason: 'invalid' });
});

test('malformed and inconsistent metadata envelopes fail closed', () => {
    for (const value of [
        {}, [], 'not-json', { ...envelope(), protocolVersion: 2 }, { ...envelope(), protocolVersion: '1' },
        { ...envelope(), generatedAt: NOW + 1 }, { ...envelope(), parent: undefined },
        { ...envelope(), agents: {} }, { ...envelope(), privatePrompt: 'must reject' },
        { ...envelope(), parent: null }, envelope(sample(), [sample('child_A'), sample('child_A')]),
        { ...envelope(), parent: { ...sample(), revision: 0 } },
    ]) assert.deepEqual(protocol.parseEnvelope(value, expected), { ok: false, reason: 'invalid' });
});

test('permits 128 distinct agents and rejects the 129th rather than truncating', () => {
    const agents = Array.from({ length: 128 }, (_, i) => sample(`child_${i}`));
    assert.equal(protocol.parseEnvelope(envelope(sample(), agents), expected).ok, true);
    assert.equal(protocol.makeEnvelope([sample(), ...agents], { ...expected, now: NOW }).agents.length, 128);
    agents.push(sample('child_128'));
    assert.deepEqual(protocol.parseEnvelope(envelope(sample(), agents), expected), { ok: false, reason: 'invalid' });
    assert.equal(protocol.makeEnvelope(agents, { ...expected, now: NOW }), null);
});

test('enforces UTF-8 envelope and individual snapshot byte budgets before parsing snapshots', () => {
    let calls = 0;
    const bounded = createMetadataProtocol(() => ({ ...createSnapshotProtocol(), parseSnapshot(...args) {
        calls++; return createSnapshotProtocol().parseSnapshot(...args);
    } }));
    const individual = envelope({ ...sample(), privatePrompt: '😀'.repeat(5000) });
    assert.deepEqual(bounded.parseEnvelope(individual, expected), { ok: false, reason: 'invalid' });
    assert.equal(calls, 0);
    const huge = envelope({ ...sample(), privatePrompt: '😀'.repeat(70000) });
    assert.deepEqual(bounded.parseEnvelope(huge, expected), { ok: false, reason: 'invalid' });
    assert.equal(calls, 0);
    const padded = JSON.stringify(envelope()) + ' '.repeat(262144);
    assert.deepEqual(bounded.parseEnvelope(padded, expected), { ok: false, reason: 'invalid' });
    assert.equal(calls, 0);
});
