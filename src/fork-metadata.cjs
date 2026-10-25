'use strict';
const defaultFs = require('node:fs/promises');
const path = require('node:path');
const { isLocalId } = require('./session-map.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MaxBytes = 2 * 1024 * 1024;
const MaxDirectories = 512;
const MaxEntries = 20000;
const MaxRecords = 4096;

function sameFile(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function sameVersion(left, right) {
    return sameFile(left, right) && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function createDesktopForkResolver(options = {}) {
    const { claudeData, fs = defaultFs } = options || {};
    const dataRoot = typeof claudeData === 'string' && path.isAbsolute(claudeData)
        ? path.resolve(claudeData) : null;

    async function safeDirectory(directory) {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe metadata directory');
        return info;
    }

    async function readRecord(file) {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.size > MaxBytes)
            throw new Error('Unsafe metadata record');
        const handle = await fs.open(file, 'r');
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || !sameVersion(before, opened)) throw new Error('Metadata record changed');
            const buffer = Buffer.alloc(Math.min(before.size + 1, MaxBytes + 1));
            let length = 0;
            while (length < buffer.length) {
                const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
                if (!bytesRead) break;
                length += bytesRead;
            }
            const after = await fs.lstat(file);
            if (length > MaxBytes || after.isSymbolicLink() || !after.isFile()
                || !sameVersion(opened, await handle.stat()) || !sameVersion(opened, after))
                throw new Error('Metadata record changed');
            return { record: JSON.parse(buffer.subarray(0, length).toString('utf8')), info: after };
        } finally { await handle.close(); }
    }

    async function scan() {
        const records = [], directories = new Map();
        let entryCount = 0;

        async function rememberDirectory(directory) {
            if (directories.size >= MaxDirectories) throw new Error('Metadata directory limit reached');
            const info = await safeDirectory(directory);
            directories.set(directory, info);
            return info;
        }

        async function* entries(directory) {
            const before = await rememberDirectory(directory);
            const handle = await fs.opendir(directory);
            for await (const child of handle) {
                if (++entryCount > MaxEntries) throw new Error('Metadata entry limit reached');
                yield child;
            }
            if (!sameVersion(before, await safeDirectory(directory))) throw new Error('Metadata directory changed');
        }

        async function addRecord(directory, child, accountId, organizationId) {
            if (!child.name.endsWith('.json') || !isLocalId(child.name.slice(0, -5))) return;
            if (records.length >= MaxRecords) throw new Error('Metadata record limit reached');
            if (!child.isFile() || child.isSymbolicLink()) throw new Error('Unsafe metadata record');
            const file = path.join(directory, child.name);
            const { record, info } = await readRecord(file);
            const localId = child.name.slice(0, -5);
            const cliId = typeof record?.cliSessionId === 'string' && UUID.test(record.cliSessionId)
                ? record.cliSessionId.toLowerCase() : null;
            const pointer = record?.forkedFromSessionId, cutoff = record?.forkedAtMessageUuid;
            records.push({ file, info, localId: localId.toLowerCase(), cliId,
                pointer: typeof pointer === 'string' || pointer == null ? pointer : false,
                cutoff: typeof cutoff === 'string' || cutoff == null ? cutoff : false,
                accountId: accountId.toLowerCase(), organizationId: organizationId?.toLowerCase() ?? null,
                valid: record !== null && typeof record === 'object' && !Array.isArray(record)
                    && record.sessionId === localId && cliId !== null });
        }

        await rememberDirectory(dataRoot);
        const root = path.join(dataRoot, 'claude-code-sessions');
        try { await safeDirectory(root); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (!sameVersion(directories.get(dataRoot), await safeDirectory(dataRoot))) throw error;
            return { records, directories };
        }
        for await (const account of entries(root)) {
            if (!UUID.test(account.name)) continue;
            if (account.isSymbolicLink()) throw new Error('Unsafe metadata account');
            if (!account.isDirectory()) continue;
            const accountPath = path.join(root, account.name);
            for await (const org of entries(accountPath)) {
                await addRecord(accountPath, org, account.name, null);
                if (!UUID.test(org.name)) continue;
                if (org.isSymbolicLink()) throw new Error('Unsafe metadata organization');
                if (!org.isDirectory()) continue;
                const orgPath = path.join(accountPath, org.name);
                for await (const child of entries(orgPath))
                    await addRecord(orgPath, child, account.name, org.name);
            }
        }
        // Recheck records read early in the scan, including changes during another record's read.
        for (const record of records) {
            const current = await fs.lstat(record.file);
            if (!current.isFile() || current.isSymbolicLink() || !sameVersion(record.info, current))
                throw new Error('Metadata record changed');
        }
        for (const [directory, info] of directories)
            if (!sameVersion(info, await safeDirectory(directory))) throw new Error('Metadata directory changed');
        return { records, directories };
    }

    function findFork({ records, directories }, cliId) {
        const matches = records.filter(record => record.cliId === cliId);
        if (matches.length === 0) return null;
        const child = matches[0];
        if (matches.length !== 1 || !child.valid) return { incomplete: true };
        const { pointer, cutoff } = child;
        if (pointer === undefined || pointer === null)
            return cutoff === undefined || cutoff === null ? null : { incomplete: true };
        if (!isLocalId(pointer) || (cutoff !== undefined && cutoff !== null
            && (typeof cutoff !== 'string' || !UUID.test(cutoff)))) return { incomplete: true };
        const parentLocal = pointer.toLowerCase();
        if (parentLocal === child.localId) return { incomplete: true };
        const sameScope = record => record.accountId === child.accountId
            && record.organizationId === child.organizationId;
        const parents = records.filter(record => sameScope(record) && record.localId === parentLocal);
        if (parents.length !== 1 || !parents[0].valid) return { incomplete: true };
        const parent = parents[0];
        if (parent.cliId === cliId || records.filter(record => record.cliId === parent.cliId).length !== 1
            || records.filter(record => sameScope(record) && record.localId === child.localId).length !== 1)
            return { incomplete: true };
        const scopeDirectories = [];
        for (let directory = path.dirname(child.file);; directory = path.dirname(directory)) {
            scopeDirectories.push([directory, directories.get(directory)]);
            if (directory === dataRoot) break;
        }
        // Retain identities and fork semantics only, never the Desktop metadata bodies.
        return { parentSessionId: parent.cliId, cutoffMessageUuid: cutoff?.toLowerCase() ?? null,
            childFile: child.file, childInfo: child.info, parentFile: parent.file, parentInfo: parent.info,
            childLocalId: child.localId, parentLocalId: parent.localId, scopeDirectories };
    }

    async function resolveFork(cliId) {
        if (typeof cliId !== 'string' || !UUID.test(cliId) || !dataRoot) return { incomplete: true };
        const normalized = cliId.toLowerCase();
        let binding;
        try { binding = findFork(await scan(), normalized); }
        catch { return { incomplete: true }; }
        if (!binding || binding.incomplete) return binding;
        return { parentSessionId: binding.parentSessionId, cutoffMessageUuid: binding.cutoffMessageUuid,
            async verify() {
                try {
                    const current = findFork(await scan(), normalized);
                    if (!current || current.incomplete) return false;
                    return ['parentSessionId', 'cutoffMessageUuid', 'childFile', 'parentFile',
                        'childLocalId', 'parentLocalId'].every(key => current[key] === binding[key])
                        && sameFile(binding.childInfo, current.childInfo)
                        && sameFile(binding.parentInfo, current.parentInfo)
                        && binding.scopeDirectories.every(([directory, info]) => {
                            const found = current.scopeDirectories.find(([candidate]) => candidate === directory);
                            return found && sameFile(info, found[1]);
                        });
                } catch { return false; }
            } };
    }

    return { resolveFork };
}

module.exports = { createDesktopForkResolver };
