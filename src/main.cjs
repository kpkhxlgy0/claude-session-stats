'use strict';
const path = require('node:path');
const os = require('node:os');
const { createSessionStore } = require('./session-store.cjs');
const { resolveSession, isLocalId } = require('./session-map.cjs');

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
    api.log.info('Session Stats started; reading local session usage only');
    return { stop() {
        if (stopped) return;
        stopped = true; store.dispose();
        // IPC 注册由 Claude++ 的 API lease 在 stop 后清理。
    } };
}

module.exports = { startMain };
