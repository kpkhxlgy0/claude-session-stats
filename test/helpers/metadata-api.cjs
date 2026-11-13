'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const KEY = 'claudepp_session_stats';

function createMetadataApi({ bridgeSessionId, organizationId, accountId, snapshotDirectory, responseShape = 'session' }) {
    const calls = [], events = [], reads = [];
    let demandListener;
    const sibling = { untouched: true, nested: { revision: 7 } };
    const session = { id: bridgeSessionId.replace('session_', 'cse_'), environment_kind: 'bridge',
        connection_status: 'connected', client_metadata: { sibling: structuredClone(sibling) } };

    function fetchFor(role) {
        return async (raw, init) => {
            const url = new URL(raw);
            const base = `https://claude.ai/v1/code/sessions/${bridgeSessionId}`;
            assert.ok(url.href === base || url.origin + url.pathname === base + '/events');
            assert.equal(init.credentials, 'include');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers['x-organization-uuid'], organizationId);
            assert.ok(init.signal instanceof AbortSignal);
            if (role === 'writer') assert.equal(init.headers['X-Expected-Account'], accountId);
            // Receiving viewers now own only their independent demand keys.
            calls.push({ role, method: init.method });
            if (url.pathname.endsWith('/events')) {
                assert.equal(role, 'renderer');
                if (init.method === 'POST') {
                    const body = JSON.parse(init.body);
                    assert.equal(body.events.length, 1);
                    const payload = body.events[0].payload, request = payload.request;
                    assert.equal(payload.type, 'control_request');
                    assert.equal(request.subtype, 'read_file');
                    assert.equal(request.max_bytes, 16384);
                    assert.equal(request.encoding, 'utf-8');
                    assert.equal(request.anchor, undefined);
                    const filename = path.basename(request.path);
                    assert.ok(filename === `${bridgeSessionId}.json` || filename.startsWith(`${bridgeSessionId}.agent-`));
                    assert.equal(path.resolve(request.path), path.resolve(snapshotDirectory, filename));
                    reads.push({ path: request.path, requestId: payload.request_id });
                    let response;
                    try {
                        const contents = await fs.readFile(request.path, 'utf8');
                        assert.ok(Buffer.byteLength(contents) <= request.max_bytes);
                        response = { subtype: 'success', request_id: payload.request_id,
                            response: { contents, absPath: request.path, encoding: 'utf-8', truncated: false } };
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                        response = { subtype: 'error', request_id: payload.request_id, error: 'File not found' };
                    }
                    events.push({ sequence_num: events.length + 1, payload: { type: 'control_response', response } });
                    return new Response('{}');
                }
                assert.equal(init.method, 'GET');
                const cursor = Number(url.searchParams.get('cursor') ?? 0);
                const data = url.searchParams.get('sort_order') === 'desc' ? events.slice(-1)
                    : events.filter(event => event.sequence_num > cursor);
                return new Response(JSON.stringify({ data, has_more: false }));
            }
            if (init.method === 'PUT') {
                const body = JSON.parse(init.body);
                assert.deepEqual(Object.keys(body), ['client_metadata_patch']);
                for (const patch of body.client_metadata_patch) {
                    const name = patch.path.startsWith('/') ? patch.path.slice(1) : null;
                    if (role === 'renderer') assert.match(name || '', /^claudepp_session_stats_request_[A-Za-z0-9_-]+$/);
                    else if (patch.op !== 'test') assert.equal(name, KEY);
                    if (patch.op === 'test') {
                        try { assert.deepEqual(patch.value, name ? session.client_metadata[name] : session.client_metadata); }
                        catch { return new Response('{}', { status: 409 }); }
                    } else if (patch.op === 'add') session.client_metadata[name] = structuredClone(patch.value);
                    else if (patch.op === 'remove') delete session.client_metadata[name];
                    else assert.fail('Unexpected metadata patch');
                }
                assert.deepEqual(session.client_metadata.sibling, sibling);
                if (role === 'renderer') await demandListener?.();
            } else assert.equal(init.method, 'GET');
            return new Response(JSON.stringify({ [responseShape]: session }), { status: 200 });
        };
    }

    return { session, writerFetch: fetchFor('writer'), readerFetch: fetchFor('renderer'),
        writes: () => calls.filter(call => call.method === 'PUT' && call.role === 'writer'),
        onDemand(listener) { demandListener = listener; },
        reads: () => [...reads],
        envelope: () => session.client_metadata[KEY] };
}

module.exports = { createMetadataApi };
