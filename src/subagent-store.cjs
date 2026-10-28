'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { version } = require('./fork-history.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AgentPattern = /^[A-Za-z0-9_-]{1,64}$/;
const ChunkBytes = 64 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
const GuardBytes = 256;
const MaxSessions = 256;
const MaxBatchAgents = 8;
const MaxCachedBytes = 16 * 1024 * 1024;
const MaxAgents = 128;
const MaxFilenames = 8192;
const EmptyStats = Object.freeze({ turns: 0, steps: 0, totalTokens: 0, inputTokens: 0,
    outputTokens: 0, cachedInputTokens: 0, cacheHit: null, tps: null, usageComplete: false });

function identity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function samePath(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function stale() { return Object.assign(new Error('Subagent source changed'), { code: 'ESTALE' }); }
function parentId(value) { return typeof value === 'string' && UuidPattern.test(value) ? value.toLowerCase() : null; }
function agentId(value) { return typeof value === 'string' && AgentPattern.test(value) ? value : null; }

function createSubagentStore({ claudeHome, createMetrics, locateSource })
{
    const root = typeof claudeHome === 'string' && claudeHome.length ? path.resolve(claudeHome, 'projects') : null;
    const sessions = new Map();
    let disposed = false;

    function result(id, agent, status, entry)
    {
        return { ...(entry ? entry.metrics.snapshot() : EmptyStats), threadId: id, agentId: agent, status };
    }

    async function current(context)
    {
        if (disposed || !root) throw new Error('Subagent store unavailable');
        if (!context) return;
        if (typeof context.workspaceRoot !== 'string' || !path.isAbsolute(context.workspaceRoot)
            || typeof context.verify !== 'function' || await context.verify() !== true)
            throw new Error('Subagent workspace unavailable');
        if (disposed) throw new Error('Subagent store unavailable');
    }

    function operationScope(context)
    {
        let active = true;
        const workspaceRoot = context?.workspaceRoot, verify = context?.verify;
        const resolveRelocation = context?.resolveRelocation;
        const valid = () => active && !disposed && Boolean(root) && (!context
            || context.workspaceRoot === workspaceRoot && context.verify === verify
                && context.resolveRelocation === resolveRelocation);
        // Nested source checks keep validating files and relocation evidence. The expensive
        // caller binding proof brackets this one operation instead of each nested check.
        return {
            context: context && { workspaceRoot, verify: valid,
                ...(typeof resolveRelocation === 'function' ? { resolveRelocation: async cwd => {
                    if (!valid()) return null;
                    const evidence = await resolveRelocation.call(context, cwd);
                    return valid() ? evidence : null;
                } } : {}) },
            assert() { if (!valid()) throw new Error('Subagent operation changed'); },
            close() { active = false; },
        };
    }

    async function safeDirectory(directory)
    {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()
            || !samePath(await fs.realpath(directory), path.resolve(directory)))
            throw new Error('Unsafe subagent directory');
        return identity(info);
    }

    async function safeFile(file)
    {
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1
            || !samePath(await fs.realpath(file), path.resolve(file)))
            throw new Error('Unsafe subagent file');
        return info;
    }

    async function confirm(proof)
    {
        if (proof.source.verify && await proof.source.verify() !== true) throw stale();
        await confirmFiles(proof);
    }

    async function confirmFiles(proof)
    {
        for (const [directory, stamp] of proof.directories)
            if (await safeDirectory(directory) !== stamp) throw stale();
        for (const [file, stamp] of proof.parentVersions)
            if (version(await safeFile(file)) !== stamp) throw stale();
    }

    async function locate(id, context)
    {
        const source = await locateSource(id, context);
        if (source?.incomplete) throw Object.assign(new Error('Incomplete parent source index'), { code: 'EINCOMPLETE' });
        if (!source?.path) return null;
        const parent = path.resolve(source.path);
        const relative = path.relative(root, path.dirname(parent));
        if (!path.isAbsolute(source.path) || relative === '..' || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative) || path.basename(parent).toLowerCase() !== `${id}.jsonl`)
            throw new Error('Unsafe subagent parent path');
        const directories = new Map();
        let directory = root;
        directories.set(directory, await safeDirectory(directory));
        for (const part of relative.split(path.sep).filter(Boolean)) {
            directory = path.join(directory, part);
            directories.set(directory, await safeDirectory(directory));
        }
        const parents = source.parentPaths ?? [parent];
        if (!Array.isArray(parents) || parents.length > 8) throw new Error('Unsafe subagent parent sources');
        const files = new Set([parent, ...parents]);
        if (files.size > 8) throw new Error('Unsafe subagent parent sources');
        const parentVersions = new Map();
        for (const file of files) {
            const relative = path.relative(root, file);
            if (!path.isAbsolute(file) || relative === '..' || relative.startsWith(`..${path.sep}`)
                || path.isAbsolute(relative) || path.basename(file).toLowerCase() !== `${id}.jsonl`)
                throw new Error('Unsafe subagent parent source');
            parentVersions.set(file, version(await safeFile(file)));
        }
        const proof = { source, directories, parentVersions };
        await confirm(proof);
        for (const part of [id, 'subagents']) {
            directory = path.join(directory, part);
            try { directories.set(directory, await safeDirectory(directory)); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                proof.directory = null;
                return proof;
            }
        }
        proof.directory = directory;
        return proof;
    }

    function reset(entry)
    {
        entry.metrics = createMetrics(entry.id, entry.agentId);
        entry.offset = 0;
        entry.pending = Buffer.alloc(0);
        entry.skippingLine = false;
        entry.head = Buffer.alloc(0);
        entry.tail = Buffer.alloc(0);
        entry.identity = null;
        entry.version = null;
        entry.corrupt = false;
    }

    function consume(entry, chunk)
    {
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
            if (!entry.skippingLine) {
                if (entry.pending.length + part.length > MaxLineBytes) {
                    entry.pending = Buffer.alloc(0);
                    entry.skippingLine = true;
                    entry.corrupt = true;
                }
                else if (newline === -1) entry.pending = Buffer.concat([entry.pending, part]);
                else {
                    const line = entry.pending.length ? Buffer.concat([entry.pending, part]) : part;
                    entry.pending = Buffer.alloc(0);
                    try {
                        const row = JSON.parse(line.toString('utf8'));
                        if (row && (row.type === 'user' || row.type === 'assistant')) {
                            if (row.sessionId !== entry.id || row.agentId !== entry.agentId || row.isSidechain !== true)
                                entry.corrupt = true;
                            else entry.metrics.ingest(row);
                        }
                    }
                    catch { entry.corrupt = true; }
                }
            }
            if (newline === -1) break;
            entry.skippingLine = false;
            start = newline + 1;
        }
    }

    async function matchesGuard(handle, expected, position)
    {
        if (!expected.length) return true;
        const actual = Buffer.alloc(expected.length);
        const { bytesRead } = await handle.read(actual, 0, actual.length, position);
        return bytesRead === expected.length && actual.equals(expected);
    }

    async function read(entry)
    {
        const before = await safeFile(entry.path);
        const handle = await fs.open(entry.path, 'r');
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || version(stat) !== version(before)) throw stale();
            const stamp = identity(stat);
            if (entry.identity !== null && (entry.identity !== stamp || stat.size < entry.offset
                || stat.size === entry.offset && entry.version !== version(stat)
                || !await matchesGuard(handle, entry.head, 0)
                || !await matchesGuard(handle, entry.tail, entry.offset - entry.tail.length))) reset(entry);
            entry.identity = stamp;
            const buffer = Buffer.alloc(ChunkBytes);
            let chunks = 0;
            while (entry.offset < stat.size && !disposed) {
                const length = Math.min(buffer.length, stat.size - entry.offset);
                const { bytesRead } = await handle.read(buffer, 0, length, entry.offset);
                if (!bytesRead) throw stale();
                const chunk = buffer.subarray(0, bytesRead);
                if (entry.head.length < GuardBytes)
                    entry.head = Buffer.from(Buffer.concat([entry.head, chunk]).subarray(0, GuardBytes));
                entry.tail = Buffer.from(Buffer.concat([entry.tail, chunk]).subarray(-GuardBytes));
                entry.offset += bytesRead;
                consume(entry, chunk);
                if (++chunks % 8 === 0) await new Promise(setImmediate);
            }
            if (version(await handle.stat()) !== version(stat)
                || version(await safeFile(entry.path)) !== version(stat)) throw stale();
            entry.version = version(stat);
        }
        finally { await handle.close(); }
    }

    function sample(entry, status)
    {
        return { stats: result(entry.id, entry.agentId, status, status === 'ok' ? entry : null),
            path: entry.path, version: entry.version };
    }

    async function poll(entry, file)
    {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (entry.path !== file) {
                    if (entry.path !== null) reset(entry);
                    entry.path = file;
                }
                await read(entry);
                return sample(entry, entry.corrupt ? 'incomplete' : 'ok');
            }
            catch (error) {
                reset(entry);
                if (error.code === 'ENOENT') return sample(entry, 'not-found');
                if (error.code !== 'ESTALE') return sample(entry, 'unavailable');
                if (attempt) return sample(entry, 'incomplete');
            }
        }
    }

    function acquire(id, agent, context)
    {
        const key = JSON.stringify([id, agent, context?.workspaceRoot || null]);
        let entry = sessions.get(key);
        if (!entry) {
            if (sessions.size >= MaxSessions) {
                const idle = [...sessions].find(([, candidate]) => !candidate.inFlight && !candidate.users);
                if (!idle) return null;
                sessions.delete(idle[0]);
            }
            entry = { id, agentId: agent, path: null, key, users: 0 };
            reset(entry);
        }
        sessions.delete(key); sessions.set(key, entry);
        entry.users++;
        return entry;
    }

    function discard(entry)
    {
        if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
    }

    function trimCache()
    {
        const bytes = entry => entry.pending.length + entry.head.length + entry.tail.length;
        let retained = [...sessions.values()].reduce((total, entry) => total + bytes(entry), 0);
        if (retained <= MaxCachedBytes) return;
        // Completed rows retain only metrics and guards. Drop idle partial readers first.
        for (const [key, entry] of sessions) {
            if (entry.inFlight || entry.users || !entry.pending.length) continue;
            retained -= bytes(entry);
            sessions.delete(key);
            if (retained <= MaxCachedBytes) break;
        }
    }

    async function readSample(entry, proof)
    {
        const file = path.join(proof.directory, `agent-${entry.agentId}.jsonl`);
        while (entry.inFlight) {
            const pending = await entry.inFlight;
            if (pending.path === file) return pending;
        }
        entry.inFlight = poll(entry, file).finally(() => { entry.inFlight = null; });
        return entry.inFlight;
    }

    async function getAgentStatsBatch(rawParentId, rawAgentIds, context)
    {
        if (!Array.isArray(rawAgentIds)) throw new TypeError('Subagent batch must be an array');
        if (rawAgentIds.length > MaxBatchAgents) throw new RangeError('Subagent batch exceeds eight agents');
        const id = parentId(rawParentId), agents = Array.from(rawAgentIds, agentId);
        const failed = status => agents.map(agent => result(id, agent, id && agent ? status : 'unavailable'));
        const unique = [...new Set(agents.filter(Boolean))];
        if (!agents.length) return [];
        if (!id || !unique.length) return failed('unavailable');
        for (let attempt = 0; attempt < 2; attempt++) {
            const held = new Map();
            let operation;
            try {
                operation = operationScope(context);
                await current(context);
                operation.assert();
                const proof = await locate(id, operation.context);
                const samples = new Map();
                for (const agent of proof?.directory ? unique : []) {
                    const entry = acquire(id, agent, operation.context);
                    if (!entry) { samples.set(agent, { stats: result(id, agent, 'unavailable') }); continue; }
                    held.set(agent, entry);
                    samples.set(agent, { ...await readSample(entry, proof) });
                }
                operation.assert();
                if (proof) await confirm(proof);
                await current(context);
                operation.assert();
                if (proof) await confirmFiles(proof);
                if (!proof?.directory) { operation.assert(); return failed('not-found'); }
                for (const [agent, sampled] of samples) {
                    if (!sampled.version) continue;
                    try {
                        if (version(await safeFile(sampled.path)) !== sampled.version) throw stale();
                    }
                    catch {
                        discard(held.get(agent));
                        sampled.stats = result(id, agent, 'unavailable');
                    }
                }
                operation.assert();
                return agents.map(agent => agent ? samples.get(agent).stats : result(id, agent, 'unavailable'));
            }
            catch (error) {
                for (const entry of held.values()) discard(entry);
                if (error.code === 'ESTALE' && !attempt) continue;
                return failed(error.code === 'ESTALE' || error.code === 'EINCOMPLETE' ? 'incomplete'
                    : error.code === 'ENOENT' ? 'not-found' : 'unavailable');
            }
            finally {
                operation?.close();
                for (const entry of held.values()) entry.users--;
                trimCache();
            }
        }
    }

    async function getAgentStats(rawParentId, rawAgentId, context)
    {
        return (await getAgentStatsBatch(rawParentId, [rawAgentId], context))[0];
    }

    async function listAgents(rawParentId, context)
    {
        const id = parentId(rawParentId);
        if (!id) throw new Error('Invalid subagent parent identity');
        let operation;
        try {
            operation = operationScope(context);
            await current(context);
            operation.assert();
            const proof = await locate(id, operation.context);
            const found = [];
            let before;
            if (proof?.directory) {
                before = version(await fs.lstat(proof.directory));
                const handle = await fs.opendir(proof.directory);
                let filenames = 0;
                for await (const child of handle) {
                    if (++filenames > MaxFilenames) throw new Error('Subagent filename limit reached');
                    if (!child.name.startsWith('agent-') || !child.name.endsWith('.jsonl')) continue;
                    const agent = agentId(child.name.slice(6, -6));
                    if (!agent) throw new Error('Unsafe subagent filename');
                    await safeFile(path.join(proof.directory, child.name));
                    if (found.length >= MaxAgents) throw new Error('Subagent index entry limit reached');
                    found.push(agent);
                }
            }
            operation.assert();
            if (proof) await confirm(proof);
            await current(context);
            operation.assert();
            if (proof) await confirmFiles(proof);
            if (proof?.directory && version(await fs.lstat(proof.directory)) !== before) throw stale();
            operation.assert();
            return found.sort();
        }
        finally { operation?.close(); }
    }

    function dispose() { disposed = true; sessions.clear(); }
    return { getAgentStats, getAgentStatsBatch, listAgents, dispose };
}

module.exports = { createSubagentStore };
