'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { discoverSnapshotBindings, recheckSnapshotBinding } = require('./snapshot-bindings.cjs');
const { isLocalId } = require('./session-map.cjs');

function fileIdentity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function bindingKey(binding) {
    return JSON.stringify([binding.accountId, binding.organizationId, binding.localSessionId,
        binding.cliSessionId, binding.bridgeSessionId, binding.workspaceRoot, binding.metadataFile]);
}

function containsPath(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveProtectedRoots(installationRoot, watchedTweaksRoot) {
    try {
        const roots = new Set([await fs.realpath(installationRoot)]);
        if (!watchedTweaksRoot) return [...roots];
        roots.add(path.resolve(watchedTweaksRoot));
        let watched;
        try { watched = await fs.realpath(watchedTweaksRoot); }
        catch (error) { if (error.code === 'ENOENT') return [...roots]; throw error; }
        if (!(await fs.stat(watched)).isDirectory()) return null;
        roots.add(watched);
        let entries = 0;
        const directory = await fs.opendir(watched);
        for await (const child of directory) {
            if (++entries > 4096) return null;
            if (!child.isDirectory() && !child.isSymbolicLink()) continue;
            const installed = path.join(watched, child.name);
            try {
                const target = await fs.realpath(installed);
                if ((await fs.stat(target)).isDirectory()) roots.add(target);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return [...roots];
    } catch { return null; }
}

function createSnapshotPublisher({ claudeData, store, now = Date.now, pollMs = 2000,
    heartbeatMs = 10000, publisherId = randomUUID(), installationRoot = path.resolve(__dirname, '..'),
    watchedTweaksRoot = process.env.CLAUDE_PLUSPLUS_USER_ROOT
        ? path.join(process.env.CLAUDE_PLUSPLUS_USER_ROOT, 'tweaks') : null } = {}) {
    const protocol = createSnapshotProtocol();
    const states = new Map();
    const ownFiles = new Map();
    const ownTemps = new Set();
    const protectedRoots = resolveProtectedRoots(installationRoot, watchedTweaksRoot);
    let publicationRevision = 0;
    let timer, pending, stopPending, stopped = false, started = false, epoch = 0;

    function unavailable(localSessionId) {
        return { ...protocol.projectStats({ status: 'unavailable', usageComplete: false }),
            threadId: localSessionId, snapshotUnavailableReason: 'publish-failed' };
    }

    async function directoryInfo(directory) {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe snapshot directory');
        return fileIdentity(info);
    }

    async function directories(binding, create) {
        const result = [];
        const root = binding.workspaceRoot;
        if (create) {
            const excluded = await protectedRoots;
            const managed = path.join(root, '.claude', 'session-stats');
            if (!excluded || excluded.some(directory => containsPath(directory, root)
                || containsPath(directory, managed) || containsPath(managed, directory)))
                throw new Error('Snapshot workspace overlaps a watched installation');
        }
        if (await fs.realpath(root) !== root) throw new Error('Workspace root changed');
        result.push([root, await directoryInfo(root)]);
        for (const directory of [path.join(root, '.claude'), path.join(root, '.claude', 'session-stats')]) {
            if (create) {
                try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
            result.push([directory, await directoryInfo(directory)]);
        }
        for (const [directory, identity] of result)
            if (await directoryInfo(directory) !== identity) throw new Error('Snapshot directory changed');
        return result;
    }

    async function confirmDirectories(expected) {
        for (const [directory, identity] of expected)
            if (await directoryInfo(directory) !== identity) throw new Error('Snapshot directory changed');
    }

    async function readDestination(file, binding) {
        let info;
        try { info = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > protocol.maxBytes)
            throw new Error('Unsafe snapshot destination');
        const handle = await fs.open(file, 'r');
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || fileIdentity(opened) !== fileIdentity(info))
                throw new Error('Snapshot destination changed');
            const buffer = Buffer.alloc(protocol.maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > protocol.maxBytes || fileIdentity(await fs.lstat(file)) !== fileIdentity(info))
                throw new Error('Snapshot destination changed');
            const text = buffer.subarray(0, bytesRead).toString('utf8');
            let generatedAt;
            try { generatedAt = JSON.parse(text)?.generatedAt; } catch { /* strict protocol rejects below */ }
            const parsed = protocol.parseSnapshot(text, { bridgeSessionId: binding.bridgeSessionId,
                organizationId: binding.organizationId, now: generatedAt });
            if (!parsed.ok) throw new Error('Unknown snapshot destination ownership');
            return { snapshot: parsed.snapshot, identity: fileIdentity(info) };
        } finally { await handle.close(); }
    }

    async function ensureIgnore(directory) {
        const file = path.join(directory, '.gitignore');
        let handle;
        try {
            handle = await fs.open(file, 'wx', 0o600);
            await handle.writeFile('*\n', 'utf8');
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const info = await fs.lstat(file);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe snapshot ignore file');
        } finally { await handle?.close(); }
    }

    async function removeOwn(file, binding) {
        try {
            const expected = await directories(binding, false);
            const existing = await readDestination(file, binding);
            if (existing?.snapshot.publisherId !== publisherId.toLowerCase()) return;
            await confirmDirectories(expected);
            const current = await fs.lstat(file);
            if (fileIdentity(current) === existing.identity && !current.isSymbolicLink()) await fs.unlink(file);
        } catch { /* Never remove unknown or unsafe state. */ }
    }

    async function current(binding, runEpoch) {
        if (stopped || epoch !== runEpoch) return false;
        const matches = await recheckSnapshotBinding(binding);
        return !stopped && epoch === runEpoch && matches;
    }

    async function publish(binding, snapshot, runEpoch) {
        const expected = await directories(binding, true);
        const directory = expected.at(-1)[0];
        const destination = path.join(binding.workspaceRoot, protocol.snapshotPath(binding.bridgeSessionId));
        await ensureIgnore(directory);
        const before = await readDestination(destination, binding);
        if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
        await confirmDirectories(expected);
        const temporary = path.join(directory, `.${binding.bridgeSessionId}.${publisherId}.${randomUUID()}.tmp`);
        let handle;
        try {
            handle = await fs.open(temporary, 'wx', 0o600);
            ownTemps.add(temporary);
            await handle.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
            await handle.close(); handle = null;
            if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
            await confirmDirectories(expected);
            const after = await readDestination(destination, binding);
            if (before?.identity !== after?.identity) throw new Error('Snapshot destination changed');
            for (let attempt = 0; ; attempt++) {
                if (stopped || epoch !== runEpoch) throw new Error('Snapshot publisher stopped');
                try { await fs.rename(temporary, destination); break; }
                catch (error) {
                    // Windows readers can briefly deny replacement while their file handle closes.
                    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                        || attempt >= 6) throw error;
                    await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
                    if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
                    await confirmDirectories(expected);
                    const latest = await readDestination(destination, binding);
                    if (before?.identity !== latest?.identity) throw new Error('Snapshot destination changed');
                }
            }
            ownTemps.delete(temporary);
            ownFiles.set(destination, binding);
            if (stopped || epoch !== runEpoch || !await current(binding, runEpoch)) {
                await removeOwn(destination, binding);
                throw new Error('Snapshot identity changed');
            }
            return snapshot;
        } finally {
            await handle?.close();
            if (ownTemps.delete(temporary)) {
                try { await confirmDirectories(expected); await fs.unlink(temporary); } catch { /* Preserve unsafe descendants. */ }
            }
        }
    }

    async function poll() {
        const runEpoch = epoch;
        const bindings = await discoverSnapshotBindings(claudeData);
        if (stopped || runEpoch !== epoch) return;
        const keys = new Set(bindings.map(bindingKey));
        for (const [key, state] of states) {
            if (!keys.has(key)) {
                states.delete(key);
                if (state.destination) await removeOwn(state.destination, state.binding);
            }
        }
        const samples = new Map();
        for (const binding of bindings) {
            if (stopped || runEpoch !== epoch) return;
            const sourceKey = `${binding.accountId}:${binding.organizationId}:${binding.cliSessionId}`;
            if (!samples.has(sourceKey)) {
                try { samples.set(sourceKey, await store.getStats(binding.cliSessionId)); }
                catch { samples.set(sourceKey, null); }
            }
        }
        // One batch confirmation catches new duplicates and overwritten mappings after collection.
        const confirmed = new Set((await discoverSnapshotBindings(claudeData)).map(bindingKey));
        if (stopped || runEpoch !== epoch) return;
        for (const binding of bindings) {
            if (stopped || runEpoch !== epoch) return;
            const key = bindingKey(binding);
            const previous = states.get(key);
            const state = previous || { binding, snapshot: null };
            states.set(key, state);
            try {
                const sourceKey = `${binding.accountId}:${binding.organizationId}:${binding.cliSessionId}`;
                const raw = samples.get(sourceKey);
                const stats = protocol.projectStats(raw);
                if (!stats || !confirmed.has(key) || !await current(binding, runEpoch))
                    throw new Error('Snapshot statistics unavailable');
                const time = now();
                const unchanged = state.snapshot && JSON.stringify(stats) === JSON.stringify(state.snapshot.stats);
                if (unchanged && time >= state.snapshot.generatedAt && time - state.snapshot.generatedAt < heartbeatMs) {
                    const expected = await directories(binding, false);
                    const existing = await readDestination(state.destination, binding);
                    await confirmDirectories(expected);
                    if (!existing || JSON.stringify(existing.snapshot) !== JSON.stringify(state.snapshot))
                        throw new Error('Published snapshot replaced');
                    continue;
                }
                const snapshot = protocol.makeSnapshot(binding, stats,
                    { publisherId, revision: publicationRevision + 1, now: time });
                if (!snapshot) throw new Error('Snapshot statistics unavailable');
                // Reserve before I/O: even an invalidated write may have been observed remotely.
                publicationRevision = snapshot.revision;
                state.snapshot = await publish(binding, snapshot, runEpoch);
                state.destination = path.join(binding.workspaceRoot, protocol.snapshotPath(binding.bridgeSessionId));
            } catch {
                state.snapshot = null;
                if (state.destination) await removeOwn(state.destination, binding);
            }
        }
    }

    function queuePoll() {
        if (stopped) return Promise.resolve();
        if (!pending) pending = poll().catch(() => {
            for (const state of states.values()) state.snapshot = null;
        }).finally(() => { pending = null; });
        return pending;
    }

    function start() {
        if (stopped) return Promise.resolve();
        if (!started) {
            started = true;
            timer = setInterval(() => { void queuePoll(); }, Math.max(1, pollMs));
            timer.unref?.();
        }
        return queuePoll();
    }

    async function readLocal(localSessionId) {
        if (!isLocalId(localSessionId)) return null;
        if (stopped) return unavailable(localSessionId);
        await queuePoll();
        if (stopped) return unavailable(localSessionId);
        const bound = [...states.values()].filter(state => state.binding.localSessionId === localSessionId.toLowerCase());
        if (!bound.length) return null;
        const state = bound.find(candidate => candidate.snapshot);
        if (!state) return unavailable(localSessionId);
        const snapshot = state.snapshot;
        try {
            const runEpoch = epoch;
            const parsed = protocol.parseSnapshot(JSON.stringify(snapshot), { bridgeSessionId: state.binding.bridgeSessionId,
                organizationId: state.binding.organizationId, now: now() });
            if (!parsed.ok || !await current(state.binding, runEpoch)) throw new Error('Snapshot identity changed');
            const expected = await directories(state.binding, false);
            const existing = await readDestination(state.destination, state.binding);
            await confirmDirectories(expected);
            if (!existing || JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)
                || !await current(state.binding, runEpoch)) throw new Error('Published snapshot changed');
        } catch {
            // A newer poll may have replaced this sample while validation was awaiting I/O.
            // File cleanup belongs to the serialized poll/stop paths, never an older read.
            if (state.snapshot === snapshot) state.snapshot = null;
            return unavailable(localSessionId);
        }
        if (stopped || state.snapshot !== snapshot) return unavailable(localSessionId);
        return { ...snapshot.stats, threadId: localSessionId, snapshotGeneratedAt: snapshot.generatedAt,
            snapshotRevision: snapshot.revision, snapshotPublisherId: snapshot.publisherId };
    }

    function stop() {
        if (stopPending) return stopPending;
        stopped = true; epoch++;
        clearInterval(timer);
        stopPending = (async () => {
            await pending;
            for (const [file, binding] of ownFiles) await removeOwn(file, binding);
            states.clear(); ownFiles.clear();
        })();
        return stopPending;
    }
    return { start, readLocal, stop };
}
module.exports = { createSnapshotPublisher };
