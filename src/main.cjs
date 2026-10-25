'use strict';
const path = require('node:path');
const os = require('node:os');
const { createSessionStore } = require('./session-store.cjs');
const { createDesktopForkResolver } = require('./fork-metadata.cjs');
const { resolveSession, isLocalId } = require('./session-map.cjs');
const { createRemoteBridge } = require('./remote-bridge.cjs');
const { buildRemoteScripts } = require('./remote-reader.cjs');
const { randomUUID } = require('node:crypto');

function startMain(api, options = {}) {
    const claudeData = options.claudeData ?? require('electron').app.getPath('userData');
    const claudeHome = options.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    const resolve = options.resolveSession ?? resolveSession;
    const store = options.store ?? createSessionStore({ claudeHome,
        resolveFork: options.resolveFork ?? createDesktopForkResolver({ claudeData }).resolveFork });
    const publisher = options.publisher ?? require('./snapshot-publisher.cjs').createSnapshotPublisher({ claudeData, store });
    let stopped = false;
    let stopping;
    try {
        Promise.resolve(publisher.start()).catch(() => api.log.info('Session Stats snapshot publisher could not start'));
    } catch { api.log.info('Session Stats snapshot publisher could not start'); }
    api.ipc.handle('stats', async sessionId => {
        const unavailable = { threadId: isLocalId(sessionId) ? sessionId : null, status: 'unavailable', tps: null };
        if (stopped || !isLocalId(sessionId)) return unavailable;
        try {
            const shared = await publisher.readLocal(sessionId);
            if (stopped) return unavailable;
            if (shared !== null) return { ...shared, threadId: sessionId };
            const cliSessionId = await resolve(claudeData, sessionId);
            if (stopped || !cliSessionId) return unavailable;
            const stats = await store.getStats(cliSessionId);
            const confirmedId = await resolve(claudeData, sessionId);
            if (stopped || confirmedId !== cliSessionId) return unavailable;
            return { ...stats, threadId: sessionId };
        } catch { return unavailable; }
    });
    const remote = createRemoteBridge({ ipcMain: options.ipcMain ?? require('electron').ipcMain,
        manifestId: api.manifest.id, onReady: stats => api.log.info(
            `Session Stats Remote Control snapshot ready; revision=${stats.snapshotRevision}; usageComplete=${stats.usageComplete}`),
        ...buildRemoteScripts(randomUUID()) });
    api.log.info('Session Stats started; local statistics and Remote Control snapshot synchronization');
    return { stop() {
        if (stopped) return stopping;
        stopped = true;
        try { stopping = Promise.resolve(publisher.stop()).catch(() => {}); }
        catch { stopping = Promise.resolve(); }
        store.dispose(); remote.stop();
        // IPC 注册由 Claude++ 的 API lease 在 stop 后清理。
        return stopping;
    } };
}

module.exports = { startMain };
