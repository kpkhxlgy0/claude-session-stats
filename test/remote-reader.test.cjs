'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSnapshotProtocol } = require('../src/snapshot.cjs');
const { createRemoteReader, buildRemoteScripts } = require('../src/remote-reader.cjs');
const ID = 'session_Test123';
const ORG = '11111111-1111-4111-8111-111111111111';
const PUBLISHER = '22222222-2222-4222-8222-222222222222';
const KEY = 'claudepp_session_stats';
const STATS = { turns: 7, steps: 13, totalTokens: 1400, inputTokens: 1000, outputTokens: 400,
    cachedInputTokens: 700, cacheHit: .7, tps: 20, usageComplete: true, status: 'ok' };
const NOW = Date.parse('2026-10-24T00:00:00Z');
const response = (value, ok = true) => ({ ok, text: async () => JSON.stringify(value) });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(check) {
    for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await flush(); }
    assert.fail('reader did not reach the expected transport boundary');
}

function fixture(t, options = {}) {
    const dom = new JSDOM('<div class="ProseMirror" contenteditable="true"></div>', { url: `https://claude.ai/epitaxy/${ID}` });
    t.after(() => dom.window.close());
    const win = dom.window, editor = win.document.querySelector('.ProseMirror');
    editor.getClientRects = () => [{ width: 100 }];
    editor.__reactFiber$test = { memoizedProps: {}, return: { memoizedProps: { value: { activeOrganization: { uuid: ORG } } } } };
    let clock = NOW, revision = 1, generatedAt = NOW;
    let detail = { session: { id: 'cse_Test123', environment_kind: 'ENVIRONMENT_KIND_BRIDGE', connection_status: 'connected' } };
    let onFetch = null, onEnvelope = value => value;
    const requests = [];
    function snapshot(agentId = options.sampleAgentId) {
        return createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG,
            ...(agentId ? { agentId } : {}) }, STATS, { publisherId: PUBLISHER, revision, now: generatedAt });
    }
    function envelope() {
        return onEnvelope({ protocolVersion: 1, bridgeSessionId: ID, organizationId: ORG, publisherId: PUBLISHER,
            generatedAt, parent: options.sampleAgentId ? null : snapshot(), agents: options.sampleAgentId ? [snapshot()] : [] });
    }
    function sessionDetail() {
        const value = structuredClone(detail);
        if (value.session && !Object.hasOwn(value.session, 'client_metadata'))
            value.session.client_metadata = { sibling: { outputTokens: 99999 }, [KEY]: envelope() };
        return value;
    }
    win.fetch = async (url, init) => {
        requests.push({ url, init });
        if (onFetch) {
            const result = await onFetch({ url: new URL(url), init, snapshot, envelope, detail: sessionDetail });
            if (result !== undefined) return result;
        }
        return response(sessionDetail());
    };
    const reader = createRemoteReader(win, createSnapshotProtocol, { pollMs: 0, errorBackoffMs: 0,
        timeoutMs: 100, now: () => clock, ...options });
    t.after(() => reader.stop());
    return { win, reader, editor, requests, snapshot, envelope, detail: sessionDetail,
        setDetail(value) { detail = value; }, setFetch(value) { onFetch = value; },
        setEnvelope(value) { onEnvelope = value; }, advance(ms) { clock += ms; },
        setSample(value, at = clock) { revision = value; generatedAt = at; } };
}

test('reads numeric metadata with one authenticated GET and no message or event polling', async t => {
    const f = fixture(t); const result = await f.reader.read();
    assert.deepEqual(result, { ...STATS, threadId: ID, source: 'remote_control',
        snapshotGeneratedAt: NOW, snapshotRevision: 1, snapshotPublisherId: PUBLISHER });
    assert.equal(f.requests.length, 1);
    const { url, init } = f.requests[0];
    assert.equal(url, `https://claude.ai/v1/code/sessions/${ID}`);
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    assert.equal(init.credentials, 'include'); assert.equal(init.headers['x-organization-uuid'], ORG);
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.doesNotMatch(JSON.stringify(result), /contents|absPath|organizationId|producer|read_file|request_id/);
});

test('selected child reads only its exact metadata snapshot and returns agent identity', async t => {
    const agentId = 'aa6fe20fa9956750a';
    const f = fixture(t, { sampleAgentId: agentId, resolveAgent: () => ({ sessionId: ID, agentId, remote: true }) });
    f.setEnvelope(value => ({ ...value, agents: [...value.agents, { ...f.snapshot('other'), stats: { ...STATS, tps: 88 } }] }));
    const result = await f.reader.read();
    assert.equal(result?.agentId, agentId); assert.equal(result?.tps, 20); assert.equal(f.requests.length, 1);
});

test('valid zero usage remains zero while an unmeasured TPS remains null', async t => {
    const f = fixture(t);
    f.setEnvelope(value => { value.parent.stats = { status: 'ok', turns: 0, steps: 0, totalTokens: 0,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheHit: 0, tps: null, usageComplete: true }; return value; });
    const result = await f.reader.read(); assert.equal(result.status, 'ok');
    for (const field of ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheHit'])
        assert.equal(result[field], 0, field);
    assert.equal(result.tps, null);
});

test('a visible task-pane editor cannot suppress either parent or child snapshot reads', async t => {
    for (const agentId of [undefined, 'a123abc']) {
        const f = fixture(t, { sampleAgentId: agentId, ...(agentId ? {
            resolveAgent: () => ({ sessionId: ID, agentId, remote: true }),
        } : {}) });
        const pane = f.win.document.createElement('div'); pane.dataset.paneRoot = ''; pane.dataset.perfScreen = 'tasks';
        const editor = f.win.document.createElement('textarea'); editor.getClientRects = () => [{ width: 100, height: 20 }];
        pane.append(editor); f.win.document.body.append(pane);
        const result = await f.reader.read();
        assert.equal(result?.tps, 20); assert.equal(result?.agentId, agentId); assert.equal(f.requests.length, 1);
    }
});

test('missing, local, unsafe and foreign-parent child selections never request snapshots', async t => {
    let selected = null; const f = fixture(t, { resolveAgent: () => selected });
    for (selected of [null, { sessionId: ID, agentId: '../bad', remote: true },
        { sessionId: ID, agentId: 'a123abc', remote: false },
        { sessionId: 'session_other', agentId: 'a123abc', remote: true }]) assert.equal(await f.reader.read(), null);
    assert.equal(f.requests.length, 0);
});

test('child selection change invalidates a pending GET and cannot display another child snapshot', async t => {
    const agentId = 'a123abc'; let selected = { sessionId: ID, agentId, remote: true }, release;
    const f = fixture(t, { sampleAgentId: agentId, resolveAgent: () => selected });
    f.setFetch(({ detail }) => new Promise(resolve => { release = () => resolve(response(detail())); }));
    const pending = f.reader.read(); await waitFor(() => release);
    selected = { ...selected, agentId: 'a456def' }; release();
    assert.equal(await pending, null); assert.equal(f.reader.peek(), null);
});

test('cloud, shared, mismatched, unconnected and ambiguous identities cannot read the snapshot', async t => {
    const f = fixture(t);
    for (const detail of [
        { session: { id: ID, environment_kind: 'anthropic_cloud', connection_status: 'connected' } },
        { shared: true, session: { id: ID, environment_kind: 'bridge', connection_status: 'connected' } },
        { session: { shared: true, id: ID, environment_kind: 'bridge', connection_status: 'connected' } },
        { session: { id: 'session_Other', environment_kind: 'bridge', connection_status: 'connected' } },
    ]) { f.setDetail(detail); assert.equal(await f.reader.read(), null); }
    f.setDetail({ session: { id: ID, environment_kind: 'bridge', connection_status: 'disconnected' } });
    assert.equal((await f.reader.read()).unavailableReason, 'offline');
    assert.equal(f.requests.some(request => request.init.method !== 'GET'), false);
    f.editor.__reactFiber$test.memoizedProps.activeOrganization = { uuid: '33333333-3333-4333-8333-333333333333' };
    assert.equal(await f.reader.read(), null); assert.equal(f.reader.peek(), null);
});

test('missing metadata never falls back to synchronized messages, sibling metadata or events', async t => {
    const f = fixture(t);
    f.setDetail({ session: { id: ID, environment_kind: 'bridge', connection_status: 'connected',
        client_metadata: { sibling: { snapshot: f.snapshot() } },
        messages: [{ type: 'assistant', usage: { output_tokens: 99999 } }] } });
    const result = await f.reader.read();
    assert.equal(result.unavailableReason, 'snapshot-missing'); assert.equal(result.totalTokens, null);
    assert.equal(f.requests.length, 1); assert.equal(new URL(f.requests[0].url).pathname, `/v1/code/sessions/${ID}`);
});

test('malformed metadata, protocol versions, duplicate agents and oversized data fail closed', async t => {
    function child() { return createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG,
        agentId: 'child' }, STATS, { publisherId: PUBLISHER, revision: 1, now: NOW }); }
    for (const mutate of [
        () => [], value => ({ ...value, protocolVersion: 2 }), value => ({ ...value, protocolVersion: '1' }),
        value => ({ parent: value.parent }), value => ({ ...value, path: '/private/file' }),
        value => ({ ...value, parent: { ...value.parent, privatePrompt: 'must reject' } }),
        value => ({ ...value, parent: { ...value.parent, privatePrompt: '😀'.repeat(70000) } }),
        value => ({ ...value, agents: [child(), child()] }),
    ]) {
        const f = fixture(t); f.setEnvelope(mutate); const result = await f.reader.read();
        assert.equal(result.status, 'unavailable'); assert.equal(result.unavailableReason, 'snapshot-invalid');
        assert.equal(result.tps, null);
    }
});

test('snapshot UTF-8 byte limit is checked before parsing metrics', async t => {
    let parsed = false;
    const factory = () => ({ ...createSnapshotProtocol(), parseSnapshot() { parsed = true; throw new Error('oversized'); } });
    const f = fixture(t); f.setEnvelope(value => ({ ...value, parent: { ...value.parent, privatePrompt: '😀'.repeat(5000) } }));
    const reader = createRemoteReader(f.win, factory, { now: () => NOW }); t.after(() => reader.stop());
    assert.equal((await reader.read()).unavailableReason, 'snapshot-invalid'); assert.equal(parsed, false);
});

test('missing parent or selected child cannot accept a different snapshot', async t => {
    for (const selected of [undefined, 'child_B']) {
        const f = fixture(t, { sampleAgentId: 'child_A', ...(selected ? {
            resolveAgent: () => ({ sessionId: ID, agentId: selected, remote: true }),
        } : {}) });
        assert.equal((await f.reader.read()).unavailableReason, 'snapshot-missing');
    }
    const f = fixture(t, { resolveAgent: () => ({ sessionId: ID, agentId: 'child_A', remote: true }) });
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-missing');
});

test('wrong envelope or nested identity, stale and future samples remain unavailable', async t => {
    for (const [mutate, reason] of [
        [value => ({ ...value, bridgeSessionId: 'session_Other' }), 'snapshot-identity'],
        [value => ({ ...value, organizationId: '33333333-3333-4333-8333-333333333333' }), 'snapshot-identity'],
        [value => ({ ...value, parent: { ...value.parent, bridgeSessionId: 'session_Other' } }), 'snapshot-identity'],
        [value => ({ ...value, generatedAt: NOW - 30001, parent: { ...value.parent, generatedAt: NOW - 30001 } }), 'snapshot-expired'],
        [value => ({ ...value, generatedAt: NOW + 5001, parent: { ...value.parent, generatedAt: NOW + 5001 } }), 'snapshot-future'],
    ]) {
        const f = fixture(t); f.setEnvelope(mutate); assert.equal((await f.reader.read()).unavailableReason, reason);
    }
});

test('a fresh child cannot refresh an expired parent selected from the same envelope', async t => {
    const f = fixture(t);
    f.setEnvelope(value => ({ ...value, parent: { ...value.parent, generatedAt: NOW - 30001 },
        agents: [createSnapshotProtocol().makeSnapshot({ bridgeSessionId: ID, organizationId: ORG, agentId: 'child' },
            STATS, { publisherId: PUBLISHER, revision: 1, now: NOW })] }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-expired');
});

test('valid unavailable source data never claims a usable shared revision', async t => {
    const f = fixture(t);
    f.setEnvelope(value => ({ ...value, parent: createSnapshotProtocol().makeSnapshot(
        { bridgeSessionId: ID, organizationId: ORG }, { ...STATS, status: 'incomplete' },
        { publisherId: PUBLISHER, revision: 1, now: NOW }) }));
    assert.equal((await f.reader.read()).unavailableReason, 'source-unavailable'); assert.equal(f.reader.peek().tps, null);
});

test('cache expires while a GET is pending and concurrent reads share its one request', async t => {
    const f = fixture(t); assert.equal((await f.reader.read()).tps, 20); f.advance(29000); let release;
    f.setFetch(({ detail }) => new Promise(resolve => { release = () => resolve(response(detail())); }));
    const first = f.reader.read(), second = f.reader.read(); assert.equal(first, second); await waitFor(() => release);
    assert.equal(f.reader.peek().tps, 20); f.advance(1001);
    assert.equal(f.reader.peek().tps, null); assert.equal(f.reader.peek().unavailableReason, 'snapshot-expired');
    release(); assert.equal((await first).unavailableReason, 'snapshot-expired'); assert.equal(f.requests.length, 2);
});

test('snapshot revision rollback, changed same revision and old publisher replays are rejected', async t => {
    const f = fixture(t); f.setSample(3); assert.equal((await f.reader.read()).snapshotRevision, 3);
    f.setSample(2); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
    f.setSample(3); f.setEnvelope(value => ({ ...value, parent: { ...value.parent, stats: { ...value.parent.stats, tps: 21 } } }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
    f.setEnvelope(value => ({ ...value, publisherId: '44444444-4444-4444-8444-444444444444',
        parent: { ...value.parent, publisherId: '44444444-4444-4444-8444-444444444444' } }));
    f.advance(1); f.setSample(1); assert.equal((await f.reader.read()).snapshotRevision, 1);
    f.setEnvelope(value => value); f.setSample(4); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-replay');
});

test('identical repeated metadata reads replace totals and preserve the same revision', async t => {
    const f = fixture(t);
    for (let i = 0; i < 3; i++) {
        const result = await f.reader.read(); assert.equal(result.totalTokens, 1400); assert.equal(result.snapshotRevision, 1);
    }
    assert.equal(f.requests.length, 3);
});

test('normal polling and unavailable backoff suppress extra network calls', async t => {
    const f = fixture(t, { pollMs: 5000, errorBackoffMs: 30000 });
    await f.reader.read(); assert.equal(f.requests.length, 1);
    f.advance(4999); assert.equal((await f.reader.read()).tps, 20); assert.equal(f.requests.length, 1);
    f.advance(1); f.setEnvelope(() => undefined);
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-missing'); assert.equal(f.requests.length, 2);
    f.advance(29999); assert.equal((await f.reader.read()).tps, null); assert.equal(f.requests.length, 2);
    f.advance(1); await f.reader.read(); assert.equal(f.requests.length, 3);
});

test('navigation and stop abort pending fetch and discard its result', async t => {
    const f = fixture(t); let signal;
    f.setFetch(({ init }) => { signal = init.signal; return new Promise(() => {}); });
    const pending = f.reader.read(); await waitFor(() => signal);
    f.win.history.pushState({}, '', '/epitaxy/session_Other');
    assert.equal(f.reader.peek(), null); assert.equal(signal.aborted, true); assert.equal(await pending, null);
    const next = f.reader.read(); f.reader.stop(); assert.equal(await next, null); assert.equal(f.reader.peek(), null);
    assert.equal(f.requests.length, 2);
});

test('stop aborts a pending body read without sending another request', async t => {
    const f = fixture(t); let signal, reading = false;
    f.setFetch(({ init }) => { signal = init.signal; return { ok: true, text() { reading = true; return new Promise(() => {}); } }; });
    const pending = f.reader.read(); await waitFor(() => reading); f.reader.stop();
    assert.equal(await pending, null); assert.equal(signal.aborted, true); assert.equal(f.requests.length, 1);
});

test('GET timeout aborts a body read and makes previously trusted statistics unavailable', async t => {
    const f = fixture(t, { timeoutMs: 15 }); assert.equal((await f.reader.read()).tps, 20); let signal;
    f.setFetch(({ init }) => { signal = init.signal; return { ok: true, text: () => new Promise(() => {}) }; });
    assert.equal((await f.reader.read()).unavailableReason, 'timeout'); assert.equal(signal.aborted, true);
    assert.equal(f.reader.peek().tps, null);
});

test('authorization and malformed response failures never expose prior values', async t => {
    const f = fixture(t); await f.reader.read(); f.setFetch(() => response({}, false));
    assert.equal((await f.reader.read()).unavailableReason, 'transport'); assert.equal(f.reader.peek().tps, null);
    f.setFetch(() => ({ ok: true, text: async () => '{bad-json' }));
    assert.equal((await f.reader.read()).unavailableReason, 'snapshot-invalid');
});

test('switching organizations discards cached numbers and a missing provider never fetches', async t => {
    const f = fixture(t); assert.equal((await f.reader.read()).tps, 20);
    f.editor.__reactFiber$test.return.memoizedProps.value.activeOrganization.uuid = '33333333-3333-4333-8333-333333333333';
    assert.equal(f.reader.peek(), null); assert.equal((await f.reader.read()).unavailableReason, 'snapshot-identity');
    f.editor.__reactFiber$test.return = null; const calls = f.requests.length;
    assert.equal(await f.reader.read(), null); assert.equal(f.requests.length, calls);
});

test('the current account provider can be above a deeply nested composer', async t => {
    const f = fixture(t); let provider = f.editor.__reactFiber$test.return;
    for (let depth = 0; depth < 160; depth++) provider = { memoizedProps: {}, return: provider };
    f.editor.__reactFiber$test.return = provider; assert.equal((await f.reader.read()).totalTokens, 1400);
});

test('serialized bridge bounds IPC at 750ms, finishes the GET in page and cleans up', async t => {
    const vm = require('node:vm'); const f = fixture(t); let release; const timers = new Map();
    f.setFetch(() => new Promise(resolve => { release = resolve; }));
    const { script, cleanupScript } = buildRemoteScripts('slow-owner');
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController,
        setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } });
    const reply = vm.runInContext(script, context); await waitFor(() => release);
    [...timers.values()].find(timer => timer.ms === 750).fn(); assert.equal(await reply, null);
    assert.equal([...timers.values()].some(timer => timer.ms === 750), false);
    f.setSample(1, Date.now()); release(response(f.detail()));
    const reader = f.win[Symbol.for('claudepp.session-stats.slow-owner')];
    assert.equal((await reader.read()).tps, 20); assert.equal(timers.size, 0); assert.equal(f.requests.length, 1);
    vm.runInContext(cleanupScript, context); assert.equal(f.win[Symbol.for('claudepp.session-stats.slow-owner')], undefined);
});

test('serialized child reader derives identity from the selected pane and rejects arbitrary script input', async t => {
    const vm = require('node:vm'), agentId = 'a123abc'; const f = fixture(t, { sampleAgentId: agentId });
    const pane = f.win.document.createElement('div');
    pane.dataset.paneRoot = ''; pane.dataset.perfScreen = 'tasks'; pane.dataset.sessionStatsKey = 'pane-1';
    pane.getClientRects = () => [{ width: 200, height: 400 }]; f.win.document.body.append(pane);
    const top = { tag: 3, stateNode: {} }; top.stateNode.current = top;
    const ref = { id: ID, type: 'bridge' }; const host = { stateNode: pane, memoizedProps: {}, return: top };
    host.child = { memoizedProps: { view: { kind: 'subagent', toolUseId: 'tool_1' }, sessionRef: ref }, return: host };
    host.child.child = { memoizedProps: { openedToolUseId: 'tool_1', sessionRef: ref,
        paneView: { agentId }, task: { taskId: agentId, toolUseId: 'tool_1' } }, return: host.child };
    pane.__reactFiber$test = host; f.setSample(1, Date.now()); const scripts = buildRemoteScripts('child-owner');
    for (const key of [null, '', 'pane-1);window.secret', 'x'.repeat(129)]) assert.equal(scripts.agentScript(key), null);
    const context = vm.createContext({ window: f.win, URL, URLSearchParams, AbortController, setTimeout, clearTimeout });
    const result = await vm.runInContext(scripts.agentScript('pane-1'), context);
    assert.equal(result?.agentId, agentId); assert.equal(result?.tps, 20); assert.equal(f.requests.length, 1);
    pane.remove(); assert.equal(await vm.runInContext(scripts.agentScript('pane-1'), context), null);
    vm.runInContext(scripts.cleanupScript, context); assert.equal(f.win[Symbol.for('claudepp.session-stats.child-owner')], undefined);
});
