'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createMetadataProtocol } = require('../src/metadata-protocol.cjs');

const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = 'abcdef22-2222-4222-8222-222222222222';
const OTHER = 'abcdef33-3333-4333-8333-333333333333';
const NOW = 1792886400000;
const expected = { bridgeSessionId: ID, organizationId: ORG, now: NOW };
const protocol = createMetadataProtocol(createSnapshotProtocol);
const raw = (changes = {}) => ({ bridgeSessionId: ID, organizationId: ORG,
    publisherId: PUBLISHER, generatedAt: NOW, directory: 'D:/Claude 配置/.session-stats', ...changes });
const location = (changes = {}) => ({ protocolVersion: 2, ...raw(changes) });

function legacy(changes = {}) {
    const snapshot = createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG },
        { status: 'ok', turns: 7, steps: 13, totalTokens: 1400, inputTokens: 1000,
            outputTokens: 400, cachedInputTokens: 700, cacheHit: .7, tps: 20, usageComplete: true },
        { publisherId: PUBLISHER, revision: 1, now: NOW - 30001 });
    return { protocolVersion: 1, bridgeSessionId: ID, organizationId: ORG, publisherId: PUBLISHER,
        generatedAt: snapshot.generatedAt, parent: snapshot, agents: [], ...changes };
}

test('makes a bounded directory-only descriptor with normalized source identities and Windows separators', () => {
    assert.equal(protocol.key, 'claudepp_session_stats');
    assert.deepEqual(protocol.makeLocation(raw({ bridgeSessionId: 'cse_Test123',
        organizationId: ORG.toUpperCase(), publisherId: PUBLISHER.toUpperCase(),
        directory: 'D:\\Claude 配置\\.session-stats' })), location());
    assert.deepEqual(protocol.parseLocation(JSON.stringify(location()), expected), { ok: true, location: location() });
    assert.deepEqual(protocol.makeLocation(raw({ directory: '/home/用户/.session-stats' })),
        location({ directory: '/home/用户/.session-stats' }));
});

test('location parsing preserves identity and rejects noncanonical or extra descriptor fields', () => {
    for (const value of [location({ bridgeSessionId: 'session_Other' }), location({ organizationId: OTHER })]) {
        assert.deepEqual(protocol.parseLocation(value, expected), { ok: false, reason: 'identity' });
    }
    assert.equal(protocol.parseLocation(location(), { ...expected, bridgeSessionId: 'cse_Test123' }).ok, true);
    for (const value of [{}, [], 'not-json', location({ protocolVersion: 1 }), location({ protocolVersion: 3 }),
        location({ parent: null }), location({ agents: [] }), location({ generatedAt: -1 }),
        location({ publisherId: 'invalid' }), location({ organizationId: 'invalid' }),
        location({ bridgeSessionId: 'cse_Test123' }), location({ directory: 'D:\\Claude 配置\\.session-stats' }),
        location({ publisherId: OTHER.toUpperCase() })]) {
        assert.deepEqual(protocol.parseLocation(value, expected), { ok: false, reason: 'invalid' });
    }
    for (const value of [null, undefined])
        assert.deepEqual(protocol.parseLocation(value, expected), { ok: false, reason: 'missing' });
    assert.deepEqual(protocol.parseLocation(location(), { ...expected, now: NaN }), { ok: false, reason: 'invalid' });
});

test('locations use the inclusive 30-second age and 5-second future boundaries', () => {
    for (const generatedAt of [NOW - 30000, NOW + 5000])
        assert.equal(protocol.parseLocation(location({ generatedAt }), expected).ok, true);
    assert.deepEqual(protocol.parseLocation(location({ generatedAt: NOW - 30001 }), expected),
        { ok: false, reason: 'expired' });
    assert.deepEqual(protocol.parseLocation(location({ generatedAt: NOW + 5001 }), expected),
        { ok: false, reason: 'future' });
});

test('unsafe locations never become snapshot read targets', () => {
    for (const directory of ['relative/.session-stats', 'C:relative/.session-stats', '/x/../.session-stats',
        '/x/./.session-stats', '/x//.session-stats', '//server/share/.session-stats', '\\\\server\\share\\.session-stats',
        '\\\\?\\C:\\.session-stats', '\\\\.\\C:\\.session-stats', '\\root\\.session-stats',
        'file:///home/.session-stats', 'https://host/.session-stats', '/home/.session-stats:stream',
        'C:/home:stream/.session-stats', 'C:/home /work/.session-stats', 'C:/home./.session-stats',
        'C:/nul/.session-stats', 'C:/COM1.txt/.session-stats', 'C:/bad?name/.session-stats',
        'C:/x\u0000/.session-stats', '/x\n/.session-stats', '/x\u007f/.session-stats', '/x\u0085/.session-stats',
        '/home/stats', '/home/.session-stats/child', '/home/.session-stats/', '/x\ud800/.session-stats']) {
        assert.equal(protocol.makeLocation(raw({ directory })), null, directory);
        assert.equal(protocol.parseLocation(location({ directory }), expected).ok, false, directory);
        assert.equal(protocol.snapshotPath(location({ directory })), null, directory);
    }
});

test('location source requires only its exact fields and valid identities', () => {
    for (const value of [null, [], raw({ protocolVersion: 2 }), raw({ stats: {} }), raw({ agents: [] }),
        raw({ bridgeSessionId: '../bad' }), raw({ publisherId: 'bad' }), raw({ organizationId: 'bad' }),
        raw({ generatedAt: 1.5 }), raw({ generatedAt: NaN }), raw({ generatedAt: undefined })]) {
        assert.equal(protocol.makeLocation(value), null);
    }
});

test('directory character and descriptor UTF-8 budgets fail closed', () => {
    const directory = '/' + 'a'.repeat(4080) + '/.session-stats';
    assert.equal(directory.length, 4096);
    assert.equal(protocol.makeLocation(raw({ directory })).directory, directory);
    assert.equal(protocol.makeLocation(raw({ directory: '/' + 'a'.repeat(4081) + '/.session-stats' })), null);
    const multibyte = '/' + '界'.repeat(2800) + '/.session-stats';
    assert.ok(multibyte.length < 4096);
    assert.equal(protocol.makeLocation(raw({ directory: multibyte })), null);
    assert.equal(protocol.parseLocation(JSON.stringify(location()) + ' '.repeat(8192), expected).ok, false);
});

test('derives only the exact main or selected agent filename from validated locations', () => {
    assert.equal(protocol.snapshotPath(location()), 'D:/Claude 配置/.session-stats/session_Test123.json');
    assert.equal(protocol.snapshotPath(location(), 'child_A-1'),
        'D:/Claude 配置/.session-stats/session_Test123.agent-child_A-1.json');
    assert.equal(protocol.snapshotPath(location({ directory: '/home/用户/.session-stats' }), 'child'),
        '/home/用户/.session-stats/session_Test123.agent-child.json');
    for (const agentId of ['', '../bad', 'x/y', 'x\\y', 'a'.repeat(65), null])
        assert.equal(protocol.snapshotPath(location(), agentId), null);
    for (const value of [null, location({ bridgeSessionId: 'session_../bad' }), location({ publisherId: 'bad' }),
        location({ organizationId: 'bad' }), location({ generatedAt: -1 })])
        assert.equal(protocol.snapshotPath(value), null);
});

test('matches native Windows path casing and separators but keeps POSIX comparisons exact', () => {
    assert.equal(protocol.samePath('d:\\CLAUDE 配置\\.SESSION-STATS\\session_Test123.json',
        'D:/Claude 配置/.session-stats/session_Test123.json'), true);
    assert.equal(protocol.samePath('/home/用户/.session-stats/session_Test123.json',
        '/home/用户/.session-stats/session_Test123.json'), true);
    for (const [actual, wanted] of [['/Home/x.json', '/home/x.json'], ['/home/x.json', '/home/y.json'],
        ['D:/x/../y.json', 'D:/y.json'], ['//server/x.json', '//server/x.json'], [null, '/home/x.json'],
        ['C:/x.json:stream', 'C:/x.json'], ['file:///x.json', 'file:///x.json']])
        assert.equal(protocol.samePath(actual, wanted), false);
});

test('validates expired legacy numeric envelopes only for safe publisher handover', () => {
    assert.equal(protocol.parseEnvelope(legacy(), expected).ok, true);
    for (const value of [legacy({ publisherId: OTHER }), legacy({ organizationId: OTHER })])
        assert.equal(protocol.parseEnvelope(value, expected).ok, false);
    for (const value of [legacy({ protocolVersion: 3 }), legacy({ generatedAt: NOW }),
        legacy({ privatePrompt: 'must reject' }), legacy({ parent: null }),
        legacy({ agents: [legacy().parent] })])
        assert.equal(protocol.parseEnvelope(value, expected).ok, false);
    assert.equal(protocol.parseEnvelope(JSON.stringify(legacy()) + ' '.repeat(262144), expected).ok, false);
});


test('location identities cannot hide a trailing control character or alias suffix', () => {
    for (const changes of [{ bridgeSessionId: ID + '\n' }, { bridgeSessionId: 'cse_Test123\n' },
        { organizationId: ORG + '\n' }, { publisherId: PUBLISHER + '\n' }]) {
        assert.equal(protocol.makeLocation(raw(changes)), null);
        assert.equal(protocol.parseLocation(location(changes), expected).ok, false);
    }
    assert.equal(protocol.parseLocation(location(), { ...expected, bridgeSessionId: ID + '\n' }).ok, false);
});

test('POSIX path matching never folds backslashes into filename separators', () => {
    assert.equal(protocol.samePath('/home\\user/x.json', '/home/user/x.json'), false);
    assert.equal(protocol.makeLocation(raw({ directory: '/home\\user/.session-stats' })), null);
});
