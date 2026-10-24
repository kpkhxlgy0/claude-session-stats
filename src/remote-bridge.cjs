'use strict';

function isTrustedUrl(value) {
    if (typeof value !== 'string' || !value.length) return false;
    try {
        const url = new URL(value);
        if (url.username || url.password) return false;
        return url.origin === 'https://claude.ai'
            || (url.protocol === 'app:' && url.host === 'localhost');
    } catch { return false; }
}

function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function projectStats(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { threadId, source, status, turns, steps, totalTokens, inputTokens, outputTokens,
        cachedInputTokens, cacheHit, tps, usageComplete, snapshotGeneratedAt,
        snapshotRevision, snapshotPublisherId, unavailableReason } = value;
    if (typeof threadId !== 'string' || !/^session_[A-Za-z0-9_-]{1,128}$/.test(threadId)
        || source !== 'remote_control') return null;
    if (status === 'unavailable') {
        if (!['pending', 'offline', 'timeout', 'transport', 'snapshot-missing', 'snapshot-denied',
            'snapshot-unsupported', 'snapshot-invalid', 'snapshot-identity', 'snapshot-expired',
            'snapshot-future', 'snapshot-replay', 'source-unavailable'].includes(unavailableReason)) return null;
        return { threadId, source, status, unavailableReason, turns: null, steps: null,
            totalTokens: null, inputTokens: null, outputTokens: null, cachedInputTokens: null,
            cacheHit: null, tps: null, usageComplete: false };
    }
    if (status !== 'ok' || typeof usageComplete !== 'boolean'
        || count(snapshotGeneratedAt) === null || !(count(snapshotRevision) > 0)
        || typeof snapshotPublisherId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotPublisherId)) return null;
    return {
        threadId, source: 'remote_control', status: 'ok',
        turns: count(turns), steps: count(steps), totalTokens: count(totalTokens),
        inputTokens: count(inputTokens), outputTokens: count(outputTokens),
        cachedInputTokens: count(cachedInputTokens),
        cacheHit: Number.isFinite(cacheHit) && cacheHit >= 0 && cacheHit <= 1 ? cacheHit : null,
        tps: Number.isFinite(tps) && tps > 0 ? tps : null,
        usageComplete,
        snapshotGeneratedAt, snapshotRevision, snapshotPublisherId,
    };
}

function createRemoteBridge({ ipcMain, manifestId, script, cleanupScript, onReady = () => {}, timeoutMs = 3000 }) {
    const channel = `claudepp:${manifestId}:remote-stats`;
    const pending = new Set();
    const frames = new Map();
    let stopped = false;
    const readyFrames = new WeakSet();
    ipcMain.handle(channel, event => {
        let sender, frame, url;
        try {
            if (stopped) return null;
            sender = event.sender;
            frame = event.senderFrame;
            if (!frame || frame !== sender.mainFrame) return null;
            url = frame.url;
            if (!isTrustedUrl(url)) return null;
        } catch { return null; }
        if (typeof cleanupScript === 'string' && cleanupScript.length) frames.set(frame, sender);
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pending.delete(finish);
                resolve(value);
            };
            const timer = setTimeout(() => finish(null), timeoutMs);
            pending.add(finish);
            try {
                Promise.resolve(frame.executeJavaScript(script)).then(value => {
                    if (settled) return;
                    try {
                        if (stopped || event.sender !== sender || event.senderFrame !== frame
                            || sender.mainFrame !== frame || frame.url !== url) return finish(null);
                        const stats = projectStats(value);
                        if (stats && stats.turns !== null && !readyFrames.has(frame)) {
                            readyFrames.add(frame); onReady(stats);
                        }
                        finish(stats);
                    } catch { finish(null); }
                }, () => finish(null));
            } catch { finish(null); }
        });
    });
    return { stop() {
        if (stopped) return;
        stopped = true;
        for (const finish of pending) finish(null);
        ipcMain.removeHandler(channel);
        for (const [frame, sender] of frames) {
            try {
                if (sender.mainFrame !== frame || !isTrustedUrl(frame.url)) continue;
                Promise.resolve(frame.executeJavaScript(cleanupScript)).catch(() => {});
            } catch {}
        }
        frames.clear();
    } };
}

module.exports = { createRemoteBridge };
