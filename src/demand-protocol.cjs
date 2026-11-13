'use strict';
// Serialized into the authenticated receiving page as well as used by the producer.
function createDemandProtocol() {
    const prefix = 'claudepp_session_stats_request_';
    const viewer = /^[A-Za-z0-9_-]{1,128}$/;
    const bridge = /^session_[A-Za-z0-9_-]{1,128}$/;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const agent = /^[A-Za-z0-9_-]{1,64}$/;
    const leaseMs = 8000;
    function key(id) { return typeof id === 'string' && viewer.test(id) ? prefix + id : null; }
    function parse(value, expected) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || value.protocolVersion !== 1 || !key(value.viewerId)
            || value.bridgeSessionId !== expected.bridgeSessionId || !bridge.test(value.bridgeSessionId)
            || value.organizationId !== expected.organizationId || !uuid.test(value.organizationId)
            || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= expected.now
            || value.expiresAt > expected.now + leaseMs
            || value.leaseId !== undefined && (typeof value.leaseId !== 'string' || !uuid.test(value.leaseId))
            || value.agentId !== undefined && (typeof value.agentId !== 'string' || !agent.test(value.agentId))
            || Object.keys(value).some(name => !['protocolVersion','viewerId','bridgeSessionId','organizationId','expiresAt','agentId','leaseId'].includes(name))) return null;
        return { protocolVersion: 1, viewerId: value.viewerId, bridgeSessionId: value.bridgeSessionId,
            organizationId: value.organizationId, expiresAt: value.expiresAt,
            ...(value.leaseId !== undefined ? { leaseId: value.leaseId } : {}),
            ...(value.agentId !== undefined ? { agentId: value.agentId } : {}) };
    }
    return { prefix, leaseMs, key, parse };
}
module.exports = { createDemandProtocol };
