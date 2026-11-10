'use strict';

function createMetadataProtocol(createSnapshotProtocol) {
    // 工厂也会序列化到已认证页面，不能依赖模块外的状态。
    const protocol = createSnapshotProtocol();
    const key = 'claudepp_session_stats', maxBytes = 8192, maxDirectoryChars = 4096;
    const legacyMaxBytes = 256 * 1024, maxAgents = 128;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const locationKeys = ['protocolVersion', 'bridgeSessionId', 'organizationId', 'publisherId',
        'generatedAt', 'directory'];
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
        const text = encode(value, legacyMaxBytes);
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
        return encode(envelope, legacyMaxBytes) ? envelope : null;
    }
    function normalizePath(value) {
        if (typeof value !== 'string' || !value || value.startsWith('\\')
            || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
        for (const character of value) {
            const point = character.codePointAt(0);
            if (point >= 0xd800 && point <= 0xdfff) return null;
        }
        const path = value.replace(/\\/g, '/');
        const windows = /^[A-Za-z]:\//.test(path);
        if (!windows && (!path.startsWith('/') || value.includes('\\')) || path.startsWith('//')) return null;
        const parts = path.slice(windows ? 3 : 1).split('/');
        if (parts.some(part => !part || part === '.' || part === '..')) return null;
        if (windows && parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part)
            || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
        return path;
    }
    function normalizeDirectory(value) {
        if (typeof value !== 'string' || value.length > maxDirectoryChars) return null;
        const directory = normalizePath(value);
        return directory?.endsWith('/.session-stats') ? directory : null;
    }
    function makeLocation(value) {
        const sourceKeys = locationKeys.slice(1);
        if (!record(value) || Object.keys(value).length !== sourceKeys.length
            || !sourceKeys.every(field => Object.hasOwn(value, field))) return null;
        const bridgeSessionId = protocol.normalizeBridgeId(value.bridgeSessionId);
        const directory = normalizeDirectory(value.directory);
        if (!bridgeSessionId || !directory || !integer(value.generatedAt)
            || typeof value.organizationId !== 'string' || !uuid.test(value.organizationId)
            || typeof value.publisherId !== 'string' || !uuid.test(value.publisherId)) return null;
        const location = { protocolVersion: 2, bridgeSessionId, organizationId: value.organizationId.toLowerCase(),
            publisherId: value.publisherId.toLowerCase(), generatedAt: value.generatedAt, directory };
        return encode(location, maxBytes) ? location : null;
    }
    function parseLocation(value, expected = {}) {
        if (value === undefined || value === null) return invalid('missing');
        if (!integer(expected.now)) return invalid('invalid');
        const text = encode(value, maxBytes);
        if (!text) return invalid('invalid');
        let descriptor;
        try { descriptor = JSON.parse(text); } catch { return invalid('invalid'); }
        if (!record(descriptor) || Object.keys(descriptor).length !== locationKeys.length
            || !locationKeys.every(field => Object.hasOwn(descriptor, field))
            || descriptor.protocolVersion !== 2) return invalid('invalid');
        const { protocolVersion, ...raw } = descriptor;
        const location = makeLocation(raw);
        if (!location || locationKeys.some(field => location[field] !== descriptor[field])) return invalid('invalid');
        const organizationId = typeof expected.organizationId === 'string' ? expected.organizationId.toLowerCase() : null;
        if (location.bridgeSessionId !== protocol.normalizeBridgeId(expected.bridgeSessionId)
            || location.organizationId !== organizationId) return invalid('identity');
        if (location.generatedAt - expected.now > protocol.futureSkewMs) return invalid('future');
        if (expected.now - location.generatedAt > protocol.maxAgeMs) return invalid('expired');
        return { ok: true, location };
    }
    function snapshotPath(location, agentId) {
        const parsed = parseLocation(location, { bridgeSessionId: location?.bridgeSessionId,
            organizationId: location?.organizationId, now: location?.generatedAt });
        if (!parsed.ok) return null;
        const filename = protocol.snapshotFilename(parsed.location.bridgeSessionId, agentId);
        return filename ? `${parsed.location.directory}/${filename}` : null;
    }
    function samePath(actual, expected) {
        const left = normalizePath(actual), right = normalizePath(expected);
        if (!left || !right) return false;
        return /^[A-Za-z]:\//.test(right) ? left.toLowerCase() === right.toLowerCase() : left === right;
    }
    return { key, maxBytes, legacyMaxBytes, maxAgents, makeLocation, parseLocation, snapshotPath, samePath,
        makeEnvelope, parseEnvelope, readSnapshot };
}

module.exports = { createMetadataProtocol };
