'use strict';

const { randomUUID } = require('node:crypto');
const { isLocalId } = require('./session-map.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MaxPerTick = 8, MaxStates = 1024, RecheckMs = 30000, TimeoutMs = 5000;

function trustedUrl(value) {
    try {
        const url = new URL(value);
        return !url.username && !url.password && (url.origin === 'https://claude.ai'
            || url.protocol === 'app:' && url.host === 'localhost');
    } catch { return false; }
}

function privateDirectory(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || value.startsWith('\\')
        || /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value)) return false;
    const normalized = value.replace(/\\/g, '/'), windows = /^[A-Za-z]:\//.test(normalized);
    if (!windows && (!normalized.startsWith('/') || value.includes('\\')) || normalized.startsWith('//')) return false;
    const parts = normalized.slice(windows ? 3 : 1).split('/');
    if (parts.length < 2 || parts.at(-1) !== '.session-stats'
        || parts.some(part => !part || part === '.' || part === '..')) return false;
    if (!windows && ['dev', 'proc', 'sys'].includes(parts[0])) return false;
    return !windows || !parts.some(part => /[:<>"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

// The page has no producer identity fields. Inspection and mutation are split so
// the main process can reverify the producer after the asynchronous native read.
function accessPage(command) {
    const key = '__claudeppSnapshotDirectoryAccess';
    const current = window[key];
    if (command.mode === 'cancel') {
        if (current?.token === command.token) current.active = false;
        return null;
    }
    const trusted = () => {
        try {
            const url = new URL(window.location.href);
            return Number.isFinite(command.expiresAt) && Date.now() < command.expiresAt
                && window.location.href === command.url && !url.username && !url.password
                && (url.origin === 'https://claude.ai' || url.protocol === 'app:' && url.host === 'localhost');
        } catch { return false; }
    };
    if (!trusted()) return 'unavailable';
    const api = window['claude.web']?.LocalSessions;
    if (typeof api?.getSession !== 'function' || typeof api?.addDirectories !== 'function') return 'unavailable';
    const { localSessionId, bridgeSessionId, directory } = command.bound;
    const valid = session => session && typeof session === 'object' && !Array.isArray(session)
        && session.sessionId === localSessionId
        && (session.bridgeSessionId === bridgeSessionId
            || Array.isArray(session.bridgeSessionIds) && session.bridgeSessionIds.includes(bridgeSessionId))
        && session.remoteTarget == null && session.sshConfig == null
        && (session.additionalDirectories === undefined || Array.isArray(session.additionalDirectories)
            && session.additionalDirectories.every(value => typeof value === 'string'));
    if (command.mode === 'inspect') {
        if (current?.api === api && current.pending) return 'unavailable';
        const state = { token: command.token, nonce: command.nonce, active: true, pending: true, api, session: null };
        window[key] = state;
        let result;
        try { result = api.getSession(localSessionId); }
        catch { state.pending = false; return 'unavailable'; }
        return Promise.resolve(result).then(session => {
            if (!trusted() || window[key] !== state || !state.active
                || window['claude.web']?.LocalSessions !== api || !valid(session)) return 'unavailable';
            state.session = session;
            return session.additionalDirectories?.includes(directory) ? 'present' : 'ready';
        }, () => 'unavailable').finally(() => { state.pending = false; });
    }
    if (command.mode !== 'apply' || current?.token !== command.token || current.nonce !== command.nonce
        || !current.active || current.api !== api || !valid(current.session)) return 'unavailable';
    if (current.session.additionalDirectories?.includes(directory)) return 'present';
    // No await occurs before this invocation: stop cannot resume a suspended
    // permission mutation after the main process has revoked the page token.
    current.pending = true;
    let result;
    try { result = api.addDirectories(localSessionId, [directory]); }
    catch { current.pending = false; return 'unavailable'; }
    return Promise.resolve(result).then(accepted => accepted === true ? 'accepted' : 'unavailable', () => 'unavailable')
        .finally(() => { current.pending = false; });
}

function createSnapshotAccess({ source, getWebContents, now = Date.now, pollMs = 2000, log } = {}) {
    if (typeof source?.listLocalSnapshotAccess !== 'function'
        || typeof source?.verifyLocalSnapshotAccess !== 'function' || typeof getWebContents !== 'function'
        || typeof now !== 'function') throw new TypeError('A snapshot access source and web contents provider are required');
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) throw new RangeError('Invalid snapshot access interval');
    const token = randomUUID(), states = new Map(), frames = new Map(), pendingReads = new Set(), verificationReads = new Map();
    let stopped = false, started = false, timer, pending, cursor = 0, nonce = 0;

    function normalize(value) {
        if (!isLocalId(value?.localSessionId) || typeof value.cliSessionId !== 'string' || !UUID.test(value.cliSessionId)
            || typeof value.bridgeSessionId !== 'string' || !/^session_[A-Za-z0-9_-]{1,128}$/.test(value.bridgeSessionId)
            || typeof value.organizationId !== 'string' || !UUID.test(value.organizationId)
            || typeof value.accountId !== 'string' || !UUID.test(value.accountId) || !privateDirectory(value.directory)) return null;
        return { localSessionId: value.localSessionId, cliSessionId: value.cliSessionId.toLowerCase(),
            bridgeSessionId: value.bridgeSessionId, organizationId: value.organizationId.toLowerCase(),
            accountId: value.accountId.toLowerCase(), directory: value.directory };
    }
    const identityKey = value => JSON.stringify([value.localSessionId, value.cliSessionId,
        value.organizationId, value.accountId, value.directory]);
    const bindingKey = value => JSON.stringify([identityKey(value), value.bridgeSessionId]);
    function bindings() {
        const values = source.listLocalSnapshotAccess();
        if (!Array.isArray(values)) throw new Error('Snapshot access source unavailable');
        const unique = new Map(), conflicts = new Set();
        for (const value of values) {
            const candidate = normalize(value);
            if (!candidate) continue;
            const previous = unique.get(candidate.localSessionId);
            if (previous && identityKey(previous[0]) !== identityKey(candidate)) conflicts.add(candidate.localSessionId);
            else if (!previous) unique.set(candidate.localSessionId, [candidate]);
            else if (!previous.some(value => value.bridgeSessionId === candidate.bridgeSessionId)) previous.push(candidate);
        }
        return [...unique.values()].flat().filter(value => !conflicts.has(value.localSessionId));
    }
    function valid(candidate) {
        if (stopped) return false;
        try { return bindings().some(value => bindingKey(value) === bindingKey(candidate)); } catch { return false; }
    }
    function live(target) {
        try {
            return !stopped && !target.sender.isDestroyed?.() && target.sender.mainFrame === target.frame
                && target.frame.url === target.url && trustedUrl(target.url);
        } catch { return false; }
    }
    function selectFrame(state) {
        if (frames.size >= MaxPerTick) return null;
        const eligible = [];
        for (const sender of getWebContents()) {
            try {
                const frame = sender.mainFrame, target = { sender, frame, url: frame?.url };
                if (typeof frame?.executeJavaScript === 'function' && live(target) && !frames.has(frame)) eligible.push(target);
            } catch { /* Detached web contents are not eligible. */ }
        }
        if (!eligible.length) return null;
        const index = state.frameCursor % eligible.length;
        state.frameCursor = (index + 1) % eligible.length;
        // Complete the frame cycle before changing bridge alias, covering their
        // Cartesian product even when only one frame and one alias can work.
        if (state.frameCursor === 0) state.aliasCursor++;
        return eligible[index];
    }
    function guarded(operation) {
        if (stopped) return Promise.reject(new Error('Snapshot access stopped'));
        return new Promise((resolve, reject) => {
            const finish = (error, value) => {
                if (!pendingReads.delete(cancel)) return;
                clearTimeout(deadline);
                if (error) reject(error); else resolve(value);
            };
            const cancel = () => finish(new Error('Snapshot access unavailable'));
            const deadline = setTimeout(cancel, TimeoutMs);
            pendingReads.add(cancel);
            try { Promise.resolve(operation()).then(value => finish(null, value), error => finish(error)); }
            catch (error) { finish(error); }
        });
    }
    async function verify(candidate) {
        if (!valid(candidate)) return false;
        const id = bindingKey(candidate);
        let read = verificationReads.get(id);
        if (!read) {
            if (verificationReads.size >= MaxPerTick) return false;
            read = Promise.resolve().then(() => valid(candidate) ? source.verifyLocalSnapshotAccess(candidate) : false);
            verificationReads.set(id, read);
            const finish = () => { if (verificationReads.get(id) === read) verificationReads.delete(id); };
            read.then(finish, finish);
        }
        return await guarded(() => read) === true && valid(candidate);
    }
    function execute(candidate, target, command) {
        if (!valid(candidate) || !live(target)) throw new Error('Snapshot access identity changed');
        return guarded(() => {
            if (frames.has(target.frame)) throw new Error('Snapshot access frame busy');
            const read = Promise.resolve(target.frame.executeJavaScript(`(${accessPage.toString()})(${JSON.stringify({
                ...command, expiresAt: Date.now() + TimeoutMs })})`));
            const execution = { target, read };
            frames.set(target.frame, execution);
            const finish = () => { if (frames.get(target.frame) === execution) frames.delete(target.frame); };
            read.then(finish, finish);
            return read;
        });
    }
    function report(state, status) {
        if (state.status === status) return;
        state.status = status;
        const message = `Session Stats snapshot directory access ${status}; localSessionId=${state.bound.localSessionId}`;
        try {
            if (typeof log === 'function') log(message);
            else log?.info?.(message);
        } catch { /* Logging cannot change permission state. */ }
    }
    async function grant(state) {
        state.nextAt = now() + 2000;
        let target;
        try {
            target = selectFrame(state);
            if (!target) throw new Error('Snapshot access page unavailable');
            const command = { token, nonce: ++nonce, url: target.url,
                bound: { localSessionId: state.bound.localSessionId, bridgeSessionId: state.bound.bridgeSessionId,
                    directory: state.bound.directory } };
            let status = await execute(state.bound, target, { ...command, mode: 'inspect' });
            if (!valid(state.bound) || !live(target)) throw new Error('Snapshot access identity changed');
            if (status === 'ready') {
                if (!await verify(state.bound)) throw new Error('Snapshot access identity unverified');
                status = await execute(state.bound, target, { ...command, mode: 'apply' });
            }
            if (!valid(state.bound) || !live(target) || !['accepted', 'present'].includes(status))
                throw new Error('Snapshot access unavailable');
            state.failures = 0;
            state.nextAt = now() + RecheckMs;
            report(state, status);
        } catch {
            state.failures = Math.min(state.failures + 1, 4);
            state.nextAt = now() + Math.min(10000, 2000 * 2 ** (state.failures - 1));
            if (!stopped) report(state, 'unavailable');
        }
    }
    function refresh() {
        if (stopped) return Promise.resolve();
        if (pending) return pending;
        pending = (async () => {
            const grouped = new Map();
            for (const candidate of bindings()) {
                const id = identityKey(candidate);
                if (!grouped.has(id)) grouped.set(id, []);
                grouped.get(id).push(candidate);
            }
            const available = [...grouped.entries()], present = new Set(grouped.keys());
            for (const id of states.keys()) if (!present.has(id)) states.delete(id);
            let count = 0, scanned = 0;
            while (!stopped && scanned < available.length && count < MaxPerTick) {
                const [id, aliases] = available[cursor % available.length];
                cursor = (cursor + 1) % available.length;
                scanned++;
                let state = states.get(id);
                if (!state) {
                    if (states.size >= MaxStates) states.delete(states.keys().next().value);
                    state = { bound: aliases[0], nextAt: -Infinity, failures: 0, status: null, aliasCursor: 0, frameCursor: 0 };
                    states.set(id, state);
                }
                if (now() < state.nextAt) continue;
                state.bound = aliases[state.aliasCursor % aliases.length];
                count++;
                await grant(state);
            }
        })().catch(() => {}).finally(() => { pending = null; });
        return pending;
    }
    function start() {
        if (!stopped && !started) {
            started = true;
            timer = setInterval(() => { void refresh(); }, pollMs);
            timer.unref?.();
        }
        return refresh();
    }
    function stop() {
        if (!stopped) {
            stopped = true;
            clearInterval(timer);
            for (const cancel of [...pendingReads]) cancel();
            for (const { target } of frames.values()) {
                try {
                    if (target.sender.mainFrame !== target.frame || target.frame.url !== target.url
                        || !trustedUrl(target.url)) continue;
                    Promise.resolve(target.frame.executeJavaScript(
                        `(${accessPage.toString()})(${JSON.stringify({ mode: 'cancel', token })})`)).catch(() => {});
                } catch { /* A destroyed or navigated page has no usable token. */ }
            }
            frames.clear(); states.clear();
        }
        return pending ?? Promise.resolve();
    }
    return { start, stop };
}

module.exports = { createSnapshotAccess };
