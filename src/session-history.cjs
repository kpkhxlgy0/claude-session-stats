'use strict';

const MaxHistoryEntries = 65536;
const MaxIdentifierLength = 128;

function identifier(value)
{
    return typeof value === 'string' && value.length && value.length <= MaxIdentifierLength ? value : null;
}

function createSessionHistory(sessionId)
{
    const nodes = new Map();
    const children = new Set();
    let relocated = false;
    let overflow = false;
    let dirty = true;
    let resolved;

    function ingest(row)
    {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        if (row.type === 'relocated' && row.sessionId === sessionId && !relocated)
        {
            relocated = true;
            dirty = true;
        }
        const uuid = identifier(row.uuid);
        if (!uuid) return;
        const incoming = {
            sessionId: identifier(row.sessionId),
            parentUuid: row.parentUuid === null ? null : identifier(row.parentUuid) || undefined,
            sidechain: Boolean(row.isSidechain),
            message: row.type === 'user' || row.type === 'assistant',
        };
        if (!nodes.has(uuid))
        {
            if (nodes.size >= MaxHistoryEntries)
            {
                if (!overflow) dirty = true;
                overflow = true;
                return;
            }
            nodes.set(uuid, { ...incoming, order: nodes.size });
            if (incoming.sessionId === sessionId && !incoming.sidechain) children.add(uuid);
            dirty = true;
        }
        else
        {
            if (incoming.sessionId === sessionId && !incoming.sidechain && !children.has(uuid))
            {
                children.add(uuid);
                dirty = true;
            }
            const previous = nodes.get(uuid);
            if (previous && (previous.sessionId !== incoming.sessionId || previous.parentUuid !== incoming.parentUuid
                || previous.sidechain !== incoming.sidechain || previous.message !== incoming.message))
            {
                nodes.set(uuid, null);
                dirty = true;
            }
        }
    }

    function resolve()
    {
        if (!dirty) return resolved;
        dirty = false;
        const allowed = new Set();
        resolved = { allowed, incomplete: false };
        if (!relocated) return resolved;
        if (overflow) return resolved = { allowed, incomplete: true };
        const verified = new Map();
        for (const child of children)
        {
            const chain = new Set();
            let uuid = child;
            let messageOrder = nodes.get(child)?.order ?? -1;
            while (uuid !== null && !verified.has(uuid))
            {
                const node = nodes.get(uuid);
                if (!node || !node.sessionId || node.parentUuid === undefined || node.sidechain || chain.has(uuid)
                    || node.message && node.order > messageOrder)
                {
                    return resolved = { allowed: new Set(), incomplete: true };
                }
                if (node.message) messageOrder = node.order;
                chain.add(uuid);
                uuid = node.parentUuid;
            }
            let ancestorOrder = uuid === null ? -1 : verified.get(uuid);
            if (ancestorOrder > messageOrder)
                return resolved = { allowed: new Set(), incomplete: true };
            // 缓存整条祖先链的最近消息位置，复用附件节点时也校验消息顺序。
            for (const ancestor of [...chain].reverse())
            {
                const node = nodes.get(ancestor);
                if (node.message) ancestorOrder = Math.max(ancestorOrder, node.order);
                verified.set(ancestor, ancestorOrder);
                if (node.sessionId !== sessionId) allowed.add(ancestor);
            }
        }
        return resolved;
    }

    return { ingest, resolve };
}

module.exports = { createSessionHistory };
