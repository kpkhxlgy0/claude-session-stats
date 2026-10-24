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

async function safeDirectory(directory) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe metadata directory');
    return info;
}

async function readRecord(file) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MaxBytes) return null;
    const handle = await fs.open(file, 'r');
    try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameFile(info, opened)) return null;
        const buffer = Buffer.alloc(MaxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MaxBytes || !sameFile(opened, await fs.lstat(file))) return null;
        return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
}

async function recordBindings(record, { localSessionId, accountId, organizationId, metadataFile }) {
    if (!record || record.sessionId !== localSessionId || !UUID.test(record.cliSessionId || '')
        || record.isArchived === true || record.transcriptUnavailable === true
        || record.remoteControlUserEnabled === false || !Array.isArray(record.bridgeSessionIds)
        || !record.bridgeSessionIds.length || record.bridgeSessionIds.length > 128) return [];
    const bridgeIds = record.bridgeSessionIds.map(normalizeBridgeId);
    if (bridgeIds.some(id => id === null)) return [];
    // Match Desktop's getWorkspaceRoot, which anchors RC read_file requests.
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

async function recheckSnapshotBinding(binding) {
    try {
        const org = path.dirname(binding.metadataFile);
        const account = path.dirname(org);
        const root = path.dirname(account);
        const directories = [path.dirname(root), root, account, org];
        const identities = await Promise.all(directories.map(safeDirectory));
        const candidates = await recordBindings(await readRecord(binding.metadataFile), {
            localSessionId: path.basename(binding.metadataFile, '.json'),
            accountId: path.basename(account), organizationId: path.basename(org), metadataFile: binding.metadataFile });
        for (let index = 0; index < directories.length; index++)
            if (!sameFile(identities[index], await safeDirectory(directories[index]))) return false;
        return candidates.some(candidate => Object.keys(candidate).every(key => candidate[key] === binding[key]));
    } catch { return false; }
}

async function discoverSnapshotBindings(claudeData) {
    if (typeof claudeData !== 'string' || !path.isAbsolute(claudeData)) return [];
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
    return found.filter(binding => localCounts.get(binding.localSessionId) === 1
        && bridgeCounts.get(binding.bridgeSessionId) === 1)
        .sort((a, b) => a.metadataFile.localeCompare(b.metadataFile) || a.bridgeSessionId.localeCompare(b.bridgeSessionId));
}
module.exports = { discoverSnapshotBindings, recheckSnapshotBinding };
