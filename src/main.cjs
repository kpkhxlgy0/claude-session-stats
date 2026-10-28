'use strict';
const path = require('node:path');
const os = require('node:os');
const { createSessionStore } = require('./session-store.cjs');
const { createDesktopForkResolver } = require('./fork-metadata.cjs');
const { createCliWorkspaceResolver } = require('./cli-workspace.cjs');
const { resolveSession, isLocalId } = require('./session-map.cjs');
const { createRemoteBridge, projectStats } = require('./remote-bridge.cjs');
const { buildRemoteScripts } = require('./remote-reader.cjs');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { createSubagentBindings } = require('./subagent-binding.cjs');
const { randomUUID } = require('node:crypto');

function startMain(api, options = {}) {
    const claudeData = options.claudeData ?? require('electron').app.getPath('userData');
    const claudeHome = options.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    const resolve = options.resolveSession ?? resolveSession;
    const store = options.store ?? createSessionStore({ claudeHome,
        resolveFork: options.resolveFork ?? createDesktopForkResolver({ claudeData }).resolveFork });
    const resolveWorkspace = options.resolveWorkspace ?? createCliWorkspaceResolver({ claudeHome,
        processCacheMs: 2000, gitCacheMs: 2000 });
    const publisher = options.publisher ?? require('./snapshot-publisher.cjs').createSnapshotPublisher({ claudeData, store, resolveWorkspace });
    const protocol = createSnapshotProtocol();
    let stopped = false;
    let stopping;
    try {
        Promise.resolve(publisher.start()).catch(() => api.log.info('Session Stats snapshot publisher could not start'));
    } catch { api.log.info('Session Stats snapshot publisher could not start'); }
    api.ipc.handle('stats', async sessionId => {
        const unavailable = { threadId: isLocalId(sessionId) ? sessionId : null, status: 'unavailable', tps: null };
        if (stopped || !isLocalId(sessionId)) return unavailable;
        try {
            const shared = await publisher.readLocal(sessionId, { waitForPoll: false });
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
    api.ipc.handle('agent-stats', async request => {
        const sessionId = request?.sessionId;
        const agentId = protocol.normalizeAgentId(request?.agentId);
        const unavailable = { threadId: isLocalId(sessionId) ? sessionId : null,
            agentId, status: 'unavailable', tps: null };
        if (stopped || !isLocalId(sessionId) || !agentId) return unavailable;
        try {
            const shared = await publisher.readLocal(sessionId, { agentId, waitForPoll: false });
            if (stopped) return unavailable;
            if (shared !== null) return shared.agentId === agentId ? { ...shared, threadId: sessionId } : unavailable;
            const cliSessionId = await resolve(claudeData, sessionId);
            if (stopped || !cliSessionId) return unavailable;
            const stats = await store.getAgentStats(cliSessionId, agentId);
            const confirmedId = await resolve(claudeData, sessionId);
            if (stopped || confirmedId !== cliSessionId || stats?.agentId !== agentId
                || stats.threadId !== cliSessionId) return unavailable;
            return { ...stats, threadId: sessionId };
        } catch { return unavailable; }
    });
    const ipcMain = options.ipcMain ?? require('electron').ipcMain;
    const scripts = buildRemoteScripts(randomUUID());
    const remote = createRemoteBridge({ ipcMain,
        manifestId: api.manifest.id, onReady: stats => api.log.info(
            `Session Stats Remote Control snapshot ready; revision=${stats.snapshotRevision}; usageComplete=${stats.usageComplete}`),
        ...scripts });
    const binding = createRemoteBridge({ ipcMain, manifestId: api.manifest.id, channelName: 'agent-bindings',
        script: `(${createSubagentBindings.toString()})().readBindings()`, project(value) {
            if (!Array.isArray(value) || value.length > 64) return [];
            return value.filter(item => typeof item?.key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item.key))
                .map(item => {
                    const candidate = item.bound;
                    const local = isLocalId(candidate?.sessionId);
                    const remoteId = typeof candidate?.sessionId === 'string'
                        && /^session_[A-Za-z0-9_-]{1,128}$/.test(candidate.sessionId);
                    const agentId = protocol.normalizeAgentId(candidate?.agentId);
                    return { key: item.key, bound: agentId && (local && candidate.remote === false
                        || remoteId && candidate.remote === true)
                        ? { sessionId: candidate.sessionId, agentId, remote: candidate.remote } : null };
                });
        } });
    const remoteAgents = createRemoteBridge({ ipcMain, manifestId: api.manifest.id,
        channelName: 'remote-agent-stats', script: argument => scripts.agentScript(argument?.key),
        cleanupScript: scripts.cleanupScript, project(value) {
            const stats = projectStats(value);
            const agentId = protocol.normalizeAgentId(value?.agentId);
            return stats && agentId ? { ...stats, agentId } : null;
        } });
    api.log.info('Session Stats started; local statistics and Remote Control snapshot synchronization');
    return { stop() {
        if (stopped) return stopping;
        stopped = true;
        try { stopping = Promise.resolve(publisher.stop()).catch(() => {}); }
        catch { stopping = Promise.resolve(); }
        store.dispose(); remote.stop(); binding.stop(); remoteAgents.stop();
        // IPC 注册由 Claude++ 的 API lease 在 stop 后清理。
        return stopping;
    } };
}

module.exports = { startMain };
