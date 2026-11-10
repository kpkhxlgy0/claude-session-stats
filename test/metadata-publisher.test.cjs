'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isDeepStrictEqual } = require('node:util');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createMetadataPublisher } = require('../src/metadata-publisher.cjs');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const PUBLISHER = '77777777-7777-4777-8777-777777777777';
const OTHER = '88888888-8888-4888-8888-888888888888';
const BRIDGE = 'session_metadata_publisher';
const KEY = 'claudepp_session_stats';
const STATS = { status: 'ok', turns: 2, steps: 3, totalTokens: 100, inputTokens: 60, outputTokens: 40,
    cachedInputTokens: 20, cacheHit: 1 / 3, tps: 4, usageComplete: true };
const snapshotProtocol = createSnapshotProtocol();
const binding = (bridgeSessionId = BRIDGE) => ({ bridgeSessionId, organizationId: ORG, accountId: ACCOUNT });
const sample = (generatedAt = 100000, options = {}) => snapshotProtocol.makeSnapshot(
    { bridgeSessionId: BRIDGE, organizationId: ORG, ...options }, STATS,
    { publisherId: PUBLISHER, revision: 1, now: generatedAt, ...options });
const envelope = snapshot => ({ protocolVersion: 1, bridgeSessionId: snapshot.bridgeSessionId,
    organizationId: snapshot.organizationId, publisherId: snapshot.publisherId,
    generatedAt: snapshot.generatedAt, parent: snapshot, agents: [] });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
    let clock = 100000, bindings = [binding()], snapshots = [sample()];
    const calls = [], sourceCalls = [], details = new Map();
    const detail = id => {
        if (!details.has(id)) details.set(id, { session: { id, environment_kind: 'bridge',
            connection_status: 'connected', client_metadata: { sibling: { untouched: true } } } });
        return details.get(id);
    };
    const source = {
        listRemoteBindings: () => bindings,
        async readRemoteSnapshots(id, context) {
            sourceCalls.push({ id, context });
            return typeof snapshots === 'function' ? snapshots(id, context) : snapshots;
        },
    };
    const fetch = async (url, init) => {
        const call = { url, init }; calls.push(call);
        if (options.request) {
            const response = await options.request(call, { detail, calls });
            if (response !== undefined) return response;
        }
        const id = url.split('/').at(-1), value = detail(id);
        if (init.method === 'PUT') {
            const body = JSON.parse(init.body);
            assert.deepEqual(Object.keys(body), ['client_metadata_patch']);
            assert.equal(body.client_metadata_patch.length, 2);
            const [compare, add] = body.client_metadata_patch;
            assert.equal(compare.op, 'test');
            assert.ok(['', '/claudepp_session_stats'].includes(compare.path));
            assert.equal(add.op, 'add');
            assert.equal(add.path, '/claudepp_session_stats');
            const current = (value.session ?? value.response_shape).client_metadata ?? {};
            const expected = compare.path === '' ? current : current[KEY];
            if (!isDeepStrictEqual(expected, compare.value)) return new Response('{}', { status: 400 });
            current[KEY] = add.value;
            (value.session ?? value.response_shape).client_metadata = current;
        }
        return new Response(JSON.stringify(value), { status: 200 });
    };
    const publisher = createMetadataPublisher({ source, fetch, now: () => clock, pollMs: 100000,
        ...options.publisherOptions });
    t.after(() => publisher.stop());
    return { publisher, source, calls, sourceCalls, detail,
        setClock(value) { clock = value; }, setBindings(value) { bindings = value; },
        setSnapshots(value) { snapshots = value; }, writes: () => calls.filter(call => call.init.method === 'PUT') };
}

test('GET verifies the exact native binding before a namespace-only PUT preserves siblings', async t => {
    const f = fixture(t);
    await f.publisher.start();
    assert.deepEqual(f.calls.map(call => call.init.method), ['GET', 'PUT']);
    for (const { url, init } of f.calls) {
        assert.equal(url, `https://claude.ai/v1/code/sessions/${BRIDGE}`);
        assert.equal(init.credentials, 'include');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers['x-organization-uuid'], ORG);
        assert.equal(init.headers['X-Expected-Account'], ACCOUNT);
        assert.ok(init.signal instanceof AbortSignal);
    }
    const metadata = f.detail(BRIDGE).session.client_metadata;
    const patch = JSON.parse(f.writes()[0].init.body).client_metadata_patch;
    assert.deepEqual(patch[0], { op: 'test', path: '', value: { sibling: { untouched: true } } });
    assert.deepEqual(metadata.sibling, { untouched: true });
    assert.equal(metadata[KEY].parent.stats.totalTokens, 100);
    assert.deepEqual(f.sourceCalls.map(call => call.id), [BRIDGE]);
    assert.equal(f.sourceCalls[0].context.organizationId, ORG);
});

for (const [name, change] of [
    ['wrong session', detail => { detail.session.id = 'session_foreign'; }],
    ['shared session', detail => { detail.session.is_shared = true; }],
    ['shared response', detail => { detail.shared = true; }],
    ['offline bridge', detail => { detail.session.connection_status = 'disconnected'; }],
    ['wrong environment', detail => { detail.session.environment_kind = 'container'; }],
    ['future metadata schema', detail => { detail.session.client_metadata[KEY] = { protocolVersion: 2 }; }],
    ['null namespace', detail => { detail.session.client_metadata[KEY] = null; }],
]) test(`does not read local snapshots or PUT for ${name}`, async t => {
    const f = fixture(t); change(f.detail(BRIDGE));
    await f.publisher.start();
    assert.equal(f.writes().length, 0);
    assert.equal(f.sourceCalls.length, 0);
});

test('native response_shape and cse aliases are accepted without widening the fixed endpoint', async t => {
    const f = fixture(t);
    const detail = f.detail(BRIDGE);
    detail.response_shape = { ...detail.session, id: BRIDGE.replace('session_', 'cse_'),
        environment_kind: 'ENVIRONMENT_KIND_BRIDGE' };
    delete detail.session;
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
});

test('invalid, conflicting and revoked source bindings cannot publish', async t => {
    const f = fixture(t);
    f.setBindings([binding(), { ...binding(), accountId: OTHER }]);
    await f.publisher.start();
    assert.equal(f.calls.length, 0);
    f.setBindings([{ ...binding(), accountId: 'invalid' }]);
    await f.publisher.start();
    assert.equal(f.calls.length, 0);
    f.setBindings([binding()]);
    f.setSnapshots(async () => { f.setBindings([]); return [sample()]; });
    await f.publisher.start();
    assert.equal(f.writes().length, 0);
});

test('identity changes during GET prevent local source reads and writes', async t => {
    let f;
    f = fixture(t, { request: async ({ init }) => {
        if (init.method === 'GET') f.setBindings([{ ...binding(), accountId: OTHER }]);
    } });
    await f.publisher.start();
    assert.equal(f.sourceCalls.length, 0);
    assert.equal(f.writes().length, 0);
});

test('stop aborts a blocked GET synchronously and its late completion never PUTs or deletes', async t => {
    const gate = defer();
    const f = fixture(t, { request: ({ init }) => init.method === 'GET' ? gate.promise : undefined });
    const pending = f.publisher.start();
    await turn();
    assert.equal(f.calls.length, 1);
    const stopped = f.publisher.stop();
    assert.equal(f.calls[0].init.signal.aborted, true);
    gate.resolve(new Response(JSON.stringify(f.detail(BRIDGE))));
    await Promise.all([pending, stopped]);
    await f.publisher.start();
    assert.deepEqual(f.calls.map(call => call.init.method), ['GET']);
});

test('stop during source I/O prevents PUT even when the source ignores cancellation', async t => {
    const gate = defer();
    const f = fixture(t); f.setSnapshots(() => gate.promise);
    const pending = f.publisher.start(); await turn();
    const stopped = f.publisher.stop();
    assert.equal(f.sourceCalls[0].context.signal.aborted, true);
    gate.resolve([sample()]); await Promise.all([pending, stopped]);
    assert.equal(f.writes().length, 0);
});

test('timeouts abort ignored network work and do not leave refresh waiting forever', async t => {
    const gate = defer();
    const f = fixture(t, { publisherOptions: { timeoutMs: 5 }, request: () => gate.promise });
    await f.publisher.start();
    assert.equal(f.calls[0].init.signal.aborted, true);
    assert.equal(f.writes().length, 0);
    gate.resolve(new Response(JSON.stringify(f.detail(BRIDGE)))); await turn();
    assert.equal(f.writes().length, 0);
});

test('coalesced refreshes never write twice within ten seconds and skip identical envelopes', async t => {
    const f = fixture(t);
    await Promise.all([f.publisher.start(), f.publisher.start(), f.publisher.start()]);
    assert.equal(f.writes().length, 1);
    f.setClock(109999); f.setSnapshots([sample(109999, { revision: 2 })]);
    await f.publisher.start(); assert.equal(f.calls.length, 2);
    f.setClock(110000); await f.publisher.start(); assert.equal(f.writes().length, 2);
    f.setClock(120000); await f.publisher.start(); assert.equal(f.writes().length, 2);
});

test('a slow successful PUT still reserves ten seconds after its completion', async t => {
    let f;
    f = fixture(t, { request: ({ init }) => {
        if (init.method === 'PUT') f.setClock(109000);
    } });
    await f.publisher.start();
    f.setClock(110000); f.setSnapshots([sample(110000, { revision: 2 })]);
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
});

test('failed HTTP requests back off while preserving local data', async t => {
    const f = fixture(t, { request: () => new Response('{}', { status: 409 }) });
    await f.publisher.start(); assert.equal(f.calls.length, 1);
    f.setClock(109999); await f.publisher.start(); assert.equal(f.calls.length, 1);
    f.setClock(110000); await f.publisher.start(); assert.equal(f.calls.length, 2);
    f.setClock(120000); await f.publisher.start(); assert.equal(f.calls.length, 2);
    f.setClock(130000); await f.publisher.start(); assert.equal(f.calls.length, 3);
    assert.equal(f.sourceCalls.length, 0);
});

test('repeated failed PUTs back off as well as GET failures', async t => {
    const f = fixture(t, { request: ({ init }) =>
        init.method === 'PUT' ? new Response('{}', { status: 503 }) : undefined });
    await f.publisher.start(); assert.equal(f.writes().length, 1);
    f.setClock(110000); await f.publisher.start(); assert.equal(f.writes().length, 2);
    f.setClock(120000); await f.publisher.start(); assert.equal(f.writes().length, 2);
    f.setClock(130000); await f.publisher.start(); assert.equal(f.writes().length, 3);
});

test('a fresh foreign publisher is preserved and a stale one permits handover', async t => {
    const f = fixture(t);
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(99999, { publisherId: OTHER }));
    await f.publisher.start(); assert.equal(f.writes().length, 0);
    f.setClock(140000); f.setSnapshots([sample(140000, { revision: 2 })]);
    await f.publisher.start(); assert.equal(f.writes().length, 1);
});

test('an old publisher cannot overwrite a newer publisher after its own prior publication', async t => {
    const f = fixture(t); await f.publisher.start();
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(110000, { publisherId: OTHER }));
    f.setClock(110000); f.setSnapshots([sample(110000, { revision: 2 })]);
    await f.publisher.start();
    f.setClock(150000); f.setSnapshots([sample(150000, { revision: 3 })]);
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].publisherId, OTHER);
});

test('same-publisher revision rollback and altered equal revisions cannot overwrite cloud snapshots', async t => {
    const f = fixture(t);
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(100000, { revision: 2 }));
    await f.publisher.start(); assert.equal(f.writes().length, 0);
    f.setClock(110000); f.setSnapshots([sample(110000, { revision: 2 })]);
    await f.publisher.start(); assert.equal(f.writes().length, 0);
});

test('parent and child snapshots are transported independently without adding counters', async t => {
    const f = fixture(t);
    f.setSnapshots([sample(), sample(100001, { agentId: 'agent-child' })]);
    await f.publisher.start();
    const value = f.detail(BRIDGE).session.client_metadata[KEY];
    assert.equal(value.parent.stats.totalTokens, 100);
    assert.equal(value.agents[0].stats.totalTokens, 100);
    assert.equal(value.agents[0].agentId, 'agent-child');
});

test('oversized session streams are cancelled before parsing or writing', async t => {
    let cancelled = false;
    const f = fixture(t, { request: () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
    })) });
    await f.publisher.start();
    assert.equal(cancelled, true);
    assert.equal(f.writes().length, 0);
    assert.equal(f.sourceCalls.length, 0);
});

test('the timeout covers the response body and cancels a stream which never finishes', async t => {
    let cancelled = false;
    const f = fixture(t, { publisherOptions: { timeoutMs: 5 },
        request: () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await f.publisher.start();
    await turn();
    assert.equal(f.calls[0].init.signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(f.writes().length, 0);
});

test('declared oversized content and malformed UTF-8 never reach local snapshots', async t => {
    let response = new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } });
    const f = fixture(t, { request: () => response });
    await f.publisher.start();
    f.setClock(110000); response = new Response(new Uint8Array([0xff]));
    await f.publisher.start();
    assert.equal(f.writes().length, 0);
    assert.equal(f.sourceCalls.length, 0);
});

test('oversized or foreign namespaces are protected even inside an otherwise valid session', async t => {
    const f = fixture(t);
    const existing = envelope(sample());
    existing.extra = 'x'.repeat(262144);
    f.detail(BRIDGE).session.client_metadata[KEY] = existing;
    await f.publisher.start(); assert.equal(f.writes().length, 0);
    assert.equal(f.sourceCalls.length, 0);
    f.setClock(110000);
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(110000, { organizationId: OTHER }));
    await f.publisher.start(); assert.equal(f.writes().length, 0);
});

test('stale, future and mismatched source snapshots never PUT', async t => {
    const f = fixture(t);
    f.setSnapshots([sample(69999)]); await f.publisher.start();
    assert.equal(f.writes().length, 0);
    f.setClock(110000); f.setSnapshots([sample(115001)]); await f.publisher.start();
    assert.equal(f.writes().length, 0);
    f.setClock(120000); f.setSnapshots([sample(120000, { organizationId: OTHER })]);
    await f.publisher.start(); assert.equal(f.writes().length, 0);
});

test('account changes receive independent binding state without inheriting backoff', async t => {
    let reject = true;
    const f = fixture(t, { request: () => reject ? new Response('{}', { status: 409 }) : undefined });
    await f.publisher.start();
    f.setClock(110000); await f.publisher.start();
    assert.equal(f.calls.length, 2);
    f.setClock(110001); f.setBindings([{ ...binding(), accountId: OTHER }]); reject = false;
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
    assert.equal(f.writes()[0].init.headers['X-Expected-Account'], OTHER);
});

test('stop leaves the last cloud summary to expire without a delete request', async t => {
    const f = fixture(t);
    await f.publisher.start();
    await f.publisher.stop();
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].parent.stats.totalTokens, 100);
    assert.deepEqual(f.calls.map(call => call.init.method), ['GET', 'PUT']);
});

test('more than 32 bindings are rotated fairly with at most two concurrent sessions', async t => {
    let active = 0, maximum = 0;
    const f = fixture(t, { request: async ({ init }) => {
        if (init.method !== 'GET') return;
        active++; maximum = Math.max(maximum, active); await turn(); active--;
    } });
    f.setBindings(Array.from({ length: 70 }, (_, index) => binding(`session_fair_${index}`)));
    f.setSnapshots(id => [sample(100000, { bridgeSessionId: id })]);
    await f.publisher.start();
    f.setClock(110000); await f.publisher.start();
    f.setClock(120000); await f.publisher.start();
    assert.equal(maximum, 2);
    assert.equal(new Set(f.writes().map(call => call.url)).size, 70);
});

test('publisher retirement survives repeated rotations through 70 bindings', async t => {
    let clock = 100000;
    const f = fixture(t, { publisherOptions: { now: () => clock } });
    const target = 'session_rotated_0';
    f.setBindings(Array.from({ length: 70 }, (_, index) => binding(`session_rotated_${index}`)));
    f.setSnapshots(id => [sample(clock, { bridgeSessionId: id, revision: clock })]);
    await f.publisher.start();
    f.detail(target).session.client_metadata[KEY] = envelope(sample(110000,
        { bridgeSessionId: target, publisherId: OTHER }));
    for (const time of [110000, 120000, 130000, 150001]) {
        clock = time;
        await f.publisher.start();
    }
    assert.equal(f.writes().filter(call => call.url.endsWith(`/${target}`)).length, 1);
    assert.equal(f.detail(target).session.client_metadata[KEY].publisherId, OTHER);
});

test('failure backoff survives eviction from the active scheduling window', async t => {
    let clock = 100000;
    const target = 'session_backoff_0';
    const f = fixture(t, { publisherOptions: { now: () => clock }, request: ({ url }) =>
        url.endsWith(`/${target}`) ? new Response('{}', { status: 503 }) : undefined });
    f.setBindings(Array.from({ length: 70 }, (_, index) => binding(`session_backoff_${index}`)));
    f.setSnapshots(id => [sample(clock, { bridgeSessionId: id, revision: clock })]);
    for (const time of [100000, 110000, 120000, 130000, 140000, 150000, 160000]) {
        clock = time;
        await f.publisher.start();
    }
    assert.equal(f.calls.filter(call => call.url.endsWith(`/${target}`)).length, 3);
});

test('temporary binding removal never forgets that a newer publisher took ownership', async t => {
    const f = fixture(t);
    await f.publisher.start();
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(110000, { publisherId: OTHER }));
    f.setClock(110000); f.setSnapshots([sample(110000, { revision: 2 })]);
    await f.publisher.start();
    f.setBindings([]); f.setClock(120000); await f.publisher.start();
    f.setBindings([binding()]); f.setClock(150001); f.setSnapshots([sample(150001, { revision: 3 })]);
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].publisherId, OTHER);
});

test('observing an identical owned envelope still remembers ownership before a successor appears', async t => {
    const f = fixture(t);
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample());
    await f.publisher.start(); assert.equal(f.writes().length, 0);
    f.detail(BRIDGE).session.client_metadata[KEY] = envelope(sample(110000, { publisherId: OTHER }));
    f.setClock(110000); f.setSnapshots([sample(110000, { revision: 2 })]);
    await f.publisher.start();
    f.setClock(150001); f.setSnapshots([sample(150001, { revision: 3 })]);
    await f.publisher.start();
    assert.equal(f.writes().length, 0);
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].publisherId, OTHER);
});

test('the bounded history rejects new bindings at capacity while preserving earlier backoff', async t => {
    const f = fixture(t, { request: () => new Response('{}', { status: 503 }) });
    for (let index = 0; index < 4096; index++) {
        f.setBindings([binding(`session_history_${index}`)]);
        await f.publisher.start();
    }
    assert.equal(f.calls.length, 4096);
    f.setBindings([binding('session_history_overflow')]);
    await f.publisher.start();
    assert.equal(f.calls.length, 4096);
    f.setBindings([binding('session_history_0')]);
    await f.publisher.start();
    assert.equal(f.calls.length, 4096);
    f.setClock(110000); await f.publisher.start();
    assert.equal(f.calls.length, 4097);
});

test('a namespace replaced during source I/O is atomically preserved by the failed comparison', async t => {
    const f = fixture(t);
    const original = envelope(sample(99999));
    const successor = envelope(sample(100000, { publisherId: OTHER }));
    f.detail(BRIDGE).session.client_metadata[KEY] = original;
    f.setSnapshots(() => {
        f.detail(BRIDGE).session.client_metadata[KEY] = successor;
        return [sample(100000, { revision: 2 })];
    });
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
    const patch = JSON.parse(f.writes()[0].init.body).client_metadata_patch;
    assert.deepEqual(patch[0], { op: 'test', path: '/claudepp_session_stats', value: original });
    assert.deepEqual(f.detail(BRIDGE).session.client_metadata[KEY], successor);
    f.setClock(105000); await f.publisher.start(); assert.equal(f.writes().length, 1);
});

test('a namespace created after an empty GET is protected by whole-metadata comparison', async t => {
    const f = fixture(t);
    const successor = envelope(sample(100000, { publisherId: OTHER }));
    f.setSnapshots(() => {
        f.detail(BRIDGE).session.client_metadata[KEY] = successor;
        return [sample()];
    });
    await f.publisher.start();
    assert.equal(f.writes().length, 1);
    assert.deepEqual(f.detail(BRIDGE).session.client_metadata[KEY], successor);
    const patch = JSON.parse(f.writes()[0].init.body).client_metadata_patch;
    assert.equal(patch[0].op, 'test');
    assert.equal(patch[0].path, '');
});

test('an unrelated metadata change blocks an absent-namespace write until a new GET', async t => {
    const f = fixture(t);
    let changed = false;
    f.setSnapshots(() => {
        if (!changed) { changed = true; f.detail(BRIDGE).session.client_metadata.sibling = { updated: true }; }
        return [sample()];
    });
    await f.publisher.start();
    assert.equal(Object.hasOwn(f.detail(BRIDGE).session.client_metadata, KEY), false);
    f.setClock(110000); await f.publisher.start();
    assert.equal(f.writes().length, 2);
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].publisherId, PUBLISHER);
    assert.deepEqual(f.detail(BRIDGE).session.client_metadata.sibling, { updated: true });
});

test('comparison uses the exact string namespace from GET rather than its parsed envelope', async t => {
    const f = fixture(t);
    const original = JSON.stringify(envelope(sample(99999)), null, 2);
    f.detail(BRIDGE).session.client_metadata[KEY] = original;
    f.setSnapshots([sample(100000, { revision: 2 })]);
    await f.publisher.start();
    const patch = JSON.parse(f.writes()[0].init.body).client_metadata_patch;
    assert.deepEqual(patch[0], { op: 'test', path: '/claudepp_session_stats', value: original });
    assert.equal(f.detail(BRIDGE).session.client_metadata[KEY].parent.revision, 2);
});

test('failed comparisons are never retried with an unconditional add', async t => {
    const f = fixture(t, { request: ({ init }) =>
        init.method === 'PUT' ? new Response('{}', { status: 400 }) : undefined });
    await f.publisher.start();
    f.setClock(110000); await f.publisher.start();
    assert.equal(f.writes().length, 2);
    assert.ok(f.writes().every(call => JSON.parse(call.init.body).client_metadata_patch[0].op === 'test'));
});

test('a comparison whose JSON expands beyond the write budget is never sent', async t => {
    const compact = `{"session":{"id":"${BRIDGE}","environment_kind":"bridge",`
        + '"connection_status":"connected","client_metadata":{"sibling":['
        + '1e9,'.repeat(199999) + '1e9]}}}';
    assert.ok(Buffer.byteLength(compact) < 1024 * 1024);
    const f = fixture(t, { request: ({ init }) =>
        init.method === 'GET' ? new Response(compact) : undefined });
    await f.publisher.start();
    assert.equal(f.sourceCalls.length, 1);
    assert.equal(f.writes().length, 0);
});
