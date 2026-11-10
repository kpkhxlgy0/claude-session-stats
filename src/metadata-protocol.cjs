'use strict';

function createMetadataProtocol(createSnapshotProtocol) {
    // 工厂也会序列化到已认证页面，不能依赖模块外的状态。
    const protocol = createSnapshotProtocol();
    const key = 'claudepp_session_stats', maxBytes = 256 * 1024, maxAgents = 128;
    const rootKeys = ['protocolVersion', 'bridgeSessionId', 'organizationId', 'publisherId',
        'generatedAt', 'parent', 'agents'];
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const invalid = reason => ({ ok: false, reason });

    function utf8Bytes(text) {
        let size = 0;
        for (const char of text) {
            const point = char.codePointAt(0);
            size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        }
        return size;
    }
    function encode(value, limit) {
        try {
            const text = typeof value === 'string' ? value : JSON.stringify(value);
            return typeof text === 'string' && text.length <= limit && utf8Bytes(text) <= limit ? text : null;
        } catch { return null; }
    }
    function parseSample(value, expected) {
        const text = encode(value, protocol.maxBytes);
        if (!text) return invalid('invalid');
        return protocol.parseSnapshot(text, { ...expected,
            ...(value?.schemaVersion === 2 ? { agentId: value.agentId } : {}), now: value?.generatedAt });
    }
    function parseEnvelope(value, expected = {}) {
        if (value === undefined || value === null) return invalid('missing');
        const text = encode(value, maxBytes);
        if (!text) return invalid('invalid');
        let envelope;
        try { envelope = JSON.parse(text); } catch { return invalid('invalid'); }
        if (!record(envelope) || Object.keys(envelope).length !== rootKeys.length
            || !rootKeys.every(field => Object.hasOwn(envelope, field)) || envelope.protocolVersion !== 1
            || !integer(envelope.generatedAt) || !Array.isArray(envelope.agents)
            || envelope.agents.length > maxAgents
            || envelope.parent !== null && (!record(envelope.parent) || envelope.parent.schemaVersion !== 1)
            || envelope.parent === null && envelope.agents.length === 0) return invalid('invalid');
        const bridgeSessionId = protocol.normalizeBridgeId(expected.bridgeSessionId);
        const organizationId = typeof expected.organizationId === 'string' ? expected.organizationId.toLowerCase() : null;
        if (!bridgeSessionId || envelope.bridgeSessionId !== bridgeSessionId
            || envelope.organizationId !== organizationId) return invalid('identity');
        const agents = [], seen = new Set();
        let parent = null, newest = -1;
        for (const value of [...(envelope.parent ? [envelope.parent] : []), ...envelope.agents]) {
            const child = value !== envelope.parent;
            if (!record(value) || child && value.schemaVersion !== 2
                || child && seen.has(value.agentId)) return invalid('invalid');
            const parsed = parseSample(value, { bridgeSessionId, organizationId });
            if (!parsed.ok) return parsed;
            const snapshot = parsed.snapshot;
            if (snapshot.publisherId !== envelope.publisherId) return invalid('identity');
            newest = Math.max(newest, snapshot.generatedAt);
            if (child) { seen.add(snapshot.agentId); agents.push(snapshot); }
            else parent = snapshot;
        }
        if (envelope.generatedAt !== newest) return invalid('invalid');
        return { ok: true, envelope: { protocolVersion: 1, bridgeSessionId, organizationId,
            publisherId: envelope.publisherId, generatedAt: newest, parent, agents } };
    }
    function readSnapshot(value, expected = {}) {
        if (!integer(expected.now)) return invalid('invalid');
        const child = expected.agentId !== undefined;
        const agentId = child ? protocol.normalizeAgentId(expected.agentId) : undefined;
        if (child && !agentId) return invalid('identity');
        const parsed = parseEnvelope(value, expected);
        if (!parsed.ok) return parsed;
        const snapshot = child ? parsed.envelope.agents.find(sample => sample.agentId === agentId) : parsed.envelope.parent;
        if (!snapshot) return invalid('missing');
        return protocol.parseSnapshot(JSON.stringify(snapshot), expected);
    }
    function makeEnvelope(snapshots, expected = {}) {
        if (!Array.isArray(snapshots) || snapshots.length > maxAgents + 1 || !integer(expected.now)) return null;
        const bridgeSessionId = protocol.normalizeBridgeId(expected.bridgeSessionId);
        const organizationId = typeof expected.organizationId === 'string' ? expected.organizationId.toLowerCase() : null;
        const agents = [], seen = new Set();
        let parent = null, publisherId = null, parentSeen = false, newest = -1;
        for (const value of snapshots) {
            const parsed = parseSample(value, { bridgeSessionId, organizationId });
            if (!parsed.ok) return null;
            const snapshot = parsed.snapshot, child = snapshot.schemaVersion === 2;
            if (publisherId && publisherId !== snapshot.publisherId || child && seen.has(snapshot.agentId)
                || !child && parentSeen) return null;
            publisherId = snapshot.publisherId;
            if (child) seen.add(snapshot.agentId);
            else parentSeen = true;
            if (snapshot.generatedAt - expected.now > protocol.futureSkewMs) return null;
            if (expected.now - snapshot.generatedAt > protocol.maxAgeMs) continue;
            newest = Math.max(newest, snapshot.generatedAt);
            if (child) agents.push(snapshot);
            else parent = snapshot;
        }
        if (newest < 0 || seen.size > maxAgents) return null;
        agents.sort((left, right) => left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0);
        const envelope = { protocolVersion: 1, bridgeSessionId, organizationId, publisherId,
            generatedAt: newest, parent, agents };
        return encode(envelope, maxBytes) ? envelope : null;
    }
    return { key, maxBytes, maxAgents, makeEnvelope, parseEnvelope, readSnapshot };
}

module.exports = { createMetadataProtocol };
