'use strict';
const { createDemandProtocol } = require('./demand-protocol.cjs');
const { createMetadataProtocol } = require('./metadata-protocol.cjs');
const { createSnapshotProtocol } = require('./snapshot.cjs');

function createRemoteDemand({ source, fetch, now = Date.now, pollMs = 2000 } = {}) {
    const demand = createDemandProtocol(), metadata = createMetadataProtocol(createSnapshotProtocol), protocol = createSnapshotProtocol();
    const owners = new Set(), ownerBridges = new Map();
    let stopped = false, timer, pending, controller;
    async function request(binding, body) {
        const url = `https://claude.ai/v1/code/sessions/${binding.bridgeSessionId}`;
        const signal = controller.signal;
        let abort;
        const cancelled = new Promise((_resolve, reject) => {
            abort = () => reject(new Error('Demand transport deadline'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
        const bounded = operation => Promise.race([Promise.resolve().then(operation), cancelled]);
        try {
            const response = await bounded(() => fetch(url, { method: body ? 'PUT' : 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
                signal, headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29',
                    'anthropic-client-feature': 'ccr', 'x-organization-uuid': binding.organizationId,
                    'X-Expected-Account': binding.accountId, ...(body ? { 'content-type': 'application/json' } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}) }));
            if (!response.ok || response.url && response.url !== url || stopped || signal.aborted) throw new Error('Demand transport unavailable');
            let text;
            if (response.body?.getReader) {
                const reader = response.body.getReader(), chunks = [];
                let bytes = 0;
                try {
                    for (;;) {
                        const { value, done } = await bounded(() => reader.read());
                        if (done) break;
                        if (!(value instanceof Uint8Array) || (bytes += value.byteLength) > 1024 * 1024)
                            throw new Error('Demand metadata limit');
                        chunks.push(value);
                    }
                    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
                } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
            } else text = await bounded(() => response.text());
            if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw new Error('Demand metadata limit');
            return text ? JSON.parse(text) : null;
        } finally { signal.removeEventListener('abort', abort); }
    }

    function refresh() {
        if (stopped) return Promise.resolve();
        if (pending) return pending;
        pending = (async () => {
            const next = new Set(), bindings = await source.listActiveRemoteBindings();
            const failed = new Set(bindings.map(binding => binding.bridgeSessionId));
            if (stopped) return;
            controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                for (const binding of bindings) {
                    if (stopped || controller.signal.aborted) break;
                    try {
                        const detail = await request(binding);
                        failed.delete(binding.bridgeSessionId);
                        const session = detail?.session ?? detail?.response_shape;
                        if (!session || detail.shared || detail.is_shared || session.shared || session.is_shared
                            || protocol.normalizeBridgeId(session.id) !== binding.bridgeSessionId
                            || !['bridge', 'ENVIRONMENT_KIND_BRIDGE'].includes(session.environment_kind)
                            || (session.connection_status ?? detail.connection_status) !== 'connected') continue;
                        const container = session.client_metadata ?? detail.client_metadata ?? {};
                        if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
                        const raw = await source.readRemoteLocation(binding.bridgeSessionId,
                            { organizationId: binding.organizationId, signal: controller.signal });
                        if (!raw || stopped) continue;
                        const location = metadata.makeLocation(raw), existing = container[metadata.key];
                        if (!location) continue;
                        const prior = metadata.parseLocation(existing, { ...binding, now: existing?.generatedAt });
                        if (existing !== undefined && !prior.ok) continue;
                        if (prior.ok && prior.location.publisherId !== location.publisherId
                            && now() - prior.location.generatedAt <= protocol.maxAgeMs) continue;
                        const entries = Object.entries(container).filter(([key]) => key.startsWith(demand.prefix));
                        if (entries.length <= 64) for (const [key, value] of entries) {
                            const parsed = demand.parse(value, { ...binding, now: now() });
                            if (!parsed || key !== demand.key(parsed.viewerId)) continue;
                            const owner = `remote_${binding.bridgeSessionId}_${parsed.viewerId}`;
                            if (owner.length > 160) continue;
                            source.setInterest(owner, [{ localSessionId: binding.localSessionId,
                                ...(parsed.agentId !== undefined ? { agentId: parsed.agentId } : {}) }], { expiresAt: parsed.expiresAt });
                            next.add(owner); ownerBridges.set(owner, binding.bridgeSessionId);
                        }
                        const parsed = metadata.parseLocation(existing, { ...binding, now: now() });
                        if (parsed.ok && parsed.location.publisherId === location.publisherId
                            && metadata.samePath(parsed.location.directory, location.directory)
                            && now() - parsed.location.generatedAt < 10000) continue;
                        // Per-viewer requests live in sibling keys. Compare only our
                        // descriptor, or the container when first creating it.
                        await request(binding, { client_metadata_patch: [
                            Object.hasOwn(container, metadata.key) ? { op: 'test', path: '/' + metadata.key, value: existing }
                                : { op: 'test', path: '', value: container },
                            { op: 'add', path: '/' + metadata.key, value: location }] });
                    } catch { failed.add(binding.bridgeSessionId); /* Existing leases retain their original expiry. */ }
                }
            } finally {
                clearTimeout(timeout);
                for (const owner of owners) if (!next.has(owner)) {
                    if (failed.has(ownerBridges.get(owner))) next.add(owner);
                    else { source.releaseInterest(owner); ownerBridges.delete(owner); }
                }
                owners.clear(); for (const owner of next) owners.add(owner);
            }
        })().finally(() => { pending = null; });
        return pending;
    }
    return { refresh, start() { if (!timer && !stopped) { timer = setInterval(() => { void refresh(); }, pollMs); timer.unref?.(); } return refresh(); },
        stop() { stopped = true; clearInterval(timer); controller?.abort(); for (const owner of owners) source.releaseInterest(owner); owners.clear(); return Promise.resolve(); } };
}
module.exports = { createRemoteDemand };
