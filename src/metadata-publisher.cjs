'use strict';

const { createSnapshotProtocol } = require('./snapshot.cjs');
const { createMetadataProtocol } = require('./metadata-protocol.cjs');

const MaxSessions = 32;
const MaxHistory = 4096;
const MaxConcurrent = 2;
const PublishIntervalMs = 10000;
const MaxBackoffMs = 120000;
const MaxSessionBytes = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = () => new Error('Metadata publication unavailable');

function createMetadataPublisher({ source, fetch, now = Date.now, pollMs = 1000, timeoutMs = 5000 } = {}) {
    if (typeof source?.listRemoteBindings !== 'function' || typeof source?.readRemoteLocation !== 'function'
        || typeof fetch !== 'function' || typeof now !== 'function') throw new TypeError('A metadata source and fetch are required');
    if (![pollMs, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0))
        throw new RangeError('Invalid metadata publication interval');
    timeoutMs = Math.min(timeoutMs, 5000);
    const protocol = createSnapshotProtocol(), metadata = createMetadataProtocol(createSnapshotProtocol);
    const states = new Map(), history = new Map();
    let stopped = false, started = false, timer, pending = null, cursor = 0, nextWindowAt = -Infinity;

    function normalize(value) {
        const bridgeSessionId = protocol.normalizeBridgeId(value?.bridgeSessionId);
        if (!bridgeSessionId || typeof value.organizationId !== 'string' || !UUID.test(value.organizationId)
            || typeof value.accountId !== 'string' || !UUID.test(value.accountId)) return null;
        return { bridgeSessionId, organizationId: value.organizationId.toLowerCase(),
            accountId: value.accountId.toLowerCase() };
    }
    const key = value => JSON.stringify([value.bridgeSessionId, value.organizationId, value.accountId]);

    function bindings() {
        const values = source.listRemoteBindings();
        if (!Array.isArray(values)) throw failure();
        const unique = new Map(), conflicting = new Set();
        for (const value of values) {
            const bound = normalize(value);
            if (!bound) continue;
            const previous = unique.get(bound.bridgeSessionId);
            if (previous && key(previous) !== key(bound)) conflicting.add(bound.bridgeSessionId);
            else unique.set(bound.bridgeSessionId, bound);
        }
        return [...unique.values()].filter(value => !conflicting.has(value.bridgeSessionId));
    }

    function valid(state) {
        if (stopped || states.get(state.key) !== state || state.controller?.signal.aborted) return false;
        try {
            if (bindings().some(value => key(value) === state.key)) return true;
        } catch { /* 未确认本地身份时不发送网络写入。 */ }
        state.controller?.abort();
        return false;
    }

    function guarded(state, operation) {
        if (!valid(state)) return Promise.reject(failure());
        const signal = state.controller.signal;
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                signal.removeEventListener('abort', abort);
                if (error) reject(error);
                else resolve(value);
            };
            const abort = () => finish(failure());
            const deadline = setTimeout(() => { state.controller.abort(); }, timeoutMs);
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => {
                if (!valid(state)) throw failure();
                return operation();
            }).then(value => finish(valid(state) ? null : failure(), value), error => finish(error));
        });
    }

    async function readBody(state, response) {
        const length = response.headers?.get?.('content-length');
        if (length !== null && length !== undefined && /^\d+$/.test(length) && Number(length) > MaxSessionBytes) {
            void response.body?.cancel?.().catch(() => {});
            throw failure();
        }
        let text;
        if (response.body?.getReader) {
            const reader = response.body.getReader(), bytes = Buffer.alloc(MaxSessionBytes);
            let size = 0;
            try {
                while (true) {
                    const { value, done } = await guarded(state, () => reader.read());
                    if (done) break;
                    if (!(value instanceof Uint8Array) || value.byteLength > MaxSessionBytes - size) throw failure();
                    bytes.set(value, size); size += value.byteLength;
                }
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
            } finally {
                void reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } else text = await guarded(state, () => response.text());
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MaxSessionBytes) throw failure();
        try { return JSON.parse(text); } catch { throw failure(); }
    }

    async function request(state, body) {
        const bound = state.bound;
        const url = `https://claude.ai/v1/code/sessions/${bound.bridgeSessionId}`;
        const serialized = body ? JSON.stringify(body) : null;
        if (serialized && Buffer.byteLength(serialized, 'utf8') > MaxSessionBytes + metadata.legacyMaxBytes + 1024)
            throw failure();
        const headers = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29',
            'anthropic-client-feature': 'ccr', 'x-organization-uuid': bound.organizationId,
            'X-Expected-Account': bound.accountId, ...(body ? { 'content-type': 'application/json' } : {}) };
        return guarded(state, async () => {
            const response = await fetch(url, { method: body ? 'PUT' : 'GET',
                credentials: 'include', cache: 'no-store', redirect: 'error', headers,
                signal: state.controller.signal, ...(body ? { body: serialized } : {}) });
            if (!valid(state) || !response?.ok || response.url && response.url !== url) {
                void response?.body?.cancel?.().catch(() => {});
                throw failure();
            }
            if (!body) return readBody(state, response);
            void response.body?.cancel?.().catch(() => {});
            return null;
        });
    }

    function cloudEnvelope(detail, state) {
        const session = detail?.session ?? (record(detail?.response_shape) ? detail.response_shape : null);
        if (!record(detail) || detail.shared || detail.is_shared || !record(session) || session.shared || session.is_shared
            || protocol.normalizeBridgeId(session.id) !== state.bound.bridgeSessionId
            || !['bridge', 'ENVIRONMENT_KIND_BRIDGE'].includes(session.environment_kind)
            || (session.connection_status ?? detail.connection_status) !== 'connected') throw failure();
        const container = session.client_metadata ?? detail.client_metadata;
        if (container !== undefined && !record(container)) throw failure();
        if (!container || !Object.hasOwn(container, metadata.key))
            return { envelope: null, compare: { op: 'test', path: '', value: container ?? {} } };
        const value = container[metadata.key];
        let descriptor = value;
        if (typeof value === 'string') {
            if (Buffer.byteLength(value, 'utf8') > metadata.legacyMaxBytes) throw failure();
            try { descriptor = JSON.parse(value); } catch { throw failure(); }
        }
        const parsed = descriptor?.protocolVersion === 2
            ? metadata.parseLocation(value, { ...state.bound, now: descriptor.generatedAt })
            : metadata.parseEnvelope(value, state.bound);
        if (!parsed.ok) throw failure();
        return { envelope: parsed.location ?? parsed.envelope,
            compare: { op: 'test', path: `/${metadata.key}`, value: container[metadata.key] } };
    }

    function mayReplace(state, existing, candidate) {
        if (!existing) return true;
        if (existing.publisherId !== candidate.publisherId) {
            if (state.published?.publisherId === candidate.publisherId
                && existing.generatedAt >= state.published.generatedAt) state.lostPublisher = candidate.publisherId;
            return now() - existing.generatedAt > protocol.maxAgeMs
                && state.lostPublisher !== candidate.publisherId;
        }
        if (existing.protocolVersion === 1) return now() - existing.generatedAt > protocol.maxAgeMs;
        return candidate.generatedAt > existing.generatedAt
            || candidate.generatedAt === existing.generatedAt && candidate.directory === existing.directory;
    }

    async function publish(state) {
        state.controller = new AbortController();
        state.nextAt = now() + PublishIntervalMs;
        try {
            const cloud = cloudEnvelope(await request(state), state), existing = cloud.envelope;
            if (!valid(state)) return;
            const raw = await guarded(state, () => source.readRemoteLocation(state.bound.bridgeSessionId,
                { organizationId: state.bound.organizationId, signal: state.controller.signal }));
            const candidate = metadata.makeLocation(raw);
            if (!candidate || !metadata.parseLocation(candidate, { ...state.bound, now: now() }).ok) return;
            if (!valid(state) || state.lostPublisher === candidate.publisherId
                || !mayReplace(state, existing, candidate)) return;
            if (existing && JSON.stringify(existing) === JSON.stringify(candidate)) {
                state.failures = 0;
                if (!state.published || candidate.generatedAt >= state.published.generatedAt)
                    state.published = { publisherId: candidate.publisherId, generatedAt: candidate.generatedAt };
                return;
            }
            state.nextAt = Math.max(state.nextAt, now() + PublishIntervalMs);
            await request(state, { client_metadata_patch: [cloud.compare,
                { op: 'add', path: `/${metadata.key}`, value: candidate }] });
            if (valid(state)) {
                state.failures = 0;
                state.nextAt = Math.max(state.nextAt, now() + PublishIntervalMs);
                state.published = { publisherId: candidate.publisherId, generatedAt: candidate.generatedAt };
            }
        } catch {
            state.failures = Math.min(state.failures + 1, 5);
            state.nextAt = now() + Math.min(MaxBackoffMs, PublishIntervalMs * 2 ** (state.failures - 1));
        } finally {
            state.controller = null;
        }
    }

    function refresh() {
        if (stopped) return Promise.resolve();
        if (pending) return pending;
        pending = (async () => {
            const available = bindings(), present = new Set(available.map(key));
            for (const [id, state] of states) if (!present.has(id)) {
                state.controller?.abort(); states.delete(id);
            }
            let selected = available;
            if (available.length > MaxSessions) {
                if (now() < nextWindowAt) return;
                selected = Array.from({ length: MaxSessions }, (_, index) => available[(cursor + index) % available.length]);
                cursor = (cursor + MaxSessions) % available.length;
                nextWindowAt = now() + PublishIntervalMs;
            } else cursor = 0;
            const selectedKeys = new Set(selected.map(key));
            for (const id of states.keys()) if (!selectedKeys.has(id)) states.delete(id);
            const queue = [];
            for (const bound of selected) {
                const id = key(bound);
                let state = history.get(id);
                if (!state) {
                    // 达到上限后保留旧身份的退役记录，避免轮转让旧发布者重新夺回所有权。
                    if (history.size >= MaxHistory) continue;
                    state = { key: id, bound, nextAt: -Infinity, failures: 0, controller: null,
                        published: null, lostPublisher: null };
                    history.set(id, state);
                }
                states.set(id, state);
                if (now() >= state.nextAt) queue.push(state);
            }
            let index = 0;
            async function worker() {
                while (!stopped && index < queue.length) {
                    const state = queue[index++];
                    if (valid(state)) await publish(state);
                }
            }
            await Promise.all(Array.from({ length: Math.min(MaxConcurrent, queue.length) }, worker));
        })().catch(() => {}).finally(() => { pending = null; });
        return pending;
    }

    function start() {
        if (stopped) return Promise.resolve();
        if (!started) {
            started = true;
            timer = setInterval(() => { void refresh(); }, pollMs);
            timer.unref?.();
        }
        return refresh();
    }

    function stop() {
        stopped = true;
        clearInterval(timer);
        for (const state of states.values()) state.controller?.abort();
        states.clear();
        history.clear();
        return pending ?? Promise.resolve();
    }

    return { start, stop };
}

module.exports = { createMetadataPublisher };
