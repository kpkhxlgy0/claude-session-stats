'use strict';
const nativeFs = require('node:fs/promises');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ChunkBytes = 64 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
function identity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function version(info) { return `${identity(info)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`; }
function samePath(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function createSessionSourceResolver({ fs = nativeFs, maxBytes = 192 * 1024 * 1024,
    maxCandidates = 8, maxCacheEntries = 32 } = {}) {
    const cache = new Map();

    async function safeDirectory(directory) {
        if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0'))
            throw new Error('Invalid source workspace');
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()
            || !samePath(await fs.realpath(directory), path.resolve(directory))) throw new Error('Unsafe source workspace');
        return identity(info);
    }

    async function safeFile(file) {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0
            || !samePath(await fs.realpath(file), path.resolve(file))) throw new Error('Unsafe session source');
        return info;
    }

    async function confirm(proof, context) {
        try {
            if (await context.verify() !== true || await safeDirectory(context.workspaceRoot) !== proof.workspaceIdentity)
                return false;
            for (const [file, stamp] of proof.versions)
                if (version(await safeFile(file)) !== stamp) return false;
            return await safeDirectory(context.workspaceRoot) === proof.workspaceIdentity;
        } catch { return false; }
    }

    async function build(sessionId, files, context, workspaceIdentity) {
        const sources = [], handles = [];
        let budget = 0;
        async function read(handle, buffer, length, position) {
            const { bytesRead } = await handle.read(buffer, 0, length, position);
            if ((budget += bytesRead) > maxBytes) throw new Error('Session source read limit');
            if (bytesRead !== length) throw new Error('Session source changed');
            return buffer.subarray(0, bytesRead);
        }
        try {
            for (const file of files) {
                const before = await safeFile(file);
                if (before.size > maxBytes) throw new Error('Session source size limit');
                const handle = await fs.open(file, 'r');
                handles.push(handle);
                const opened = await handle.stat();
                if (!opened.isFile() || opened.nlink !== 1 || version(opened) !== version(before))
                    throw new Error('Session source changed');
                sources.push({ file, handle, size: before.size, stamp: version(before) });
            }
            if (sources.reduce((sum, source) => sum + source.size, 0) > maxBytes)
                throw new Error('Session source size limit');
            sources.sort((a, b) => b.size - a.size);
            const longest = sources[0];
            // Equal maxima offer no strict extension and remain ambiguous.
            if (longest.size === sources[1].size) return null;
            const left = Buffer.alloc(ChunkBytes), right = Buffer.alloc(ChunkBytes);
            for (const source of sources.slice(1)) {
                const end = Buffer.alloc(1);
                if ((await read(source.handle, end, 1, source.size - 1))[0] !== 10)
                    throw new Error('Incomplete source prefix');
                for (let offset = 0; offset < source.size; offset += ChunkBytes) {
                    const length = Math.min(ChunkBytes, source.size - offset);
                    const expected = await read(source.handle, left, length, offset);
                    const actual = await read(longest.handle, right, length, offset);
                    if (!expected.equals(actual)) throw new Error('Divergent session sources');
                }
            }
            let matched = false, pending = Buffer.alloc(0);
            const buffer = Buffer.alloc(ChunkBytes);
            for (let offset = 0; offset < longest.size && !matched; offset += ChunkBytes) {
                const chunk = await read(longest.handle, buffer, Math.min(ChunkBytes, longest.size - offset), offset);
                let start = 0;
                while (start < chunk.length) {
                    const newline = chunk.indexOf(10, start);
                    const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
                    if (pending.length + part.length > MaxLineBytes) throw new Error('Session source line limit');
                    if (newline === -1) { pending = Buffer.concat([pending, part]); break; }
                    const line = pending.length ? Buffer.concat([pending, part]) : part;
                    pending = Buffer.alloc(0);
                    const row = JSON.parse(line.toString('utf8'));
                    if (row?.type === 'relocated' && row.sessionId === sessionId
                        && typeof row.relocatedCwd === 'string' && path.isAbsolute(row.relocatedCwd)) {
                        if (samePath(path.resolve(row.relocatedCwd), context.workspaceRoot)) { matched = true; break; }
                    }
                    start = newline + 1;
                }
            }
            if (!matched) return null;
            const proof = { path: longest.file, workspaceIdentity,
                versions: new Map(sources.map(source => [source.file, source.stamp])) };
            for (const source of sources)
                if (version(await source.handle.stat()) !== source.stamp) return null;
            return await confirm(proof, context) ? proof : null;
        } finally { await Promise.all(handles.map(handle => handle.close())); }
    }

    return async function resolveSessionSource(sessionId, candidates, context) {
        if (!UUID.test(sessionId || '') || !Array.isArray(candidates) || candidates.length < 2
            || candidates.length > maxCandidates || !context || typeof context.verify !== 'function'
            || typeof context.workspaceRoot !== 'string' || !path.isAbsolute(context.workspaceRoot)) return null;
        const files = [...new Set(candidates)].sort();
        if (files.length !== candidates.length || files.some(file => typeof file !== 'string'
            || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== `${sessionId.toLowerCase()}.jsonl`)) return null;
        const key = JSON.stringify([sessionId.toLowerCase(), context.workspaceRoot, files]);
        try {
            if (await context.verify() !== true) return null;
            const workspaceIdentity = await safeDirectory(context.workspaceRoot);
            let proof = cache.get(key);
            if (proof && !await confirm(proof, context)) { cache.delete(key); proof = null; }
            if (!proof) proof = await build(sessionId.toLowerCase(), files, context, workspaceIdentity);
            if (!proof) return null;
            cache.delete(key);
            cache.set(key, proof);
            while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
            // Only scalar file versions and the selected path survive a comparison.
            return { path: proof.path, verify: () => confirm(proof, context) };
        } catch { cache.delete(key); return null; }
    };
}

module.exports = { createSessionSourceResolver };
