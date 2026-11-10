'use strict';

const assert = require('node:assert/strict');

const KEY = 'claudepp_session_stats';

function createMetadataApi({ bridgeSessionId, organizationId, accountId, responseShape = 'session' }) {
    const calls = [];
    const sibling = { untouched: true, nested: { revision: 7 } };
    const session = { id: bridgeSessionId.replace('session_', 'cse_'), environment_kind: 'bridge',
        connection_status: 'connected', client_metadata: { sibling: structuredClone(sibling) } };

    function fetchFor(role) {
        return async (raw, init) => {
            const url = new URL(raw);
            assert.equal(url.href, `https://claude.ai/v1/code/sessions/${bridgeSessionId}`);
            assert.equal(init.credentials, 'include');
            assert.equal(init.cache, 'no-store');
            assert.equal(init.redirect, 'error');
            assert.equal(init.headers['x-organization-uuid'], organizationId);
            assert.ok(init.signal instanceof AbortSignal);
            if (role === 'writer') assert.equal(init.headers['X-Expected-Account'], accountId);
            else assert.equal(init.method, 'GET', 'renderer only reads session metadata');
            calls.push({ role, method: init.method });
            if (init.method === 'PUT') {
                const body = JSON.parse(init.body);
                assert.deepEqual(Object.keys(body), ['client_metadata_patch']);
                assert.equal(body.client_metadata_patch.length, 2);
                const comparison = body.client_metadata_patch[0];
                assert.deepEqual(Object.keys(comparison).sort(), ['op', 'path', 'value']);
                assert.equal(comparison.op, 'test');
                const present = Object.hasOwn(session.client_metadata, KEY);
                assert.equal(comparison.path, present ? '/' + KEY : '');
                try { assert.deepEqual(comparison.value, present ? session.client_metadata[KEY] : session.client_metadata); }
                catch { return new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 }); }
                const patch = body.client_metadata_patch[1];
                assert.deepEqual(Object.keys(patch).sort(), ['op', 'path', 'value']);
                assert.equal(patch.op, 'add');
                assert.equal(patch.path, '/' + KEY);
                session.client_metadata[KEY] = structuredClone(patch.value);
                assert.deepEqual(session.client_metadata.sibling, sibling);
            } else assert.equal(init.method, 'GET');
            return new Response(JSON.stringify({ [responseShape]: session }), { status: 200 });
        };
    }

    return { session, writerFetch: fetchFor('writer'), readerFetch: fetchFor('renderer'),
        writes: () => calls.filter(call => call.method === 'PUT'),
        envelope: () => session.client_metadata[KEY] };
}

module.exports = { createMetadataApi };
