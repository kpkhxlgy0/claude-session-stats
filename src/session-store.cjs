'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createSessionHistory } = require('./session-history.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SessionPattern = /^([0-9a-f-]{36})\.jsonl$/i;
const MaxSessions = 32;
const MaxIndexEntries = 8192;
const MaxDirectories = 2048;
const MaxFilenames = 50000;
const IndexRefreshMs = 15000;
const ChunkBytes = 64 * 1024;
const MaxLineBytes = 8 * 1024 * 1024;
const GuardBytes = 256;
const EmptyStats = Object.freeze({
    turns: 0,
    steps: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheHit: null,
    tps: null,
    usageComplete: false,
});

function createSessionStore({ claudeHome, createMetrics } = {})
{
    const makeMetrics = createMetrics || ((sessionId) => require('./metrics.cjs').createMetrics({ sessionId }));
    const roots = typeof claudeHome === 'string' && claudeHome.length
        ? [path.join(claudeHome, 'projects')]
        : [];
    const sessions = new Map();
    let index = new Map();
    let indexAt = -Infinity;
    let indexPending;
    let disposed = false;

    function result(threadId, status, entry)
    {
        const stats = { ...EmptyStats };
        const snapshot = entry && entry.metrics.snapshot();
        for (const key of Object.keys(stats))
        {
            const value = snapshot && snapshot[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0
                || typeof value === 'boolean' || value === null)
            {
                stats[key] = value;
            }
        }
        return { ...stats, status, threadId };
    }

    function reset(entry)
    {
        entry.metrics = makeMetrics(entry.id);
        entry.history = createSessionHistory(entry.id);
        entry.historyUuids = new Set();
        entry.historyIncomplete = false;
        entry.corrupt = false;
        entry.identity = null;
        rewind(entry);
    }

    function rewind(entry)
    {
        entry.offset = 0;
        entry.pending = Buffer.alloc(0);
        entry.skippingLine = false;
        entry.head = Buffer.alloc(0);
        entry.tail = Buffer.alloc(0);
    }

    async function* entries(directory)
    {
        try
        {
            const handle = await fs.opendir(directory);
            yield* handle;
        }
        catch (error)
        {
            if (error.code === 'ENOENT') return;
            throw error;
        }
    }

    function sessionId(name)
    {
        const match = SessionPattern.exec(name);
        return match && UuidPattern.test(match[1]) ? match[1].toLowerCase() : null;
    }

    async function refreshIndex()
    {
        if (indexPending) return indexPending;
        const now = Date.now();
        if (now >= indexAt && now - indexAt < IndexRefreshMs) return;
        indexPending = (async () =>
        {
            const found = new Map();
            const directories = roots.map(directory => ({ directory, depth: 0 })).reverse();
            let directoryCount = 0;
            let filenameCount = 0;
            while (directories.length && directoryCount < MaxDirectories && filenameCount < MaxFilenames && !disposed)
            {
                const { directory, depth } = directories.pop();
                directoryCount++;
                const subdirectories = [];
                for await (const child of entries(directory))
                {
                    filenameCount++;
                    if (child.isDirectory() && depth < 1)
                    {
                        if (directoryCount + directories.length + subdirectories.length >= MaxDirectories)
                            throw new Error('Session index directory limit reached');
                        subdirectories.push({ directory: path.join(directory, child.name), depth: depth + 1 });
                    }
                    else if (child.isFile())
                    {
                        const id = sessionId(child.name);
                        if (id)
                        {
                            if (!found.has(id) && found.size >= MaxIndexEntries)
                                throw new Error('Session index entry limit reached');
                            found.set(id, found.has(id) ? null : path.join(directory, child.name));
                        }
                    }
                    if (filenameCount >= MaxFilenames) throw new Error('Session index file limit reached');
                    if (disposed) break;
                }
                subdirectories.sort((a, b) => a.directory.localeCompare(b.directory));
                directories.push(...subdirectories);
            }
            if (!disposed)
            {
                index = found;
                indexAt = Date.now();
            }
        })();
        try
        {
            await indexPending;
        }
        finally
        {
            indexPending = null;
        }
    }

    async function locate(threadId)
    {
        await refreshIndex();
        return index.get(threadId) || null;
    }

    function consume(entry, chunk, trackHistory)
    {
        let start = 0;
        while (start < chunk.length)
        {
            const newline = chunk.indexOf(10, start);
            const part = chunk.subarray(start, newline === -1 ? chunk.length : newline);
            if (!entry.skippingLine)
            {
                if (entry.pending.length + part.length > MaxLineBytes)
                {
                    entry.pending = Buffer.alloc(0);
                    entry.skippingLine = true;
                    entry.corrupt = true;
                }
                else if (newline === -1)
                {
                    entry.pending = Buffer.concat([entry.pending, part]);
                }
                else
                {
                    const line = entry.pending.length ? Buffer.concat([entry.pending, part]) : part;
                    entry.pending = Buffer.alloc(0);
                    let record;
                    try
                    {
                        record = JSON.parse(line.toString('utf8'));
                    }
                    catch
                    {
                        record = undefined;
                        entry.corrupt = true;
                    }
                    if (record !== undefined)
                    {
                        if (trackHistory) entry.history.ingest(record);
                        entry.metrics.ingest(entry.historyUuids.has(record && record.uuid)
                            ? { ...record, sessionId: entry.id } : record);
                    }
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

    async function readContents(entry, handle, size, trackHistory)
    {
        const buffer = Buffer.alloc(ChunkBytes);
        let chunks = 0;
        while (entry.offset < size && !disposed)
        {
            const length = Math.min(buffer.length, size - entry.offset);
            const { bytesRead } = await handle.read(buffer, 0, length, entry.offset);
            if (!bytesRead) break;
            const chunk = buffer.subarray(0, bytesRead);
            if (entry.head.length < GuardBytes)
            {
                entry.head = Buffer.concat([entry.head, chunk]).subarray(0, GuardBytes);
            }
            entry.tail = Buffer.from(Buffer.concat([entry.tail, chunk]).subarray(-GuardBytes));
            entry.offset += bytesRead;
            consume(entry, chunk, trackHistory);
            if (++chunks % 8 === 0) await new Promise(setImmediate);
        }
    }

    async function read(entry)
    {
        const handle = await fs.open(entry.path, 'r');
        try
        {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('Invalid session file');
            const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
            if (entry.identity !== null && (entry.identity !== identity || stat.size < entry.offset
                || !await matchesGuard(handle, entry.head, 0)
                || !await matchesGuard(handle, entry.tail, entry.offset - entry.tail.length)))
            {
                reset(entry);
            }
            entry.identity = identity;
            await readContents(entry, handle, stat.size, true);
            const history = entry.history.resolve();
            entry.historyIncomplete = history.incomplete;
            if (entry.historyUuids.size !== history.allowed.size
                || [...history.allowed].some(uuid => !entry.historyUuids.has(uuid)))
            {
                entry.historyUuids = history.allowed;
                entry.metrics = makeMetrics(entry.id);
                rewind(entry);
                await readContents(entry, handle, stat.size, false);
            }
        }
        finally
        {
            await handle.close();
        }
    }

    async function poll(entry)
    {
        const located = await locate(entry.id);
        if (entry.path !== located)
        {
            reset(entry);
            entry.path = located;
        }
        if (!entry.path) return result(entry.id, 'not-found');
        try
        {
            await read(entry);
        }
        catch (error)
        {
            if (error.code !== 'ENOENT') throw error;
            reset(entry);
            index.delete(entry.id);
            entry.path = await locate(entry.id);
            if (!entry.path) return result(entry.id, 'not-found');
            await read(entry);
        }
        if (entry.historyIncomplete) return result(entry.id, 'incomplete');
        return result(entry.id, entry.corrupt ? 'incomplete' : 'ok', entry);
    }

    async function getStats(rawThreadId)
    {
        const threadId = typeof rawThreadId === 'string' && UuidPattern.test(rawThreadId)
            ? rawThreadId.toLowerCase() : null;
        if (disposed || !threadId || !roots.length) return result(threadId, 'unavailable');
        let entry = sessions.get(threadId);
        try
        {
            if (!entry)
            {
                if (sessions.size >= MaxSessions)
                {
                    const idle = [...sessions].find(([, value]) => !value.inFlight);
                    if (!idle) return result(threadId, 'unavailable');
                    sessions.delete(idle[0]);
                }
                entry = { id: threadId, path: null };
                reset(entry);
            }
            sessions.delete(threadId);
            sessions.set(threadId, entry);
            if (entry.inFlight) return entry.inFlight;
            entry.inFlight = poll(entry).then(stats => disposed ? result(threadId, 'unavailable') : stats)
                .catch(() => result(threadId, 'unavailable'))
                .finally(() => { entry.inFlight = null; });
            return entry.inFlight;
        }
        catch
        {
            return result(threadId, 'unavailable');
        }
    }

    function dispose()
    {
        disposed = true;
        sessions.clear();
        index.clear();
    }

    return { getStats, dispose };
}

module.exports = { createSessionStore };
