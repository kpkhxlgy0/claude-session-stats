'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createMetrics } = require('./metrics.cjs');
const { createSessionHistory } = require('./session-history.cjs');

const UuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MaxSources = 32;
const MaxNodes = 65536;
const MaxLineBytes = 8 * 1024 * 1024;
const MaxReadBytes = 256 * 1024 * 1024;
const ChunkBytes = 64 * 1024;

function version(stat)
{
    return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function identifier(value)
{
    return typeof value === 'string' && value.length && value.length <= 128 ? value : null;
}

function canonical(value)
{
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function digest(value)
{
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// Retain only identities, hashes and the fields used by metrics; never cache chat text.
function project(row, order)
{
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const message = row.message && typeof row.message === 'object' && !Array.isArray(row.message) ? row.message : null;
    const flags = Object.fromEntries(['isMeta', 'isSidechain', 'isCompactSummary', 'isSynthetic', 'isApiErrorMessage']
        .map(key => [key, Boolean(row[key])]));
    const proof = digest({ type: row.type, promptId: row.promptId, requestId: row.requestId, ...flags, message });
    let content;
    if (typeof message?.content === 'string') content = message.content.trim() ? 'input' : '';
    else if (Array.isArray(message?.content)) content = message.content.map(block =>
        block && typeof block === 'object' && !Array.isArray(block)
            ? { type: identifier(block.type), tool_use_id: identifier(block.tool_use_id),
                text: typeof block.text === 'string' && block.text.trim() ? 'input' : '' } : null);
    const usage = message?.usage && typeof message.usage === 'object'
        ? Object.fromEntries(['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
            .map(key => [key, typeof message.usage[key] === 'number' ? message.usage[key] : null])) : null;
    const record = { type: identifier(row.type), sessionId: identifier(row.sessionId), uuid: identifier(row.uuid),
        parentUuid: row.parentUuid === null ? null : identifier(row.parentUuid) || undefined,
        timestamp: identifier(row.timestamp), promptId: identifier(row.promptId), requestId: identifier(row.requestId), ...flags,
        message: message ? { id: identifier(message.id), role: identifier(message.role),
            model: message.model === '<synthetic>' ? '<synthetic>' : 'model', usage, content } : null };
    const marked = Object.hasOwn(row, 'forkedFrom');
    const origin = marked && row.forkedFrom && typeof row.forkedFrom === 'object'
        && !Array.isArray(row.forkedFrom) && UuidPattern.test(row.forkedFrom.sessionId)
        && identifier(row.forkedFrom.messageUuid)
        ? { sessionId: row.forkedFrom.sessionId.toLowerCase(), messageUuid: row.forkedFrom.messageUuid } : null;
    const full = digest(row);
    return { record, marked, origin, proof, order,
        sourceUuids: [identifier(row.source_uuid), identifier(row.attachment?.source_uuid)].filter(Boolean),
        full, identity: full };
}

async function readProjection(file, sessionId, budget)
{
    const handle = await fs.open(file, 'r');
    try
    {
        const before = await handle.stat();
        if (!before.isFile() || (budget.bytes += before.size) > MaxReadBytes) throw new Error('Fork read limit');
        const rows = [], nodes = new Map(), history = createSessionHistory(sessionId);
        const buffer = Buffer.alloc(ChunkBytes);
        let offset = 0, pending = Buffer.alloc(0);
        while (offset < before.size)
        {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!bytesRead) throw new Error('Incomplete fork read');
            offset += bytesRead;
            let start = 0;
            while (start < bytesRead)
            {
                const newline = buffer.indexOf(10, start);
                const end = newline === -1 || newline >= bytesRead ? bytesRead : newline;
                const part = buffer.subarray(start, end);
                if (pending.length + part.length > MaxLineBytes) throw new Error('Fork line limit');
                if (end === bytesRead)
                {
                    pending = Buffer.concat([pending, part]);
                    break;
                }
                const line = pending.length ? Buffer.concat([pending, part]) : part;
                pending = Buffer.alloc(0);
                const row = JSON.parse(line.toString('utf8'));
                if (++budget.nodes > MaxNodes) throw new Error('Fork node limit');
                history.ingest(row);
                const node = project(row, rows.length);
                if (node)
                {
                    rows.push(node);
                    const uuid = node.record.uuid;
                    if (uuid)
                    {
                        if (!nodes.has(uuid)) nodes.set(uuid, node);
                        else if (nodes.get(uuid)?.identity !== node.identity) nodes.set(uuid, null);
                    }
                }
                start = end + 1;
            }
            if (offset % (ChunkBytes * 8) === 0) await new Promise(setImmediate);
        }
        const stamp = version(before);
        if (version(await handle.stat()) !== stamp || version(await fs.lstat(file)) !== stamp)
            throw new Error('Fork file changed');
        const resolved = history.resolve();
        if (resolved.incomplete) throw new Error('Incomplete relocated fork source');
        return { file, sessionId, stamp, rows, nodes, allowed: resolved.allowed };
    }
    finally { await handle.close(); }
}

function eligible(node, file)
{
    const row = node.record;
    return !row.isSidechain && (row.sessionId === file.sessionId || !row.sessionId
        || file.allowed.has(row.uuid) || file.rawOrigins?.has(node));
}

function verifyMainline(node, owner)
{
    const verified = owner.mainline || (owner.mainline = new Map());
    const chain = new Set();
    let uuid = node.record.uuid, messageOrder = node.order;
    if (!uuid) throw new Error('Missing copied message UUID');
    while (uuid !== null && !verified.has(uuid))
    {
        const ancestor = owner.nodes.get(uuid);
        const row = ancestor?.record;
        const message = row?.type === 'user' || row?.type === 'assistant';
        if (!ancestor || !eligible(ancestor, owner) || row.parentUuid === undefined || chain.has(uuid)
            || message && ancestor.order > messageOrder) throw new Error('Invalid copied mainline');
        if (message) messageOrder = ancestor.order;
        chain.add(uuid);
        uuid = row.parentUuid;
    }
    let previousOrder = uuid === null ? -1 : verified.get(uuid);
    if (previousOrder > messageOrder) throw new Error('Invalid copied message order');
    for (const key of [...chain].reverse())
    {
        const ancestor = owner.nodes.get(key);
        if (ancestor.record.type === 'user' || ancestor.record.type === 'assistant')
            previousOrder = Math.max(previousOrder, ancestor.order);
        verified.set(key, previousOrder);
    }
}

function bindingKey(binding)
{
    return JSON.stringify(binding ? [binding.incomplete, binding.parentSessionId, binding.cutoffMessageUuid] : null);
}

function createForkHistory({ sessionId, locate, resolveFork })
{
    let cached;

    async function unchanged(files, bindings = [], metadata = new Map())
    {
        for (const file of files.values())
        {
            if (await locate(file.sessionId) !== file.file || version(await fs.lstat(file.file)) !== file.stamp)
                return false;
        }
        for (const binding of bindings)
            if (typeof binding.verify !== 'function' || !await binding.verify()) return false;
        // Absence is part of the lineage proof too. Recheck ancestors before the child,
        // so source resolution cannot silently change an already checked child binding.
        for (const [id, key] of [...metadata].reverse())
            if (bindingKey(await resolveFork?.(id)) !== key) return false;
        return true;
    }

    async function build(file, currentFork, budget)
    {
        const files = new Map();
        budget.nodes = 0;
        const bindings = [];
        const metadata = new Map();
        async function load(id)
        {
            if (files.has(id)) return files.get(id);
            if (files.size >= MaxSources + 1) throw new Error('Fork source limit');
            const source = id === sessionId ? file : await locate(id);
            if (!source) throw new Error('Missing fork source');
            const projection = await readProjection(source, id, budget);
            projection.fork = id === sessionId ? currentFork : await resolveFork?.(id);
            metadata.set(id, bindingKey(projection.fork));
            projection.rawOrigins = new Map();
            files.set(id, projection);
            return projection;
        }
        const current = await load(sessionId);
        const preparing = new Set();
        async function prepare(owner)
        {
            if (owner.prepared) return;
            if (preparing.has(owner.sessionId)) throw new Error('Cyclic Desktop fork metadata');
            preparing.add(owner.sessionId);
            const binding = owner.fork;
            if (binding)
            {
                if (binding.incomplete || !UuidPattern.test(binding.parentSessionId)
                    || binding.cutoffMessageUuid !== null && !identifier(binding.cutoffMessageUuid)
                    || typeof binding.verify !== 'function') throw new Error('Invalid Desktop fork metadata');
                bindings.push(binding);
                const source = await load(binding.parentSessionId.toLowerCase());
                await prepare(source);
                const cutoff = binding.cutoffMessageUuid === null ? source.rows.length
                    : source.rows.findIndex(node => node.record.uuid === binding.cutoffMessageUuid
                        || node.sourceUuids.includes(binding.cutoffMessageUuid));
                if (cutoff < 0) throw new Error('Missing Desktop fork cutoff');
                const messages = source.rows.filter(node => node.order < cutoff
                    && (node.record.type === 'user' || node.record.type === 'assistant'));
                const copied = new Map();
                let count = 0, own = false;
                for (const node of owner.rows)
                {
                    const row = node.record;
                    if (row.type !== 'user' && row.type !== 'assistant') continue;
                    if (row.sessionId === owner.sessionId) { own = true; continue; }
                    const expected = messages[count];
                    const ancestor = !own && expected?.full === node.full ? expected : copied.get(node.full);
                    if (!ancestor) throw new Error('Desktop fork is not a copied message prefix');
                    if (!own && ancestor === expected) count++;
                    copied.set(node.full, ancestor);
                    const canonicalNode = row.uuid ? owner.nodes.get(row.uuid) : node;
                    if (!canonicalNode) throw new Error('Conflicting Desktop fork UUID');
                    const canonicalSource = ancestor.record.uuid ? source.nodes.get(ancestor.record.uuid) : ancestor;
                    if (!canonicalSource) throw new Error('Conflicting Desktop source UUID');
                    owner.rawOrigins.set(canonicalNode, { node: canonicalSource, owner: source });
                }
                if (binding.cutoffMessageUuid !== null && count !== messages.length)
                    throw new Error('Incomplete Desktop cutoff prefix');
            }
            preparing.delete(owner.sessionId);
            owner.prepared = true;
        }
        await prepare(current);
        const resolved = new Map();
        async function original(node, owner, visiting = new Set())
        {
            await prepare(owner);
            const key = `${owner.sessionId}:${node.record.uuid || `row-${node.order}`}`;
            if (!eligible(node, owner) || node.record.uuid && owner.nodes.get(node.record.uuid) !== node)
                throw new Error('Invalid fork row identity');
            const rawOrigin = owner.rawOrigins.get(node);
            if (!node.marked && !rawOrigin) return { node, scope: owner.sessionId };
            if (resolved.has(key)) return resolved.get(key);
            if (visiting.has(key)) throw new Error('Invalid fork lineage');
            visiting.add(key);
            if (rawOrigin)
            {
                verifyMainline(rawOrigin.node, rawOrigin.owner);
                const result = await original(rawOrigin.node, rawOrigin.owner, visiting);
                visiting.delete(key);
                resolved.set(key, result);
                return result;
            }
            if (!node.origin || !node.record.uuid) throw new Error('Invalid fork marker');
            const source = await load(node.origin.sessionId);
            await prepare(source);
            const ancestor = source.nodes.get(node.origin.messageUuid);
            if (!ancestor || !eligible(ancestor, source) || ancestor.proof !== node.proof)
                throw new Error('Fork row does not match source');
            const parent = node.record.parentUuid;
            if (ancestor.record.parentUuid === null)
            {
                if (parent !== null) throw new Error('Invalid fork root');
            }
            else
            {
                const predecessor = owner.nodes.get(parent);
                if (!predecessor || !eligible(predecessor, owner) || !predecessor.origin
                    || predecessor.origin.sessionId !== source.sessionId
                    || predecessor.origin.messageUuid !== ancestor.record.parentUuid
                    || predecessor.order >= node.order)
                    throw new Error('Invalid fork branch');
            }
            const result = await original(ancestor, source, visiting);
            visiting.delete(key);
            resolved.set(key, result);
            return result;
        }
        const metrics = createMetrics({ sessionId });
        const seen = new Set();
        let scope;
        const inherited = current.rows.filter(node => (node.marked
            || current.rawOrigins.has(node.record.uuid ? current.nodes.get(node.record.uuid) : node)) && eligible(node, current));
        for (const node of inherited)
        {
            // Identical replay rows share the canonical node in this file.
            const canonicalNode = node.record.uuid ? current.nodes.get(node.record.uuid) : node;
            if (!canonicalNode) throw new Error('Conflicting fork UUID');
            const source = await original(canonicalNode, current);
            const key = source.node.identity;
            if (seen.has(key)) continue;
            seen.add(key);
            if (scope !== source.scope) metrics.resetInput();
            scope = source.scope;
            metrics.ingest({ ...source.node.record, sessionId });
        }
        metrics.resetInput();
        const inheritedRows = new Set(inherited);
        for (const node of current.rows)
            if (!inheritedRows.has(node) && eligible(node, current)) metrics.ingest({ ...node.record, sessionId });
        if (!await unchanged(files, bindings, metadata)) throw new Error('Fork files changed');
        // Cache versions and the scalar only; projections expire at the end of this build.
        return { tps: metrics.snapshot().tps, bindings, metadata, bindingKey: bindingKey(currentFork),
            files: new Map([...files].map(([id, source]) => [id,
                { sessionId: id, file: source.file, stamp: source.stamp }])) };
    }

    async function resolve(file, expectedVersion, currentFork, budget = { nodes: 0, bytes: 0 })
    {
        try
        {
            if (cached && cached.bindingKey === bindingKey(currentFork)
                && cached.files.get(sessionId)?.file === file
                && await unchanged(cached.files, cached.bindings, cached.metadata))
                return { tps: cached.tps, incomplete: false,
                    currentChanged: cached.files.get(sessionId).stamp !== expectedVersion };
        }
        catch { cached = null; }
        for (let attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                cached = await build(file, currentFork, budget);
                return { tps: cached.tps, incomplete: false,
                    currentChanged: cached.files.get(sessionId).stamp !== expectedVersion };
            }
            catch { cached = null; }
        }
        return { tps: null, incomplete: true };
    }

    return { resolve };
}

module.exports = { createForkHistory, version };
