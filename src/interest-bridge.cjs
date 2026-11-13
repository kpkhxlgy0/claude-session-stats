'use strict';
const { isLocalId } = require('./session-map.cjs');
function createInterestBridge({ ipcMain, manifestId, publisher, onRelease = () => {} }) {
    const leases = new Map(), channels = ['stats-interest', 'stats-release'].map(value => `claudepp:${manifestId}:${value}`);
    let stopped = false;
    function frameFor(event) {
        try {
            const frame = event.senderFrame, url = new URL(frame.url);
            if (stopped || frame !== event.sender.mainFrame || event.sender.isDestroyed?.()
                || url.username || url.password || !(url.origin === 'https://claude.ai' || url.protocol === 'app:' && url.host === 'localhost')) return null;
            return frame;
        } catch { return null; }
    }
    function release(owner) {
        const lease = leases.get(owner);
        if (!lease) return;
        leases.delete(owner); lease.cleanup?.(); publisher.releaseInterest(owner); onRelease(lease.frame);
    }
    ipcMain.handle(channels[0], (event, request) => {
        const frame = frameFor(event), owner = request?.owner;
        if (!frame || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(owner)
            || leases.has(owner) && leases.get(owner).frame !== frame || !Array.isArray(request.targets)
            || request.targets.length > 2) return false;
        const match = /^\/(?:code|epitaxy)\/([^/]+)\/?$/.exec(new URL(frame.url).pathname);
        if (!match || request.targets.some(value => !isLocalId(value?.localSessionId)
            || value.localSessionId !== match[1])) return false;
        if (!leases.has(owner)) {
            if (leases.size >= 64) return false;
            const lease = { frame }; leases.set(owner, lease);
            const destroyed = () => release(owner);
            const navigated = (_e, _url, _inPlace, mainFrame) => { if (mainFrame !== false) release(owner); };
            event.sender.once?.('destroyed', destroyed);
            event.sender.on?.('did-start-navigation', navigated);
            lease.cleanup = () => { event.sender.removeListener?.('destroyed', destroyed);
                event.sender.removeListener?.('did-start-navigation', navigated); };
        }
        return publisher.setInterest(owner, request.targets);
    });
    ipcMain.handle(channels[1], (event, request) => {
        const frame = frameFor(event), lease = leases.get(request?.owner);
        if (!frame || !lease || lease.frame !== frame) return false;
        release(request.owner); return true;
    });
    return { stop() { stopped = true; for (const owner of [...leases.keys()]) release(owner); for (const channel of channels) ipcMain.removeHandler(channel); } };
}
module.exports = { createInterestBridge };
