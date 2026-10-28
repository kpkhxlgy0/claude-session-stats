'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { version } = require('./fork-history.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AgentPattern = /^[A-Za-z0-9_-]{1,64}$/;
const ChunkBytes = 64 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
const GuardBytes = 256;
const MaxSessions = 32;
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

    async function confirm(proof, context)
    {
        await current(context);
        if (proof.source.verify && await proof.source.verify() !== true) throw stale();
        for (const [directory, stamp] of proof.directories)
            if (await safeDirectory(directory) !== stamp) throw stale();
        if (version(await safeFile(proof.source.path)) !== proof.parentVersion) throw stale();
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
        const parentVersion = version(await safeFile(parent));
        const proof = { source, directories, parentVersion };
        await confirm(proof, context);
        for (const part of [id, 'subagents']) {
            directory = path.join(directory, part);
            try { directories.set(directory, await safeDirectory(directory)); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await confirm(proof, context);
                return null;
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
        entry.proof = null;
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

    async function read(entry, proof)
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
                    entry.head = Buffer.concat([entry.head, chunk]).subarray(0, GuardBytes);
                entry.tail = Buffer.from(Buffer.concat([entry.tail, chunk]).subarray(-GuardBytes));
                entry.offset += bytesRead;
                consume(entry, chunk);
                if (++chunks % 8 === 0) await new Promise(setImmediate);
            }
            if (version(await handle.stat()) !== version(stat)
                || version(await safeFile(entry.path)) !== version(stat)) throw stale();
            await confirm(proof, entry.context);
            entry.version = version(stat);
            entry.proof = proof;
        }
        finally { await handle.close(); }
    }

    async function poll(entry)
    {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const proof = await locate(entry.id, entry.context);
                const file = proof ? path.join(proof.directory, `agent-${entry.agentId}.jsonl`) : null;
                if (entry.path !== file) { reset(entry); entry.path = file; }
                if (!file) return result(entry.id, entry.agentId, 'not-found');
                await read(entry, proof);
                return result(entry.id, entry.agentId, entry.corrupt ? 'incomplete' : 'ok',
                    entry.corrupt ? null : entry);
            }
            catch (error) {
                reset(entry);
                if (error.code === 'ENOENT') return result(entry.id, entry.agentId, 'not-found');
                if (error.code === 'EINCOMPLETE') return result(entry.id, entry.agentId, 'incomplete');
                if (error.code !== 'ESTALE') throw error;
                if (attempt) return result(entry.id, entry.agentId, 'incomplete');
            }
        }
    }

    async function getAgentStats(rawParentId, rawAgentId, context)
    {
        const id = parentId(rawParentId), agent = agentId(rawAgentId);
        if (!id || !agent) return result(id, agent, 'unavailable');
        try {
            await current(context);
            const key = JSON.stringify([id, agent, context?.workspaceRoot || null]);
            let entry = sessions.get(key);
            if (!entry) {
                if (sessions.size >= MaxSessions) {
                    const idle = [...sessions].find(([, candidate]) => !candidate.inFlight);
                    if (!idle) return result(id, agent, 'unavailable');
                    sessions.delete(idle[0]);
                }
                entry = { id, agentId: agent, path: null };
                reset(entry);
            }
            sessions.delete(key); sessions.set(key, entry);
            if (!entry.inFlight) {
                entry.context = context;
                entry.inFlight = poll(entry).catch(() => result(id, agent, 'unavailable'))
                    .then(stats => ({ stats, path: entry.path, version: entry.version, proof: entry.proof }))
                    .finally(() => { entry.inFlight = null; });
            }
            const sample = await entry.inFlight;
            if (sample.stats.status === 'ok') {
                await confirm(sample.proof, context);
                if (version(await safeFile(sample.path)) !== sample.version) throw stale();
            }
            else await current(context);
            return sample.stats;
        }
        catch { return result(id, agent, 'unavailable'); }
    }

    async function listAgents(rawParentId, context)
    {
        const id = parentId(rawParentId);
        if (!id) throw new Error('Invalid subagent parent identity');
        await current(context);
        const proof = await locate(id, context);
        const found = [];
        if (proof) {
            const before = version(await fs.lstat(proof.directory));
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
            await confirm(proof, context);
            if (version(await fs.lstat(proof.directory)) !== before) throw stale();
        }
        else await current(context);
        return found.sort();
    }

    function dispose() { disposed = true; sessions.clear(); }
    return { getAgentStats, listAgents, dispose };
}

module.exports = { createSubagentStore };
