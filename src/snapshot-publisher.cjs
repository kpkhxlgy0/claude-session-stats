'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { createSnapshotBindingAccess, snapshotBindingIdentity } = require('./snapshot-bindings.cjs');
const { isLocalId } = require('./session-map.cjs');
const MaxConcurrentFamilies = 2;
const MaxConcurrentPublications = 4;
const storageFailures = new Set(['EIO', 'ENODEV', 'ENXIO', 'ENOSPC', 'EROFS', 'EDQUOT', 'UNKNOWN']);

function fileIdentity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function fileVersion(info) { return `${fileIdentity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.nlink}`; }
function destinationChanged() {
    return Object.assign(new Error('Snapshot destination changed'), { code: 'SNAPSHOT_DESTINATION_CHANGED' });
}
function sameDestination(before, after) {
    return before?.version === after?.version && (!before?.corrupt || after?.corrupt?.equals(before.corrupt));
}
function bindingKey(binding) {
    return JSON.stringify([binding.accountId, binding.organizationId, binding.localSessionId,
        binding.cliSessionId, binding.bridgeSessionId, binding.workspaceRoot, binding.metadataFile,
        binding.workspaceEvidence ?? null, binding.agentId ?? null]);
}

function sourceKey(binding) {
    return JSON.stringify([binding.accountId, binding.organizationId, binding.cliSessionId,
        binding.workspaceRoot, binding.workspaceEvidence ?? null, binding.agentId ?? null]);
}

function workKey(binding) {
    return JSON.stringify([sourceKey(binding), binding.localSessionId, binding.metadataFile]);
}

function parentBinding(binding) {
    if (binding.agentId === undefined) return binding;
    const { agentId, ...parent } = binding;
    return parent;
}

function containsPath(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function createSnapshotPublisher({ claudeData, store, resolveWorkspace, now = Date.now, pollMs = 2000,
    heartbeatMs = 10000, publisherId = randomUUID(),
    claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude') } = {}) {
    if (typeof claudeHome !== 'string' || !path.isAbsolute(claudeHome)) throw new Error('Invalid Claude configuration directory');
    const home = path.resolve(claudeHome), snapshotDirectory = path.join(home, '.session-stats');
    const protocol = createSnapshotProtocol();
    const bindingAccess = createSnapshotBindingAccess();
    const { discoverSnapshotBindings, recheckSnapshotBinding, resolveSnapshotRelocation,
        resolveSnapshotAssistantTip } = bindingAccess;
    const states = new Map();
    let unavailableWorkspaces = new Set();
    const ownFiles = new Map();
    const ownTemps = new Set();
    let publicationRevision = 0;
    let timer, stopPending, stopped = false, started = false, epoch = 0;
    let discoveryRevision = 0, appliedDiscovery = 0, appliedProof = 0;
    const localDiscovery = new Map();
    let knownParents = new Map();
    let knownWorkspaceRoots = new Set();
    let globalChecks;
    const targetWrites = new Map(), parentChecks = new Map();
    const invalidParents = new Map();
    const pendingPrunes = new Set();
    const interests = new Map(), targets = new Map(), bindingGuards = new WeakMap();
    let activeRemote = [];
    let activePublications = 0;
    const publicationWaiters = [];
    let cancelWaits;
    const cancelled = new Promise(resolve => { cancelWaits = resolve; });

    function alive(runEpoch) { return !stopped && epoch === runEpoch; }

    function snapshotDestination(binding) {
        return path.join(snapshotDirectory, protocol.snapshotFilename(binding.bridgeSessionId, binding.agentId));
    }

    function writeTarget(binding, action) {
        const destination = snapshotDestination(binding);
        const key = process.platform === 'win32' ? destination.toLowerCase() : destination;
        const previous = targetWrites.get(key) || Promise.resolve();
        const next = previous.catch(() => {}).then(action);
        targetWrites.set(key, next);
        void next.finally(() => { if (targetWrites.get(key) === next) targetWrites.delete(key); }).catch(() => {});
        return next;
    }

    async function limited(items, action, runEpoch, concurrency = MaxConcurrentFamilies) {
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (alive(runEpoch) && index < items.length) await action(items[index++]);
        }));
    }

    async function withPublication(action) {
        if (activePublications >= MaxConcurrentPublications)
            await new Promise(resolve => publicationWaiters.push(resolve));
        else activePublications++;
        try { return await action(); }
        finally {
            if (publicationWaiters.length) publicationWaiters.shift()();
            else activePublications--;
        }
    }


    function unavailable(localSessionId, agentId) {
        return { ...protocol.projectStats({ status: 'unavailable', usageComplete: false }),
            threadId: localSessionId, ...(agentId !== undefined ? { agentId } : {}),
            snapshotUnavailableReason: 'publish-failed' };
    }

    async function directoryInfo(directory) {
        const info = await fs.lstat(directory, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe snapshot directory');
        return fileIdentity(info);
    }

    async function directories(binding, create) {
        const result = [];
        const root = binding.workspaceRoot;
        if ([root, ...knownWorkspaceRoots].some(workspace => containsPath(snapshotDirectory, workspace)))
            throw new Error('Snapshot storage contains the workspace');
        if (await fs.realpath(root) !== root) throw new Error('Workspace root changed');
        result.push([root, await directoryInfo(root)]);
        if (path.relative(home, await fs.realpath(home)) !== '') throw new Error('Claude configuration directory changed');
        result.push([home, await directoryInfo(home)]);
        for (const directory of [snapshotDirectory]) {
            if (create) {
                await confirmDirectories(result);
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

    async function readFileProof(file) {
        let info;
        try { info = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > protocol.maxBytes)
            throw new Error('Unsafe snapshot destination');
        const handle = await fs.open(file, 'r');
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || fileVersion(opened) !== fileVersion(info)) throw destinationChanged();
            const buffer = Buffer.alloc(protocol.maxBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > protocol.maxBytes) throw new Error('Unsafe snapshot destination');
            const final = await fs.lstat(file);
            if (bytesRead !== info.size || fileVersion(await handle.stat()) !== fileVersion(info)
                || !final.isFile() || final.isSymbolicLink() || fileVersion(final) !== fileVersion(info))
                throw destinationChanged();
            return { bytes: buffer.subarray(0, bytesRead), identity: fileIdentity(info), version: fileVersion(info) };
        } finally { await handle.close(); }
    }

    async function readDestination(file, binding, allowCorrupt = false) {
        const proof = await readFileProof(file);
        if (!proof) return null;
        let text, value;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(proof.bytes);
            value = JSON.parse(text);
        } catch {
            if (allowCorrupt) return { corrupt: proof.bytes, identity: proof.identity, version: proof.version };
            throw new Error('Unknown snapshot destination ownership');
        }
        const parsed = protocol.parseSnapshot(text, { bridgeSessionId: binding.bridgeSessionId,
            organizationId: binding.organizationId, agentId: binding.agentId, now: value?.generatedAt });
        if (!parsed.ok) throw new Error('Unknown snapshot destination ownership');
        return { snapshot: parsed.snapshot, identity: proof.identity, version: proof.version };
    }

    async function backupCorrupt(destination, before, expected) {
        const directory = path.join(expected.at(-1)[0], 'corrupt-backups');
        await confirmDirectories(expected);
        try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const guarded = [...expected, [directory, await directoryInfo(directory)]];
        await confirmDirectories(guarded);
        const digest = createHash('sha256').update(before.corrupt).digest('hex');
        const backup = path.join(directory, `${path.basename(destination)}.corrupt-${digest}.bak`);
        let handle, createdIdentity, createdWriteComplete = false;
        try {
            try {
                try {
                    handle = await fs.open(backup, 'wx', 0o600);
                    createdIdentity = fileIdentity(await handle.stat());
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    const existing = await readFileProof(backup);
                    await confirmDirectories(guarded);
                    if (!existing?.bytes.equals(before.corrupt)) throw new Error('Unknown corrupt snapshot backup');
                    handle = await fs.open(backup, 'r+');
                    if (fileVersion(await handle.stat()) !== existing.version) throw destinationChanged();
                }
                await confirmDirectories(guarded);
                const opened = await handle.stat(), current = await fs.lstat(backup);
                if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
                    || fileVersion(opened) !== fileVersion(current)) throw destinationChanged();
                if (createdIdentity) { await handle.writeFile(before.corrupt); createdWriteComplete = true; }
                await confirmDirectories(guarded);
                await handle.sync();
                await confirmDirectories(guarded);
            } finally { await handle?.close(); }
            const saved = await readFileProof(backup);
            await confirmDirectories(guarded);
            if (!saved?.bytes.equals(before.corrupt)) throw new Error('Corrupt snapshot backup changed');
            return guarded;
        } catch (error) {
            // Only our own incomplete creation may be removed. Existing conflicts
            // and complete copies survive errors so a later refresh can reuse them.
            if (createdIdentity && !createdWriteComplete) try {
                await confirmDirectories(guarded);
                const partial = await readFileProof(backup);
                if (partial?.identity === createdIdentity && partial.bytes.length < before.corrupt.length
                    && before.corrupt.subarray(0, partial.bytes.length).equals(partial.bytes)) {
                    await confirmDirectories(guarded);
                    const current = await fs.lstat(backup);
                    if (!current.isSymbolicLink() && fileVersion(current) === partial.version) await fs.unlink(backup);
                }
            } catch { /* Preserve unproven or unsafe backup state. */ }
            throw error;
        }
    }

    async function removeOwn(file, binding) {
        const owned = ownFiles.get(file);
        if (!owned || bindingKey(owned.binding) !== bindingKey(binding) || file !== snapshotDestination(binding)) return;
        try {
            const expected = await directories(binding, false);
            const existing = await readDestination(file, binding);
            if (JSON.stringify(existing?.snapshot) !== JSON.stringify(owned.snapshot)) return;
            await confirmDirectories(expected);
            const current = await fs.lstat(file);
            if (ownFiles.get(file) === owned && fileVersion(current) === existing.version && !current.isSymbolicLink()) {
                await fs.unlink(file);
                if (ownFiles.get(file) === owned) ownFiles.delete(file);
            }
        } catch { /* Never remove unknown or unsafe state. */ }
    }

    async function current(binding, runEpoch) {
        const parent = parentBinding(binding), key = bindingKey(parent);
        if (!alive(runEpoch) || bindingGuards.has(binding) && !bindingGuards.get(binding)()) return false;
        if (!knownParents.has(key) || invalidParents.has(key)) return false;
        let checks = parentChecks.get(key);
        if (!checks) {
            checks = { parent, waiting: [] };
            parentChecks.set(key, checks);
            queueMicrotask(async () => {
                while (checks.waiting.length) {
                    // Gather callers from separate filesystem completions before
                    // freezing this cohort. No proof I/O has started for it yet.
                    await new Promise(resolve => setImmediate(resolve));
                    // Freeze this cohort before starting any proof I/O. Later callers
                    // must wait for a proof that starts after their own preceding I/O.
                    const cohort = checks.waiting.splice(0);
                    let matches = false;
                    try {
                        if (!stopped && knownParents.has(key) && !invalidParents.has(key))
                            matches = await recheckSnapshotBinding(checks.parent, { resolveWorkspace });
                    } catch { /* A failed proof cannot reuse an earlier successful result. */ }
                    for (const resolve of cohort) resolve(matches === true);
                }
                if (parentChecks.get(key) === checks) parentChecks.delete(key);
            });
        }
        const matches = await Promise.race([
            new Promise(resolve => { checks.waiting.push(resolve); }), cancelled.then(() => false)]);
        const valid = knownParents.has(key) && !invalidParents.has(key) && matches;
        return alive(runEpoch) && valid && (!bindingGuards.has(binding) || bindingGuards.get(binding)());
    }

    async function publish(binding, snapshot, runEpoch, verify) {
        let expected = await directories(binding, true);
        const directory = expected.at(-1)[0];
        const destination = snapshotDestination(binding);
        const before = await readDestination(destination, binding, snapshot.stats.status === 'ok');
        const temporary = path.join(directory, `.${binding.bridgeSessionId}.${publisherId}.${randomUUID()}.tmp`);
        let handle;
        try {
            if (!await verify()) throw new Error('Snapshot identity changed');
            await confirmDirectories(expected);
            if (before?.corrupt) {
                if (!await stillOwned(binding, runEpoch)) throw new Error('Snapshot identity changed');
                expected = await backupCorrupt(destination, before, expected);
                if (!await stillOwned(binding, runEpoch)) throw new Error('Snapshot identity changed');
                await confirmDirectories(expected);
                if (!sameDestination(before, await readDestination(destination, binding, true))) throw destinationChanged();
            }
            handle = await fs.open(temporary, 'wx', 0o600);
            ownTemps.add(temporary);
            await handle.writeFile(JSON.stringify(snapshot) + '\n', 'utf8');
            if (before?.corrupt) await handle.sync();
            await handle.close(); handle = null;
            if (!await (before?.corrupt ? stillOwned(binding, runEpoch) : verify()))
                throw new Error('Snapshot identity changed');
            await confirmDirectories(expected);
            const after = await readDestination(destination, binding, !!before?.corrupt);
            if (!sameDestination(before, after)) throw destinationChanged();
            await confirmDirectories(expected);
            for (let attempt = 0; ; attempt++) {
                if (stopped || epoch !== runEpoch) throw new Error('Snapshot publisher stopped');
                try { await fs.rename(temporary, destination); break; }
                catch (error) {
                    // Windows readers can briefly deny replacement while their file handle closes.
                    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                        || attempt >= 6) throw error;
                    await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
                    if (!await (before?.corrupt ? stillOwned(binding, runEpoch) : verify()))
                        throw new Error('Snapshot identity changed');
                    await confirmDirectories(expected);
                    const latest = await readDestination(destination, binding, !!before?.corrupt);
                    if (!sameDestination(before, latest)) throw destinationChanged();
                    await confirmDirectories(expected);
                }
            }
            ownTemps.delete(temporary);
            ownFiles.set(destination, { binding, snapshot });
            if (stopped || epoch !== runEpoch || !await verify()) {
                await removeOwn(destination, binding);
                throw new Error('Snapshot identity changed');
            }
            return snapshot;
        } catch (error) {
            // Recovery failure must preserve even a concurrently repaired destination.
            if (before?.corrupt) error.preserveDestination = true;
            throw error;
        } finally {
            await handle?.close();
            if (ownTemps.delete(temporary)) {
                try { await confirmDirectories(expected); await fs.unlink(temporary); } catch { /* Preserve unsafe descendants. */ }
            }
        }
    }

    async function pruneStates(bindings, onlyBindings, markUnavailable = !!onlyBindings) {
        const keys = new Set(bindings.map(bindingKey));
        const onlyKeys = onlyBindings && new Set(onlyBindings.map(bindingKey));
        const removals = [];
        for (const [key, state] of states) {
            if (!keys.has(key) && (!onlyKeys || onlyKeys.has(key))) {
            const generation = state.generation || 0, discovery = appliedProof;
            const removal = { localSessionId: state.binding.localSessionId, agentId: state.binding.agentId };
            removal.done = writeTarget(state.binding, async () => {
                if (states.get(key) !== state) return;
                if ((generation !== (state.generation || 0) || discovery < appliedProof)
                    && await stillOwned(state.binding, epoch)) return;
                // A failed final confirmation is not evidence that this session is unbound.
                if (markUnavailable) unavailableWorkspaces.add(state.binding.localSessionId);
                states.delete(key);
                if (state.destination) {
                    // User storage survives workspace moves. Remove only the
                    // exact sample owned by this binding, never its successor.
                    await removeOwn(state.destination, state.binding);
                }
            });
            pendingPrunes.add(removal);
            void removal.done.finally(() => pendingPrunes.delete(removal)).catch(() => {});
            removals.push(removal.done);
            }
        }
        await Promise.all(removals);
    }

    async function stillOwned(binding, runEpoch) {
        if (!await current(binding, runEpoch)) return false;
        if (binding.agentId === undefined) return true;
        const context = sourceContext(binding, runEpoch);
        if (typeof store.verifyAgentMembership === 'function')
            return await store.verifyAgentMembership(binding.cliSessionId, binding.agentId, context) === true;
        // Legacy injected stores may provide a membership list, but the normal
        // producer checks only the explicitly requested child file.
        if (typeof store.listAgents !== 'function') return false;
        const ids = await store.listAgents(binding.cliSessionId, context);
        return Array.isArray(ids) && ids.includes(binding.agentId) && await current(binding, runEpoch);
    }

    function sourceContext(binding, runEpoch) {
        const valid = () => !stopped && runEpoch === epoch && (!bindingGuards.has(binding) || bindingGuards.get(binding)());
        return {
            workspaceRoot: binding.workspaceRoot, verify: () => current(binding, runEpoch),
            resolveRelocation: async cwd => {
                if (!valid()) return null;
                const proof = await resolveSnapshotRelocation(parentBinding(binding), cwd, { resolveWorkspace });
                return valid() ? proof : null;
            }, resolveAssistantTip: async () => {
                if (!valid()) return null;
                const tip = await resolveSnapshotAssistantTip(parentBinding(binding), { resolveWorkspace });
                return valid() ? tip : null;
            } };
    }

    function scanParents(targets) {
        let checks = globalChecks;
        if (!checks) {
            checks = { waiting: [] };
            globalChecks = checks;
            queueMicrotask(async () => {
                while (checks.waiting.length) {
                    const cohort = checks.waiting.splice(0), blocked = new Set();
                    const full = cohort.some(caller => caller.targets === undefined);
                    const selected = new Map(cohort.flatMap(caller => caller.targets || [])
                        .map(binding => [snapshotBindingIdentity(binding), binding]));
                    let parents = [], identities = new Set(), workspaceRoots = new Set();
                    try {
                        if (!stopped) parents = await discoverSnapshotBindings(claudeData, { resolveWorkspace,
                            onUnavailableWorkspace: id => blocked.add(id),
                            onIdentityScan: bindings => {
                                identities = new Set(bindings.map(snapshotBindingIdentity));
                                workspaceRoots = new Set(bindings.map(binding => binding.workspaceRoot));
                            },
                            ...(full ? {} : { onlyBindings: [...selected.values()] }) });
                    } catch { /* Failed scans must not reuse a preceding identity view. */ }
                    for (const parent of parents) workspaceRoots.add(parent.workspaceRoot);
                    for (const caller of cohort) caller.resolve({ parents, blocked, identities, workspaceRoots });
                }
                if (globalChecks === checks) globalChecks = null;
            });
        }
        return new Promise(resolve => { checks.waiting.push({ resolve, targets }); });
    }

    async function confirmParents(bindings, runEpoch) {
        const targets = [...new Map(bindings.map(binding => {
            const parent = parentBinding(binding);
            return [snapshotBindingIdentity(parent), parent];
        })).values()];
        const revision = ++discoveryRevision;
        const { parents, identities, workspaceRoots } = await scanParents(targets);
        if (!alive(runEpoch)) return { parents: [], revision, stale: true };
        const scope = new Set(targets.map(snapshotBindingIdentity));
        const confirmed = parents.filter(parent => scope.has(snapshotBindingIdentity(parent)));
        // A newer full scan may preserve these exact bindings while this fresh
        // confirmation is in flight. Keep its sample, but never apply older
        // proof over the newer discovery's identity or negative evidence.
        if (revision < appliedDiscovery) return { parents: confirmed.filter(parent => {
            const key = bindingKey(parent);
            return knownParents.has(key) && !invalidParents.has(key);
        }), revision, stale: false };
        for (const workspace of workspaceRoots) knownWorkspaceRoots.add(workspace);
        const keys = new Set(confirmed.map(bindingKey));
        const contradicted = [];
        appliedProof = Math.max(appliedProof, revision);
        // Global metadata contradictions are negative evidence even when their
        // workspaces were not among this batch's native verification targets.
        for (const [key, parent] of knownParents) {
            if (!identities.has(snapshotBindingIdentity(parent))
                && (invalidParents.get(key)?.revision || 0) <= revision) {
                invalidParents.set(key, { revision, localSessionId: parent.localSessionId });
                unavailableWorkspaces.add(parent.localSessionId);
                contradicted.push(...[...states.values()].map(state => state.binding)
                    .filter(binding => bindingKey(parentBinding(binding)) === key));
            }
        }
        for (const target of targets) {
            const key = bindingKey(target), previous = invalidParents.get(key);
            if (previous && previous.revision > revision) continue;
            if (keys.has(key)) invalidParents.delete(key);
            else {
                invalidParents.set(key, { revision, localSessionId: target.localSessionId });
                unavailableWorkspaces.add(target.localSessionId);
            }
        }
        await pruneStates([], contradicted, true);
        return { parents: confirmed, revision, stale: false };
    }

    async function publishBatch(bindings, samples, confirmed, runEpoch, times, completed) {
        const published = [];
        await limited(bindings, binding => writeTarget(binding, () => withPublication(async () => {
                if (!alive(runEpoch)) return;
                const key = bindingKey(binding);
                const previous = states.get(key);
                const state = previous || { binding, snapshot: null };
                states.set(key, state);
                let finishPublication;
                try {
                    const raw = samples.get(sourceKey(binding));
                    const stats = protocol.projectStats(raw);
                    if (!stats || !confirmed.has(key))
                        throw new Error('Snapshot statistics unavailable');
                    if (stats.status === 'incomplete' && state.snapshot?.stats.status === 'ok') {
                        if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
                        // Keep the same published revision during an incomplete read.
                        // Its original timestamp still expires for both local and RC readers.
                        return;
                    }
                    const time = now();
                    const unchanged = state.snapshot && JSON.stringify(stats) === JSON.stringify(state.snapshot.stats);
                    if (unchanged && time >= state.snapshot.generatedAt && time - state.snapshot.generatedAt < heartbeatMs) {
                        // No publication or fresh timestamp is claimed. Readers and the
                        // next real heartbeat still validate the destination normally.
                        return;
                    }
                    // Snapshot construction and revision reservation are in-memory.
                    // publish() freshly proves ownership before temporary-file I/O,
                    // after writing, and again after committing the rename.
                    const snapshot = protocol.makeSnapshot(binding, stats,
                        { publisherId, revision: publicationRevision + 1, now: times?.get(sourceKey(binding)) ?? time });
                    if (!snapshot) throw new Error('Snapshot statistics unavailable');
                    // Reserve before I/O: even an invalidated write may have been observed remotely.
                    publicationRevision = snapshot.revision;
                    state.publication = { snapshot, finished: new Promise(resolve => { finishPublication = resolve; }) };
                    state.snapshot = await publish(binding, snapshot, runEpoch, () => current(binding, runEpoch));
                    state.localSample = null;
                    state.generation = (state.generation || 0) + 1;
                    state.destination = snapshotDestination(binding);
                    published.push(binding);
                } catch (error) {
                    const candidate = state.publication?.snapshot;
                    const raw = samples.get(sourceKey(binding));
                    const deviceFailed = candidate && storageFailures.has(error.code);
                    state.localSample = deviceFailed && candidate.stats.status === 'ok'
                        && raw?.threadId === binding.cliSessionId && raw.agentId === binding.agentId ? candidate : null;
                    state.snapshot = null;
                    if (state.destination && !deviceFailed && !error.preserveDestination) await removeOwn(state.destination, binding);
                } finally {
                    if (finishPublication) { state.publication = null; finishPublication(); }
                }
                })).finally(() => completed?.(binding)), runEpoch, MaxConcurrentPublications);
        return published;
    }

    const targetKey = target => JSON.stringify([target.localSessionId, target.agentId ?? null]);
    function ownerHas(owner, key) {
        const interest = interests.get(owner);
        return !!interest && interest.expiresAt > now() && interest.keys.has(key);
    }
    function wanted(key) { return !stopped && [...interests.keys()].some(owner => ownerHas(owner, key)); }
    function revokeUnused() {
        for (const [key, target] of targets) if (!wanted(key)) {
            target.generation++; targets.delete(key);
            for (const [stateKey, state] of states) if (state.binding.localSessionId === target.localSessionId
                && state.binding.agentId === target.agentId) {
                states.delete(stateKey);
                if (state.destination) void writeTarget(state.binding, () => removeOwn(state.destination, state.binding));
            }
        }
    }
    function setInterest(owner, values, { expiresAt = now() + 8000 } = {}) {
        if (stopped || typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(owner)
            || !Array.isArray(values) || values.length > 2 || !Number.isSafeInteger(expiresAt)
            || expiresAt <= now() || expiresAt > now() + 8000) return false;
        const normalized = [];
        for (const value of values) {
            if (!isLocalId(value?.localSessionId) || value.agentId !== undefined && !protocol.normalizeAgentId(value.agentId)) return false;
            normalized.push({ localSessionId: value.localSessionId.toLowerCase(),
                ...(value.agentId !== undefined ? { agentId: value.agentId } : {}) });
        }
        if (!normalized.length) { releaseInterest(owner); return true; }
        interests.set(owner, { expiresAt, keys: new Set(normalized.map(targetKey)) });
        revokeUnused();
        for (const value of normalized) {
            const key = targetKey(value);
            if (!targets.has(key)) targets.set(key, { ...value, generation: 0, sample: null });
        }
        return true;
    }
    function releaseInterest(owner) { interests.delete(owner); revokeUnused(); }
    async function runTarget(target) {
        const key = targetKey(target), generation = target.generation, runEpoch = epoch;
        const valid = () => alive(runEpoch) && targets.get(key) === target && target.generation === generation && wanted(key);
        const revision = ++discoveryRevision;
        target.sample = unavailable(target.localSessionId, target.agentId);
        let localSession;
        const bindings = await discoverSnapshotBindings(claudeData, { resolveWorkspace,
            onlyLocalSessionIds: [target.localSessionId],
            onLocalSession(value) { if (value.localSessionId === target.localSessionId) localSession = value; } });
        if (!valid()) return;
        // Parent and child requests discover independently. An older result may
        // finish after a newer workspace mapping for this same local session.
        const signature = JSON.stringify([bindings.map(bindingKey).sort(), localSession]);
        const latest = localDiscovery.get(target.localSessionId);
        if (latest && revision < latest.revision && signature !== latest.signature) return;
        if (!latest || revision >= latest.revision) localDiscovery.set(target.localSessionId, { revision, signature });
        appliedDiscovery = Math.max(appliedDiscovery, revision);
        const parentKeys = new Set(bindings.map(bindingKey));
        for (const [oldKey, old] of knownParents) if (old.localSessionId === target.localSessionId && !parentKeys.has(oldKey)) {
            knownParents.delete(oldKey);
            invalidParents.set(oldKey, { revision, localSessionId: old.localSessionId });
        }
        const obsolete = [...states.values()].map(state => state.binding).filter(binding =>
            binding.localSessionId === target.localSessionId && binding.agentId === target.agentId
            && !parentKeys.has(bindingKey(parentBinding(binding))));
        if (obsolete.length) await pruneStates([], obsolete, true);
        if (!valid() || localDiscovery.get(target.localSessionId)?.signature !== signature) return;
        for (const binding of bindings) {
            const key = bindingKey(binding);
            if ((invalidParents.get(key)?.revision || 0) <= revision) invalidParents.delete(key);
        }
        if (!bindings.length) {
            // Ordinary local sessions need no RC snapshot, but use the same exact
            // lease and pre/post Desktop mapping checks as requested RC targets.
            const cliId = localSession?.available && localSession.cliSessionId;
            if (!valid() || !cliId) { target.sample = unavailable(target.localSessionId, target.agentId); return; }
            const sample = target.agentId === undefined ? await store.getStats(cliId)
                : await store.getAgentStats(cliId, target.agentId);
            let confirmed;
            await discoverSnapshotBindings(claudeData, { onlyLocalSessionIds: [target.localSessionId],
                onLocalSession(value) { if (value.localSessionId === target.localSessionId) confirmed = value; } });
            if (valid() && confirmed?.available && confirmed.cliSessionId === cliId && confirmed.metadataFile === localSession.metadataFile)
                target.sample = { ...sample, threadId: target.localSessionId };
            target.sampleAt = now();
            return;
        }
        const samples = new Map(), times = new Map();
        for (const parent of bindings) {
            knownParents.set(bindingKey(parent), parent); knownWorkspaceRoots.add(parent.workspaceRoot);
            const binding = target.agentId === undefined ? parent : { ...parent, agentId: target.agentId };
            bindingGuards.set(binding, valid);
            if (!valid()) return;
            const context = sourceContext(binding, runEpoch);
            const raw = target.agentId === undefined ? await store.getStats(binding.cliSessionId, context)
                : await store.getAgentStats(binding.cliSessionId, target.agentId, context);
            if (!valid()) return;
            if (target.agentId !== undefined && (raw?.agentId !== undefined && raw.agentId !== target.agentId
                || raw?.threadId !== undefined && raw.threadId !== binding.cliSessionId)) continue;
            samples.set(sourceKey(binding), raw); times.set(sourceKey(binding), now());
            const confirmed = await confirmParents([binding], runEpoch);
            if (!valid() || !confirmed.parents.some(value => bindingKey(value) === bindingKey(parent))) return;
            await publishBatch([binding], samples, new Set([bindingKey(binding)]), runEpoch, times);
        }
    }
    function queueTarget(target) {
        if (!target.pending) {
            target.pending = runTarget(target).catch(() => {
                if (wanted(targetKey(target))) target.sample = unavailable(target.localSessionId, target.agentId);
            }).finally(() => { target.pending = null; });
        }
        return target.pending;
    }
    function queuePoll() {
        for (const [owner, interest] of interests) if (interest.expiresAt <= now()) interests.delete(owner);
        revokeUnused();
        return Promise.all([...targets.values()].filter(target => wanted(targetKey(target))).map(queueTarget));
    }
    function start() {
        if (stopped) return Promise.resolve();
        if (!started) {
            started = true;
            timer = setInterval(() => { void queuePoll(); }, Math.max(1, pollMs)); timer.unref?.();
        }
        return queuePoll();
    }
    async function readLocal(localSessionId, { owner, agentId, waitForPoll = true } = {}) {
        const key = targetKey({ localSessionId: localSessionId?.toLowerCase(), agentId });
        if (!isLocalId(localSessionId) || !ownerHas(owner, key) || stopped) return unavailable(localSessionId, agentId);
        const target = targets.get(key);
        if (!target) return unavailable(localSessionId, agentId);
        if (waitForPoll) await queueTarget(target);
        if (!ownerHas(owner, key) || targets.get(key) !== target || stopped) return unavailable(localSessionId, agentId);
        const state = [...states.values()].find(state => state.binding.localSessionId === localSessionId.toLowerCase()
            && state.binding.agentId === agentId && state.snapshot);
        if (state) {
            const sample = await readPublished(state);
            return sample && ownerHas(owner, key) ? { ...sample.stats, threadId: localSessionId,
                ...(agentId !== undefined ? { agentId } : {}), snapshotGeneratedAt: sample.generatedAt,
                snapshotRevision: sample.revision, snapshotPublisherId: sample.publisherId } : unavailable(localSessionId, agentId);
        }
        const pending = [...states.values()].find(state => state.binding.localSessionId === localSessionId.toLowerCase()
            && state.binding.agentId === agentId && state.localSample);
        if (pending && await current(pending.binding, epoch) && ownerHas(owner, key)) {
            const sample = pending.localSample, age = now() - sample.generatedAt;
            if (age >= -protocol.futureSkewMs && age <= protocol.maxAgeMs)
                return { ...sample.stats, threadId: localSessionId, ...(agentId !== undefined ? { agentId } : {}), snapshotSync: 'local-only' };
        }
        return target.sample && now() - (target.sampleAt ?? now()) <= protocol.maxAgeMs
            ? target.sample : unavailable(localSessionId, agentId);
    }

    async function readPublished(state, { verify, valid = () => true } = {}) {
        const runEpoch = epoch, key = bindingKey(state.binding);
        const active = () => !stopped && epoch === runEpoch && states.get(key) === state && state.snapshot && valid();
        const recheck = verify || (() => current(state.binding, runEpoch));
        for (let attempt = 0; attempt < 3; attempt++) {
            const snapshot = state.snapshot;
            try {
                if (!active() || !await recheck()) throw new Error('Snapshot identity changed');
                const expected = await directories(state.binding, false);
                let existing = await readDestination(state.destination, state.binding);
                const publication = state.publication;
                const observed = JSON.stringify(existing?.snapshot);
                if (existing && publication && observed !== JSON.stringify(snapshot)
                    && observed !== JSON.stringify(state.snapshot) && observed === JSON.stringify(publication.snapshot)) {
                    // Rename exposes this candidate before its final identity check commits it.
                    // Wait only for that publication, then reread the actual destination.
                    await publication.finished;
                    if (!active()) throw new Error('Snapshot identity changed');
                    existing = await readDestination(state.destination, state.binding);
                }
                await confirmDirectories(expected);
                if (!await recheck() || !active()) throw new Error('Snapshot identity changed');
                const latest = state.snapshot;
                const encoded = JSON.stringify(existing?.snapshot);
                let sample;
                if (existing && encoded === JSON.stringify(latest)) sample = latest;
                else if (existing && encoded === JSON.stringify(snapshot)
                    && snapshot.stats.status === 'ok' && latest.stats.status === 'ok') sample = snapshot;
                else throw new Error('Published snapshot changed');
                const parsed = protocol.parseSnapshot(JSON.stringify(sample), { bridgeSessionId: state.binding.bridgeSessionId,
                    organizationId: state.binding.organizationId, agentId: state.binding.agentId, now: now() });
                if (!parsed.ok) throw new Error('Published snapshot expired');
                return parsed.snapshot;
            } catch (error) {
                // Atomic replacement can cross lstat/open/read. Retry only this file-identity race;
                // each attempt must still match a committed sample and recheck the binding.
                if (error.code === 'SNAPSHOT_DESTINATION_CHANGED' && attempt < 2 && active()) continue;
                // File cleanup belongs to serialized poll/stop paths, never an older read.
                if (state.snapshot === snapshot && active()) state.snapshot = null;
                return null;
            }
        }
    }

    async function readRemoteSnapshot(bridgeSessionId, { organizationId, agentId, signal } = {}) {
        const bridge = protocol.normalizeBridgeId(bridgeSessionId);
        if (!bridge || typeof organizationId !== 'string'
            || agentId !== undefined && !protocol.normalizeAgentId(agentId)
            || signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')
            || stopped || signal?.aborted) return null;
        const matches = () => [...states.values()].filter(state => state.binding.bridgeSessionId === bridge
            && state.binding.organizationId === organizationId.toLowerCase() && state.binding.agentId === agentId);
        const bound = matches();
        if (bound.length !== 1 || !bound[0].snapshot) return null;
        const state = bound[0], runEpoch = epoch, parent = parentBinding(state.binding), parentKey = bindingKey(parent);
        const valid = () => alive(runEpoch) && !signal?.aborted && matches().length === 1 && matches()[0] === state;
        const verify = async () => {
            if (!valid()) return false;
            const { parents } = await scanParents([parent]);
            return valid() && parents.some(binding => bindingKey(binding) === parentKey)
                && await stillOwned(state.binding, runEpoch);
        };
        let abort;
        try {
            const aborted = signal && new Promise(resolve => {
                abort = () => resolve(null);
                signal.addEventListener('abort', abort, { once: true });
            });
            const snapshot = await Promise.race([readPublished(state, { valid, verify }), cancelled,
                ...(aborted ? [aborted] : [])]);
            return valid() ? snapshot ?? null : null;
        } catch { return null; }
        finally { if (abort) signal.removeEventListener('abort', abort); }
    }

    async function listActiveRemoteBindings() {
        if (stopped || typeof resolveWorkspace?.listActiveSessions !== 'function') return [];
        const active = await resolveWorkspace.listActiveSessions();
        if (stopped || !active.length) { activeRemote = []; return []; }
        const localIds = [...new Set(active.map(value => value.localSessionId))];
        const bindings = await discoverSnapshotBindings(claudeData, { resolveWorkspace, onlyLocalSessionIds: localIds });
        activeRemote = bindings.filter(binding => typeof binding.workspaceEvidence === 'string' && active.some(value => value.localSessionId === binding.localSessionId
            && value.cliSessionId === binding.cliSessionId && (!value.bridgeSessionId
                || protocol.normalizeBridgeId(value.bridgeSessionId) === binding.bridgeSessionId)));
        for (const binding of activeRemote) knownWorkspaceRoots.add(binding.workspaceRoot);
        return activeRemote;
    }
    function listRemoteBindings() { return stopped ? [] : activeRemote; }

    function localAccess(binding) {
        return { localSessionId: binding.localSessionId, cliSessionId: binding.cliSessionId,
            bridgeSessionId: binding.bridgeSessionId, organizationId: binding.organizationId,
            accountId: binding.accountId, directory: snapshotDirectory };
    }

    function listLocalSnapshotAccess() {
        return stopped ? [] : [...new Map([...activeRemote, ...[...knownParents.values()].filter(binding =>
            [...targets.values()].some(target => target.localSessionId === binding.localSessionId && wanted(targetKey(target))))]
            .map(binding => [bindingKey(binding), binding])).values()].map(localAccess);
    }

    async function verifyLocalSnapshotAccess(candidate) {
        if (!candidate || stopped) return false;
        const keys = ['localSessionId', 'cliSessionId', 'bridgeSessionId', 'organizationId', 'accountId', 'directory'];
        const matches = () => listLocalSnapshotAccess().filter(value => keys.every(key => value[key] === candidate[key]));
        if (matches().length !== 1) return false;
        const binding = [...activeRemote, ...knownParents.values()].find(value => keys.every(key => localAccess(value)[key] === candidate[key]));
        const runEpoch = epoch;
        try {
            if (!binding) return false;
            const { parents } = await scanParents([binding]);
            if (!alive(runEpoch) || !parents.some(parent => bindingKey(parent) === bindingKey(binding))
                || !await recheckSnapshotBinding(binding, { resolveWorkspace })) return false;
            const expected = await directories(binding, false);
            await confirmDirectories(expected);
            return alive(runEpoch) && matches().length === 1;
        } catch { return false; }
    }

    async function readRemoteLocation(bridgeSessionId, { organizationId, signal } = {}) {
        const matches = activeRemote.filter(binding => binding.bridgeSessionId === bridgeSessionId
            && binding.organizationId === organizationId);
        if (stopped || signal?.aborted || matches.length !== 1) return null;
        const binding = matches[0];
        if (!await recheckSnapshotBinding(binding, { resolveWorkspace }) || stopped || signal?.aborted) return null;
        await directories(binding, true);
        return { bridgeSessionId, organizationId, publisherId, generatedAt: now(), directory: snapshotDirectory };
    }

    function stop() {
        if (stopPending) return stopPending;
        stopped = true; epoch++;
        interests.clear(); for (const target of targets.values()) target.generation++; targets.clear();
        bindingAccess.dispose();
        resolveWorkspace?.dispose?.();
        clearInterval(timer);
        cancelWaits();
        stopPending = (async () => {
            await Promise.allSettled([...targetWrites.values()]);
            for (const [file, owned] of ownFiles) await removeOwn(file, owned.binding);
            states.clear(); ownFiles.clear(); pendingPrunes.clear(); localDiscovery.clear();
        })();
        return stopPending;
    }
    return { start, setInterest, releaseInterest, readLocal, readRemoteSnapshot, listRemoteBindings, listActiveRemoteBindings, readRemoteLocation,
        listLocalSnapshotAccess, verifyLocalSnapshotAccess, stop };
}
module.exports = { createSnapshotPublisher };
