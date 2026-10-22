'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLocalId(value) {
    return typeof value === 'string' && value.startsWith('local_') && UUID.test(value.slice(6));
}

async function resolveSession(claudeData, sessionId) {
    if (!isLocalId(sessionId) || typeof claudeData !== 'string' || !claudeData) return null;
    const root = path.join(claudeData, 'claude-code-sessions');
    let found = null;
    let matches = 0;
    try {
        const directories = [{ directory: root, depth: 0 }];
        for (let index = 0; index < directories.length; index++) {
            const { directory, depth } = directories[index];
            if (depth < 2) {
                const children = await fs.readdir(directory, { withFileTypes: true });
                for (const child of children) {
                    if (!child.isDirectory()) continue;
                    directories.push({ directory: path.join(directory, child.name), depth: depth + 1 });
                    if (directories.length > 512) return null;
                }
            }
            if (depth === 0) continue;
            const file = path.join(directory, `${sessionId}.json`);
            let handle;
            try {
                const info = await fs.lstat(file);
                if (!info.isFile() || info.isSymbolicLink()) continue;
                if (++matches > 1 || info.size > 2 * 1024 * 1024) return null;
                handle = await fs.open(file, 'r');
                const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                if (bytesRead > 2 * 1024 * 1024) return null;
                const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
                if (record?.sessionId !== sessionId || !UUID.test(record?.cliSessionId ?? '')) return null;
                found = record.cliSessionId.toLowerCase();
            } catch (error) {
                if (error.code !== 'ENOENT') return null;
            } finally { await handle?.close(); }
        }
    } catch { return null; }
    return matches === 1 ? found : null;
}

module.exports = { isLocalId, resolveSession };
