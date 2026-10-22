'use strict';
const path = require('node:path');
const os = require('node:os');
const { createSessionStore } = require('./session-store.cjs');
const { resolveSession, isLocalId } = require('./session-map.cjs');
const { createRemoteBridge } = require('./remote-bridge.cjs');
const { buildRemoteScripts } = require('./remote-reader.cjs');
const { randomUUID } = require('node:crypto');

function startMain(api, options = {}) {
    const claudeData = options.claudeData ?? require('electron').app.getPath('userData');
    const claudeHome = options.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    const resolve = options.resolveSession ?? resolveSession;
    const store = options.store ?? createSessionStore({ claudeHome });
    let stopped = false;
    api.ipc.handle('stats', async sessionId => {
        const unavailable = { threadId: isLocalId(sessionId) ? sessionId : null, status: 'unavailable', tps: null };
        if (stopped || !isLocalId(sessionId)) return unavailable;
        try {
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
            `Session Stats Remote Control history ready; usageComplete=${stats.usageComplete}; tpsAvailable=${stats.tps !== null}`),
        ...buildRemoteScripts(randomUUID()) });
    api.log.info('Session Stats started; read-only local and Remote Control statistics');
    return { stop() {
        if (stopped) return;
        stopped = true; store.dispose(); remote.stop();
        // IPC 注册由 Claude++ 的 API lease 在 stop 后清理。
    } };
}

module.exports = { startMain };
