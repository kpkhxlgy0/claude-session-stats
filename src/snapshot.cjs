'use strict';

function createSnapshotProtocol() {
    // This factory is also serialized into the authenticated RC page; keep it self-contained.
    const maxBytes = 16384, maxAgeMs = 30000, futureSkewMs = 5000;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const counts = ['turns', 'steps', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens'];
    const statKeys = [...counts, 'cacheHit', 'tps', 'usageComplete', 'status'];
    const rootKeys = ['schemaVersion', 'producer', 'bridgeSessionId', 'organizationId',
        'publisherId', 'revision', 'generatedAt', 'stats'];
    const statuses = ['ok', 'incomplete', 'not-found', 'unavailable'];
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
        && keys.every(key => Object.hasOwn(value, key));

    function normalizeBridgeId(value) {
        const match = typeof value === 'string' && /^(?:cse_|session_)([A-Za-z0-9_-]{1,128})$/.exec(value);
        return match ? `session_${match[1]}` : null;
    }
    function snapshotPath(value) {
        const id = normalizeBridgeId(value);
        return id ? `.claude/session-stats/${id}.json` : null;
    }
    function projectStats(raw) {
        if (!record(raw) || !statuses.includes(raw.status) || typeof raw.usageComplete !== 'boolean') return null;
        const stats = { status: raw.status };
        for (const field of counts) {
            const value = raw[field] === undefined ? null : raw[field];
            if (value !== null && !integer(value)) return null;
            stats[field] = raw.status === 'ok' ? value : null;
        }
        for (const field of ['cacheHit', 'tps']) {
            const value = raw[field] === undefined ? null : raw[field];
            if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)
                || (field === 'cacheHit' ? value < 0 || value > 1 : value <= 0))) return null;
            stats[field] = raw.status === 'ok' ? value : null;
        }
        stats.usageComplete = raw.status === 'ok' && raw.usageComplete;
        return stats;
    }
    function makeSnapshot(binding, raw, { publisherId, revision, now } = {}) {
        const bridgeSessionId = normalizeBridgeId(binding?.bridgeSessionId);
        const organizationId = binding?.organizationId;
        const stats = projectStats(raw);
        if (!bridgeSessionId || typeof organizationId !== 'string' || !uuid.test(organizationId)
            || typeof publisherId !== 'string' || !uuid.test(publisherId)
            || !integer(revision) || revision === 0 || !integer(now) || !stats) return null;
        return { schemaVersion: 1, producer: 'claude-session-stats', bridgeSessionId,
            organizationId: organizationId.toLowerCase(), publisherId: publisherId.toLowerCase(),
            revision, generatedAt: now, stats };
    }
    function parseSnapshot(text, expected = {}) {
        const invalid = reason => ({ ok: false, reason });
        if (typeof text !== 'string' || text.length > maxBytes || !integer(expected.now)) return invalid('invalid');
        let snapshot;
        try { snapshot = JSON.parse(text); } catch { return invalid('invalid'); }
        if (!exactKeys(snapshot, rootKeys) || !exactKeys(snapshot.stats, statKeys)
            || snapshot.schemaVersion !== 1 || snapshot.producer !== 'claude-session-stats') return invalid('invalid');
        const normalized = makeSnapshot(snapshot, snapshot.stats, {
            publisherId: snapshot.publisherId, revision: snapshot.revision, now: snapshot.generatedAt });
        if (!normalized || normalized.bridgeSessionId !== snapshot.bridgeSessionId
            || normalized.organizationId !== snapshot.organizationId || normalized.publisherId !== snapshot.publisherId
            || statKeys.some(key => normalized.stats[key] !== snapshot.stats[key])) return invalid('invalid');
        const org = typeof expected.organizationId === 'string' ? expected.organizationId.toLowerCase() : null;
        if (snapshot.bridgeSessionId !== normalizeBridgeId(expected.bridgeSessionId)
            || snapshot.organizationId !== org) return invalid('identity');
        if (snapshot.generatedAt - expected.now > futureSkewMs) return invalid('future');
        if (expected.now - snapshot.generatedAt > maxAgeMs) return invalid('expired');
        return { ok: true, snapshot: normalized };
    }
    return { normalizeBridgeId, snapshotPath, projectStats, makeSnapshot, parseSnapshot,
        maxBytes, maxAgeMs, futureSkewMs };
}

module.exports = { createSnapshotProtocol };
