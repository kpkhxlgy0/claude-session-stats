'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { discoverSnapshotBindings, recheckSnapshotBinding, resolveSnapshotRelocation,
    snapshotBindingIdentity } = require('./snapshot-bindings.cjs');
const { isLocalId } = require('./session-map.cjs');
const MaxAgentsPerParent = 128;
const MaxChildBindings = 4096;
const MaxConcurrentFamilies = 2;
const MaxAgentBatch = 8;
const MaxConcurrentPublications = 4;

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

function createSnapshotPublisher({ claudeData, store, resolveWorkspace, now = Date.now, pollMs = 2000,
    heartbeatMs = 10000, publisherId = randomUUID(), installationRoot = path.resolve(__dirname, '..'),
    watchedTweaksRoot = process.env.CLAUDE_PLUSPLUS_USER_ROOT
        ? path.join(process.env.CLAUDE_PLUSPLUS_USER_ROOT, 'tweaks') : null } = {}) {
    const protocol = createSnapshotProtocol();
    const states = new Map();
    let unavailableWorkspaces = new Set();
    const ownFiles = new Map();
    const ownTemps = new Set();
    const protectedRoots = resolveProtectedRoots(installationRoot, watchedTweaksRoot);
    let publicationRevision = 0;
    let requestedLocalId;
    let requestedParent;
    let requestedChild;
    let timer, stopPending, stopped = false, started = false, completedPoll = false, epoch = 0;
    let discoveryRevision = 0, appliedDiscovery = 0, appliedProof = 0;
    let knownParents = new Map();
    let globalChecks;
    const lanes = new Map(), sourcesInFlight = new Map(), targetWrites = new Map(), parentChecks = new Map();
    const invalidParents = new Map();
    let activePublications = 0;
    const publicationWaiters = [];
    let cancelWaits;
    const cancelled = new Promise(resolve => { cancelWaits = resolve; });

    function alive(runEpoch) { return !stopped && epoch === runEpoch; }

    function writeTarget(binding, action) {
        const destination = path.join(binding.workspaceRoot, protocol.snapshotPath(binding.bridgeSessionId, binding.agentId));
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

    function selectRequest(child, localSessionId, agentId) {
        const previous = child ? requestedChild : requestedParent;
        if (previous?.localSessionId === localSessionId && previous.agentId === agentId) return previous;
        previous?.cancel();
        const request = { localSessionId, agentId };
        request.cancelled = new Promise(resolve => { request.cancel = resolve; });
        if (child) requestedChild = request;
        else { requestedParent = request; requestedLocalId = localSessionId; }
        // The source flight can continue; its former selection must not occupy the new wait lane.
        lanes.delete(child ? 'requested-child' : 'requested-parent');
        return request;
    }

    function unavailable(localSessionId, agentId) {
        return { ...protocol.projectStats({ status: 'unavailable', usageComplete: false }),
            threadId: localSessionId, ...(agentId !== undefined ? { agentId } : {}),
            snapshotUnavailableReason: 'publish-failed' };
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
            if (fileVersion(current) === existing.version && !current.isSymbolicLink()) await fs.unlink(file);
        } catch { /* Never remove unknown or unsafe state. */ }
    }

    async function current(binding, runEpoch) {
        const parent = parentBinding(binding), key = bindingKey(parent);
        if (!alive(runEpoch)) return false;
        const forget = () => {
            if (!binding.workspaceEvidence) return;
            for (const [destination, owned] of ownFiles)
                if (bindingKey(parentBinding(owned)) === key) ownFiles.delete(destination);
        };
        if (!knownParents.has(key) || invalidParents.has(key)) { forget(); return false; }
        let checks = parentChecks.get(key);
        if (!checks) {
            checks = { parent, waiting: [] };
            parentChecks.set(key, checks);
            queueMicrotask(async () => {
                while (checks.waiting.length) {
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
        const matches = await new Promise(resolve => { checks.waiting.push(resolve); });
        const valid = knownParents.has(key) && !invalidParents.has(key) && matches;
        if (alive(runEpoch) && !valid) forget();
        return alive(runEpoch) && valid;
    }

    async function publish(binding, snapshot, runEpoch) {
        let expected = await directories(binding, true);
        const directory = expected.at(-1)[0];
        const destination = path.join(binding.workspaceRoot, protocol.snapshotPath(binding.bridgeSessionId, binding.agentId));
        await ensureIgnore(directory);
        const before = await readDestination(destination, binding, snapshot.stats.status === 'ok');
        const temporary = path.join(directory, `.${binding.bridgeSessionId}.${publisherId}.${randomUUID()}.tmp`);
        let handle;
        try {
            if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
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
            if (!await (before?.corrupt ? stillOwned(binding, runEpoch) : current(binding, runEpoch)))
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
                    if (!await (before?.corrupt ? stillOwned(binding, runEpoch) : current(binding, runEpoch)))
                        throw new Error('Snapshot identity changed');
                    await confirmDirectories(expected);
                    const latest = await readDestination(destination, binding, !!before?.corrupt);
                    if (!sameDestination(before, latest)) throw destinationChanged();
                    await confirmDirectories(expected);
                }
            }
            ownTemps.delete(temporary);
            ownFiles.set(destination, binding);
            if (stopped || epoch !== runEpoch || !await current(binding, runEpoch)) {
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
            removals.push(writeTarget(state.binding, async () => {
                if (states.get(key) !== state) return;
                if ((generation !== (state.generation || 0) || discovery < appliedProof)
                    && await stillOwned(state.binding, epoch)) return;
                // A failed final confirmation is not evidence that this session is unbound.
                if (markUnavailable) unavailableWorkspaces.add(state.binding.localSessionId);
                states.delete(key);
                if (state.destination) {
                    const replacement = bindings.find(candidate => candidate.accountId === state.binding.accountId
                        && candidate.organizationId === state.binding.organizationId
                        && candidate.localSessionId === state.binding.localSessionId
                        && candidate.cliSessionId === state.binding.cliSessionId
                        && candidate.bridgeSessionId === state.binding.bridgeSessionId
                        && candidate.agentId === state.binding.agentId);
                    if (state.binding.workspaceEvidence || replacement?.workspaceEvidence) {
                        // Forget moved/unverifiable destinations; never use their payload as migration input.
                        ownFiles.delete(state.destination);
                    } else {
                        await removeOwn(state.destination, state.binding);
                        ownFiles.delete(state.destination);
                    }
                }
            }));
            }
        }
        await Promise.all(removals);
    }

    async function stillOwned(binding, runEpoch) {
        if (!await current(binding, runEpoch)) return false;
        if (binding.agentId === undefined) return true;
        const ids = await listChildren(parentBinding(binding), runEpoch);
        return ids.includes(binding.agentId) && await current(binding, runEpoch);
    }

    function sourceContext(binding, runEpoch) {
        return binding.workspaceEvidence ? {
            workspaceRoot: binding.workspaceRoot, verify: () => current(binding, runEpoch),
            resolveRelocation: async cwd => {
                if (stopped || runEpoch !== epoch) return null;
                const proof = await resolveSnapshotRelocation(parentBinding(binding), cwd, { resolveWorkspace });
                return !stopped && runEpoch === epoch ? proof : null;
            } } : undefined;
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
                    let parents = [], identities = new Set();
                    try {
                        if (!stopped) parents = await discoverSnapshotBindings(claudeData, { resolveWorkspace,
                            onUnavailableWorkspace: id => blocked.add(id),
                            onIdentityScan: bindings => { identities = new Set(bindings.map(snapshotBindingIdentity)); },
                            ...(full ? {} : { onlyBindings: [...selected.values()] }) });
                    } catch { /* Failed scans must not reuse a preceding identity view. */ }
                    for (const caller of cohort) caller.resolve({ parents, blocked, identities });
                }
                if (globalChecks === checks) globalChecks = null;
            });
        }
        return new Promise(resolve => { checks.waiting.push({ resolve, targets }); });
    }

    async function discoverParents(runEpoch, confirmation = false) {
        const revision = ++discoveryRevision;
        const { parents, blocked } = await scanParents();
        if (!alive(runEpoch)) return [];
        if (revision > appliedDiscovery) {
            appliedDiscovery = revision;
            appliedProof = Math.max(appliedProof, revision);
            knownParents = new Map(parents.map(binding => [bindingKey(binding), binding]));
            for (const [key, failed] of invalidParents) if (failed.revision <= revision) invalidParents.delete(key);
            unavailableWorkspaces = new Set(blocked);
            for (const failed of invalidParents.values()) unavailableWorkspaces.add(failed.localSessionId);
            const invalid = [...states.values()].map(state => state.binding)
                .filter(binding => !knownParents.has(bindingKey(parentBinding(binding))));
            await pruneStates([], invalid, confirmation);
        }
        return parents.filter(binding => knownParents.has(bindingKey(binding)) && !invalidParents.has(bindingKey(binding)));
    }

    async function confirmParents(bindings, runEpoch) {
        const targets = [...new Map(bindings.map(binding => {
            const parent = parentBinding(binding);
            return [snapshotBindingIdentity(parent), parent];
        })).values()];
        const revision = ++discoveryRevision;
        const { parents, identities } = await scanParents(targets);
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

    function grouped(bindings) {
        const groups = new Map();
        for (const binding of bindings) {
            const key = workKey(binding);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(binding);
        }
        return [...groups.values()];
    }

    async function listChildren(binding, runEpoch) {
        try {
            const listed = await store.listAgents(binding.cliSessionId, sourceContext(binding, runEpoch));
            return Array.isArray(listed) && listed.length <= MaxAgentsPerParent
                && [...listed].every(id => protocol.normalizeAgentId(id)) ? [...new Set(listed)] : [];
        } catch { return []; }
    }

    async function sampleBindings(bindings, samples, times, runEpoch) {
        const groups = grouped(bindings), first = bindings[0];
        try {
            if (first.agentId !== undefined && typeof store.getAgentStatsBatch === 'function') {
                const ids = groups.map(group => group[0].agentId);
                const values = await store.getAgentStatsBatch(first.cliSessionId, ids, sourceContext(first, runEpoch));
                for (let index = 0; index < groups.length; index++) {
                    const binding = groups[index][0], value = values?.[index];
                    samples.set(sourceKey(binding), Array.isArray(values) && values.length === ids.length
                        && value?.threadId === binding.cliSessionId && value.agentId === binding.agentId ? value : null);
                    times.set(sourceKey(binding), now());
                }
            } else for (const group of groups) {
                if (!alive(runEpoch)) return;
                const binding = group[0], context = sourceContext(binding, runEpoch);
                samples.set(sourceKey(binding), binding.agentId === undefined
                    ? await store.getStats(binding.cliSessionId, context)
                    : await store.getAgentStats(binding.cliSessionId, binding.agentId, context));
                times.set(sourceKey(binding), now());
            }
        } catch { for (const group of groups) samples.set(sourceKey(group[0]), null); }
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
                    if (!await current(binding, runEpoch)) throw new Error('Snapshot identity changed');
                    const snapshot = protocol.makeSnapshot(binding, stats,
                        { publisherId, revision: publicationRevision + 1, now: times?.get(sourceKey(binding)) ?? time });
                    if (!snapshot) throw new Error('Snapshot statistics unavailable');
                    // Reserve before I/O: even an invalidated write may have been observed remotely.
                    publicationRevision = snapshot.revision;
                    state.publication = { snapshot, finished: new Promise(resolve => { finishPublication = resolve; }) };
                    state.snapshot = await publish(binding, snapshot, runEpoch);
                    state.generation = (state.generation || 0) + 1;
                    state.destination = path.join(binding.workspaceRoot,
                        protocol.snapshotPath(binding.bridgeSessionId, binding.agentId));
                    published.push(binding);
                } catch (error) {
                    state.snapshot = null;
                    if (state.destination && !error.preserveDestination) await removeOwn(state.destination, binding);
                } finally {
                    if (finishPublication) { state.publication = null; finishPublication(); }
                }
                })).finally(() => completed?.(binding)), runEpoch, MaxConcurrentPublications);
        return published;
    }

    function runBindings(bindings, runEpoch) {
        const waiting = new Set(), free = [];
        for (const group of grouped(bindings)) {
            const existing = sourcesInFlight.get(workKey(group[0]));
            if (existing) waiting.add(existing.done);
            else free.push(...group);
        }
        if (free.length) {
            const jobs = new Map(grouped(free).map(group => {
                const job = { remaining: group.length, finished: false };
                job.done = new Promise(resolve => { job.resolve = resolve; });
                return [workKey(group[0]), job];
            }));
            const finish = (key, job) => {
                if (job.finished) return;
                job.finished = true;
                if (sourcesInFlight.get(key) === job) sourcesInFlight.delete(key);
                job.resolve();
            };
            const completed = binding => {
                const key = workKey(binding), job = jobs.get(key);
                if (--job.remaining === 0) finish(key, job);
            };
            const work = Promise.resolve().then(async () => {
                if (!alive(runEpoch)) return;
                for (const binding of free) {
                    const key = bindingKey(binding);
                    if (!states.has(key)) states.set(key, { binding, snapshot: null });
                }
                const samples = new Map(), times = new Map();
                await sampleBindings(free, samples, times, runEpoch);
                if (!alive(runEpoch)) return;
                if (free.every(binding => !protocol.projectStats(samples.get(sourceKey(binding)))
                    && !states.get(bindingKey(binding))?.destination)) return;
                const confirmation = await confirmParents(free, runEpoch);
                const confirmedParents = confirmation.parents;
                if (!alive(runEpoch)) return;
                let confirmed = confirmedParents;
                if (free[0].agentId !== undefined) {
                    const ids = new Set(await listChildren(parentBinding(free[0]), runEpoch));
                    confirmed = free.filter(binding => ids.has(binding.agentId)
                        && confirmedParents.some(parent => bindingKey(parent) === bindingKey(parentBinding(binding))));
                }
                if (!alive(runEpoch) || confirmation.stale) return;
                confirmed = confirmed.filter(binding => {
                    const key = bindingKey(parentBinding(binding));
                    return knownParents.has(key) && !invalidParents.has(key);
                });
                const prunable = free.filter(binding => {
                    const key = bindingKey(parentBinding(binding));
                    // Do not let an older failed confirmation delete a snapshot
                    // whose exact parent a newer full discovery has recovered.
                    return confirmation.revision >= appliedDiscovery
                        || confirmedParents.some(parent => bindingKey(parent) === key)
                        || !knownParents.has(key) || invalidParents.has(key);
                });
                await pruneStates(confirmed, prunable);
                const confirmedKeys = new Set(confirmed.map(bindingKey));
                for (const binding of free) if (!confirmedKeys.has(bindingKey(binding))) completed(binding);
                await publishBatch(free.filter(binding => confirmedKeys.has(bindingKey(binding))),
                    samples, confirmedKeys, runEpoch, times, completed);
            }).finally(() => {
                for (const [key, job] of jobs) finish(key, job);
            });
            void work.catch(() => {});
            for (const [key, job] of jobs) { sourcesInFlight.set(key, job); waiting.add(job.done); }
        }
        return Promise.all([...waiting]);
    }

    async function pollParents(runEpoch) {
        const parents = await discoverParents(runEpoch);
        if (!alive(runEpoch)) return;
        const groups = grouped(parents);
        groups.sort((left, right) => Number(right[0].localSessionId === requestedLocalId)
            - Number(left[0].localSessionId === requestedLocalId));
        await limited(groups, group => runBindings(group, runEpoch), runEpoch);
        if (alive(runEpoch)) completedPoll = true;
    }

    async function pollChildren(runEpoch) {
        if (typeof store.listAgents !== 'function' || typeof store.getAgentStats !== 'function'
            && typeof store.getAgentStatsBatch !== 'function') return;
        const parents = await discoverParents(runEpoch);
        if (!alive(runEpoch)) return;
        let children = 0;
        await limited(grouped(parents), async group => {
            const ids = await listChildren(group[0], runEpoch);
            if (!alive(runEpoch) || children + ids.length * group.length > MaxChildBindings) return;
            children += ids.length * group.length;
            const bindings = ids.flatMap(agentId => group.map(binding => ({ ...binding, agentId })));
            const owned = [...states.values()].map(state => state.binding).filter(binding => binding.agentId !== undefined
                && group.some(parent => bindingKey(parent) === bindingKey(parentBinding(binding))));
            await pruneStates(bindings, owned);
            const batchSize = typeof store.getAgentStatsBatch === 'function' ? MaxAgentBatch : 1;
            for (let index = 0; alive(runEpoch) && index < ids.length; index += batchSize) {
                const selected = new Set(ids.slice(index, index + batchSize));
                await runBindings(bindings.filter(binding => selected.has(binding.agentId)), runEpoch);
            }
        }, runEpoch);
    }

    async function pollRequested(child, runEpoch, request) {
        const selected = () => alive(runEpoch) && (child ? requestedChild : requestedParent) === request;
        if (!request || child && typeof store.listAgents !== 'function') return;
        const parents = (await discoverParents(runEpoch)).filter(binding => binding.localSessionId === request.localSessionId);
        if (!selected()) return;
        if (!child) return runBindings(parents, runEpoch);
        for (const group of grouped(parents)) {
            if (!selected()) return;
            await runBindings(group.map(binding => ({ ...binding, agentId: request.agentId })), runEpoch);
        }
    }

    function queueLane(name, work, interrupted) {
        if (stopped) return Promise.resolve();
        if (!lanes.has(name)) {
            const runEpoch = epoch;
            const task = Promise.race([Promise.resolve().then(() => work(runEpoch)), cancelled,
                ...(interrupted ? [interrupted] : [])]).catch(() => {})
                .finally(() => { if (lanes.get(name) === task) lanes.delete(name); });
            lanes.set(name, task);
        }
        return lanes.get(name);
    }

    function queueRequested(child) {
        const request = child ? requestedChild : requestedParent;
        return request ? queueLane(child ? 'requested-child' : 'requested-parent',
            runEpoch => pollRequested(child, runEpoch, request), request.cancelled) : Promise.resolve();
    }

    function queuePoll() {
        const priority = [queueRequested(false), queueRequested(true)];
        return Promise.all([...priority, queueLane('parents', pollParents), queueLane('children', pollChildren)]);
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

    async function readLocal(localSessionId, { agentId, waitForPoll = true } = {}) {
        if (!isLocalId(localSessionId)) return null;
        if (agentId !== undefined && !protocol.normalizeAgentId(agentId)) return null;
        if (stopped) return unavailable(localSessionId, agentId);
        if (!waitForPoll) {
            const child = agentId !== undefined, previous = child ? requestedChild : requestedParent;
            const request = selectRequest(child, localSessionId.toLowerCase(), agentId);
            if (request !== previous) void queueRequested(child);
        }
        if (waitForPoll) {
            if (agentId === undefined) await queueLane('parents', pollParents);
            else {
                selectRequest(true, localSessionId.toLowerCase(), agentId);
                await queueRequested(true);
            }
        }
        if (stopped) return unavailable(localSessionId, agentId);
        const local = [...states.values()].filter(state => state.binding.localSessionId === localSessionId.toLowerCase());
        const bound = local.filter(state => state.binding.agentId === agentId);
        if (!bound.length) return !completedPoll || unavailableWorkspaces.has(localSessionId.toLowerCase())
            || [...knownParents.values()].some(binding => binding.localSessionId === localSessionId.toLowerCase())
            || agentId !== undefined && local.length ? unavailable(localSessionId, agentId) : null;
        const state = bound.find(candidate => candidate.snapshot);
        if (!state) return unavailable(localSessionId, agentId);
        const runEpoch = epoch, key = bindingKey(state.binding);
        const active = () => !stopped && epoch === runEpoch && states.get(key) === state && state.snapshot;
        for (let attempt = 0; attempt < 3; attempt++) {
            const snapshot = state.snapshot;
            try {
                if (!active() || !await current(state.binding, runEpoch)) throw new Error('Snapshot identity changed');
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
                if (!await current(state.binding, runEpoch) || !active()) throw new Error('Snapshot identity changed');
                const latest = state.snapshot;
                const encoded = JSON.stringify(existing?.snapshot);
                let sample;
                if (existing && encoded === JSON.stringify(latest)) sample = latest;
                else if (existing && encoded === JSON.stringify(snapshot)
                    && snapshot.stats.status === 'ok' && latest.stats.status === 'ok') sample = snapshot;
                else throw new Error('Published snapshot changed');
                const parsed = protocol.parseSnapshot(JSON.stringify(sample), { bridgeSessionId: state.binding.bridgeSessionId,
                    organizationId: state.binding.organizationId, agentId, now: now() });
                if (!parsed.ok) throw new Error('Published snapshot expired');
                return { ...sample.stats, threadId: localSessionId, snapshotGeneratedAt: sample.generatedAt,
                    snapshotRevision: sample.revision, snapshotPublisherId: sample.publisherId,
                    ...(agentId !== undefined ? { agentId } : {}) };
            } catch (error) {
                // Atomic replacement can cross lstat/open/read. Retry only this file-identity race;
                // each attempt must still match a committed sample and recheck the binding.
                if (error.code === 'SNAPSHOT_DESTINATION_CHANGED' && attempt < 2 && active()) continue;
                // File cleanup belongs to serialized poll/stop paths, never an older read.
                if (state.snapshot === snapshot) state.snapshot = null;
                return unavailable(localSessionId, agentId);
            }
        }
    }

    function stop() {
        if (stopPending) return stopPending;
        stopped = true; epoch++;
        clearInterval(timer);
        cancelWaits();
        stopPending = (async () => {
            await Promise.allSettled([...targetWrites.values()]);
            for (const [file, binding] of ownFiles) await removeOwn(file, binding);
            states.clear(); ownFiles.clear();
        })();
        return stopPending;
    }
    return { start, readLocal, stop };
}
module.exports = { createSnapshotPublisher };
