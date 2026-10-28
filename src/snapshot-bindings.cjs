'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createSnapshotProtocol } = require('./snapshot.cjs');
const { isLocalId } = require('./session-map.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MaxBytes = 2 * 1024 * 1024;
const MaxDirectories = 512;
const MaxEntries = 20000;
const MaxRecords = 4096;
const { normalizeBridgeId } = createSnapshotProtocol();

function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameVersion(left, right) {
    return sameFile(left, right) && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function safeDirectory(directory) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe metadata directory');
    return info;
}

async function readRecord(file, withVersion = false) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MaxBytes) return null;
    const handle = await fs.open(file, 'r');
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameVersion(info, opened)) return null;
        const buffer = Buffer.alloc(MaxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MaxBytes || !sameVersion(opened, await handle.stat())
            || !sameVersion(opened, await fs.lstat(file))) return null;
        const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        return withVersion ? { record, info: opened } : record;
    } finally { await handle.close(); }
}

async function recordBindings(record, { localSessionId, accountId, organizationId, metadataFile }) {
    if (!record || record.sessionId !== localSessionId || !UUID.test(record.cliSessionId || '')
        || record.isArchived === true || record.transcriptUnavailable === true
        || record.remoteControlUserEnabled === false || !Array.isArray(record.bridgeSessionIds)
        || !record.bridgeSessionIds.length || record.bridgeSessionIds.length > 128) return [];
    const bridgeIds = record.bridgeSessionIds.map(normalizeBridgeId);
    if (bridgeIds.some(id => id === null)) return [];
    // This is the declared Desktop root; a verified live CLI workspace may supersede it.
    const workspace = typeof record.worktreePath === 'string' && record.worktreePath !== ''
        ? record.worktreePath : record.cwd;
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return [];
    let workspaceRoot;
    try {
        workspaceRoot = await fs.realpath(workspace);
        if (!(await fs.stat(workspaceRoot)).isDirectory()) return [];
    } catch { return []; }
    return [...new Set(bridgeIds)].map(bridgeSessionId => ({ localSessionId: localSessionId.toLowerCase(),
        cliSessionId: record.cliSessionId.toLowerCase(), accountId: accountId.toLowerCase(),
        organizationId: organizationId.toLowerCase(), bridgeSessionId, workspaceRoot, metadataFile }));
}

async function resolveBindingWorkspace(binding, resolveWorkspace, relocationCwd) {
    if (!resolveWorkspace) return binding;
    try {
        const history = relocationCwd !== undefined;
        if (history && typeof resolveWorkspace.resolveRelocationVerified !== 'function') return null;
        const verified = history || typeof resolveWorkspace.resolveVerified === 'function';
        const resolved = history ? await resolveWorkspace.resolveRelocationVerified(binding, relocationCwd)
            : verified ? await resolveWorkspace.resolveVerified(binding) : await resolveWorkspace(binding);
        if (resolved === null) return binding;
        if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)
            || resolved.unavailable || typeof resolved.workspaceRoot !== 'string'
            || !path.isAbsolute(resolved.workspaceRoot) || typeof resolved.evidenceKey !== 'string'
            || !resolved.evidenceKey.length || resolved.evidenceKey.length > 16384) return null;
        if (history && (typeof resolved.relocationEvidence !== 'string' || !resolved.relocationEvidence.length
            || resolved.relocationEvidence.length > 16384)) return null;
        if (verified) return { ...binding, workspaceRoot: resolved.workspaceRoot, workspaceEvidence: resolved.evidenceKey,
            ...(history ? { relocationEvidence: resolved.relocationEvidence } : {}) };
        if (typeof resolved.verify !== 'function') return null;
        const root = await fs.realpath(resolved.workspaceRoot);
        const before = await safeDirectory(root);
        if (root !== resolved.workspaceRoot || !await resolved.verify()
            || !sameFile(before, await safeDirectory(root))) return null;
        return { ...binding, workspaceRoot: root, workspaceEvidence: resolved.evidenceKey };
    } catch { return null; }
}

async function inspectSnapshotBinding(binding, { resolveWorkspace, relocationCwd } = {}) {
    try {
        const org = path.dirname(binding.metadataFile);
        const account = path.dirname(org);
        const root = path.dirname(account);
        const directories = [path.dirname(root), root, account, org];
        const identities = await Promise.all(directories.map(safeDirectory));
        const read = await readRecord(binding.metadataFile, true);
        if (!read) return false;
        const candidates = await recordBindings(read.record, {
            localSessionId: path.basename(binding.metadataFile, '.json'),
            accountId: path.basename(account), organizationId: path.basename(org), metadataFile: binding.metadataFile });
        let matched = false;
        for (const base of candidates) {
            if (['accountId', 'organizationId', 'localSessionId', 'cliSessionId', 'bridgeSessionId', 'metadataFile']
                .some(key => base[key] !== binding[key])) continue;
            const resolved = await resolveBindingWorkspace(base, resolveWorkspace, relocationCwd);
            if (!resolved) continue;
            const { relocationEvidence, ...candidate } = resolved;
            if (candidate && Object.keys(candidate).length === Object.keys(binding).length
                && Object.keys(candidate).every(key => candidate[key] === binding[key]))
                matched = relocationCwd === undefined ? true : relocationEvidence;
        }
        for (let index = 0; index < directories.length; index++)
            if (!sameFile(identities[index], await safeDirectory(directories[index]))) return false;
        return sameVersion(read.info, await fs.lstat(binding.metadataFile)) ? matched : false;
    } catch { return false; }
}

async function recheckSnapshotBinding(binding, options) {
    return await inspectSnapshotBinding(binding, options) === true;
}

async function resolveSnapshotRelocation(binding, relocationCwd, { resolveWorkspace } = {}) {
    if (typeof relocationCwd !== 'string' || !path.isAbsolute(relocationCwd)) return null;
    const proof = await inspectSnapshotBinding(binding, { resolveWorkspace, relocationCwd });
    return typeof proof === 'string' ? proof : null;
}

function snapshotBindingIdentity(binding) {
    return JSON.stringify([binding.accountId, binding.organizationId, binding.localSessionId,
        binding.cliSessionId, binding.bridgeSessionId, binding.metadataFile]);
}

async function discoverSnapshotBindings(claudeData, { resolveWorkspace, onUnavailableWorkspace,
    onlyBindings, onIdentityScan } = {}) {
    if (typeof claudeData !== 'string' || !path.isAbsolute(claudeData)) return [];
    if (onlyBindings !== undefined && (!Array.isArray(onlyBindings) || onlyBindings.length > MaxRecords * 128)) return [];
    const selected = onlyBindings === undefined ? null : new Set(onlyBindings.map(snapshotBindingIdentity));
    const found = [], localCounts = new Map(), bridgeCounts = new Map();
    let directoryCount = 0, entryCount = 0, recordCount = 0;
    async function* entries(directory) {
        if (++directoryCount > MaxDirectories) throw new Error('Metadata directory limit reached');
        const before = await safeDirectory(directory);
        const handle = await fs.opendir(directory);
        for await (const child of handle) {
            if (++entryCount > MaxEntries) throw new Error('Metadata entry limit reached');
            yield child;
        }
        if (!sameFile(before, await safeDirectory(directory))) throw new Error('Metadata directory changed');
    }
    try {
        await safeDirectory(claudeData);
        const root = path.join(claudeData, 'claude-code-sessions');
        for await (const account of entries(root)) {
            if (!UUID.test(account.name) || !account.isDirectory() || account.isSymbolicLink()) continue;
            const accountPath = path.join(root, account.name);
            for await (const org of entries(accountPath)) {
                if (!UUID.test(org.name) || !org.isDirectory() || org.isSymbolicLink()) continue;
                const orgPath = path.join(accountPath, org.name);
                for await (const child of entries(orgPath)) {
                    if (!child.name.endsWith('.json') || !isLocalId(child.name.slice(0, -5))) continue;
                    if (++recordCount > MaxRecords) throw new Error('Metadata record limit reached');
                    const localSessionId = child.name.slice(0, -5);
                    const localKey = localSessionId.toLowerCase();
                    localCounts.set(localKey, (localCounts.get(localKey) || 0) + 1);
                    if (!child.isFile() || child.isSymbolicLink()) continue;
                    const metadataFile = path.join(orgPath, child.name);
                    let record;
                    try { record = await readRecord(metadataFile); }
                    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
                    for (const binding of await recordBindings(record, { localSessionId,
                        accountId: account.name, organizationId: org.name, metadataFile })) {
                        bridgeCounts.set(binding.bridgeSessionId, (bridgeCounts.get(binding.bridgeSessionId) || 0) + 1);
                        found.push(binding);
                    }
                }
            }
        }
    } catch { return []; }
    const eligible = found.filter(binding => localCounts.get(binding.localSessionId) === 1
        && bridgeCounts.get(binding.bridgeSessionId) === 1);
    onIdentityScan?.(eligible);
    const resolved = [];
    for (const binding of eligible) {
        if (selected && !selected.has(snapshotBindingIdentity(binding))) continue;
        const current = await resolveBindingWorkspace(binding, resolveWorkspace);
        if (current) resolved.push(current);
        else onUnavailableWorkspace?.(binding.localSessionId);
    }
    return resolved.sort((a, b) => a.metadataFile.localeCompare(b.metadataFile)
        || a.bridgeSessionId.localeCompare(b.bridgeSessionId));
}
module.exports = { discoverSnapshotBindings, recheckSnapshotBinding, resolveSnapshotRelocation, snapshotBindingIdentity };
