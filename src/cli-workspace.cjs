'use strict';
const nativeFs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile: nativeExecFile } = require('node:child_process');

function identity(info) { return `${info.dev}:${info.ino}:${info.birthtimeMs}`; }
function unchanged(left, right) {
    return identity(left) === identity(right) && left.size === right.size
        && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function contains(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function createCliWorkspaceResolver({ claudeHome, fs = nativeFs, execFile = nativeExecFile,
    platform = process.platform, hostname = os.hostname(), getProcessIdentities,
    now = Date.now, processCacheMs = 250, maxRegistryEntries = 512,
    maxRegistryBytes = 64 * 1024, maxRegistryTotalBytes = 4 * 1024 * 1024 } = {}) {
    const domain = `${platform}:${hostname.toLowerCase()}`;
    let processBatch;
    function samePath(left, right) {
        if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
        const normalizedLeft = path.resolve(left), normalizedRight = path.resolve(right);
        return platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
            : normalizedLeft === normalizedRight;
    }

    function run(command, args, maxBuffer = 256 * 1024) {
        return new Promise((resolve, reject) => execFile(command, args,
            { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer }, (error, stdout) => {
                if (error) reject(error);
                else if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > maxBuffer)
                    reject(new Error('Invalid command output'));
                else resolve(stdout);
            }));
    }

    async function nativeProcessIdentities(pids) {
        if (platform !== 'win32') return new Map();
        // Numeric PIDs only; no registry strings are interpolated into executable code.
        const script = `$rows = @(${pids.join(',')}) | ForEach-Object { $id = $_; try { `
            + `$p = [Diagnostics.Process]::GetProcessById($id); `
            + `@{pid=$id;alive=$true;procStart=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} `
            + `} catch [ArgumentException] { @{pid=$id;alive=$false} } `
            + `catch { @{pid=$id;alive=$null} } }; ConvertTo-Json -InputObject @($rows) -Compress`;
        const rows = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
        if (!Array.isArray(rows) || rows.length > pids.length) throw new Error('Invalid process identity output');
        return new Map(rows.filter(row => row && pids.includes(row.pid)).map(row => [row.pid, row]));
    }

    async function processes(pids) {
        const key = [...pids].sort((a, b) => a - b).join(',');
        const time = now();
        if (!processBatch || processBatch.key !== key || time < processBatch.time
            || time - processBatch.time >= Math.max(0, processCacheMs)) {
            const batch = { key, time, result: Promise.resolve().then(() =>
                (getProcessIdentities || nativeProcessIdentities)(pids)).catch(() => new Map()).then(result => {
                    batch.time = now();
                    return result;
                }) };
            processBatch = batch;
        }
        return processBatch.result;
    }

    async function directory(directoryPath) {
        if (typeof directoryPath !== 'string' || directoryPath.includes('\0') || !path.isAbsolute(directoryPath))
            throw new Error('Invalid workspace directory');
        const resolved = path.resolve(directoryPath);
        const before = await fs.lstat(resolved);
        if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unsafe workspace directory');
        const canonical = await fs.realpath(resolved);
        if (!samePath(canonical, resolved) || identity(before) !== identity(await fs.lstat(resolved)))
            throw new Error('Workspace directory changed or is linked');
        return { path: canonical, identity: identity(before) };
    }

    async function readRegistry(file) {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxRegistryBytes)
            throw new Error('Unsafe session registry');
        const handle = await fs.open(file, 'r');
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.nlink !== 1 || !unchanged(before, opened)) throw new Error('Registry changed');
            const buffer = Buffer.alloc(maxRegistryBytes + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead > maxRegistryBytes || !unchanged(opened, await handle.stat())
                || !unchanged(opened, await fs.lstat(file))) throw new Error('Registry changed');
            const row = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
            if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid registry');
            return { row, bytes: bytesRead };
        } finally { await handle.close(); }
    }

    function matches(row, binding) {
        return row.sessionId === binding.cliSessionId || row.hostSessionId === binding.localSessionId
            || row.bridgeSessionId === binding.bridgeSessionId;
    }

    function semantic(row, pid, binding) {
        if (row.pid !== pid || row.sessionId !== binding.cliSessionId
            || row.hostSessionId !== undefined && row.hostSessionId !== binding.localSessionId
            || row.bridgeSessionId !== undefined && row.bridgeSessionId !== binding.bridgeSessionId
            || row.accountId !== undefined && row.accountId !== binding.accountId
            || row.organizationId !== undefined && row.organizationId !== binding.organizationId
            || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || row.cwd.includes('\0'))
            throw new Error('Session registry identity conflict');
        return JSON.stringify([pid, row.sessionId, row.hostSessionId, row.bridgeSessionId,
            row.accountId, row.organizationId, row.cwd, row.procStart, row.pidDomain,
            row.startedAt, row.kind, row.entrypoint]);
    }

    async function scan(binding) {
        const home = await directory(claudeHome);
        const sessions = await directory(path.join(home.path, 'sessions'));
        const found = [], pids = [];
        let count = 0, bytes = 0;
        const handle = await fs.opendir(sessions.path);
        for await (const child of handle) {
            if (++count > maxRegistryEntries) throw new Error('Registry entry limit');
            if (!/^[1-9][0-9]{0,9}\.json$/.test(child.name)) continue;
            const pid = Number(child.name.slice(0, -5));
            if (!Number.isSafeInteger(pid) || pid > 2147483647) throw new Error('Invalid registry PID');
            pids.push(pid);
            const record = await readRegistry(path.join(sessions.path, child.name));
            if ((bytes += record.bytes) > maxRegistryTotalBytes) throw new Error('Registry byte limit');
            if (matches(record.row, binding))
                found.push({ pid, cwd: record.row.cwd, procStart: record.row.procStart,
                    hostSessionId: record.row.hostSessionId, bridgeSessionId: record.row.bridgeSessionId,
                    pidDomain: record.row.pidDomain, startedAt: record.row.startedAt,
                    semantic: semantic(record.row, pid, binding) });
        }
        if (home.identity !== (await directory(home.path)).identity
            || sessions.identity !== (await directory(sessions.path)).identity) throw new Error('Registry directory changed');
        return { found, pids, home, sessions };
    }

    async function gitValue(cwd, flag) {
        const output = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', flag]);
        const value = output.replace(/\r?\n$/, '');
        if (!value || value.includes('\n') || value.includes('\r') || value.includes('\0'))
            throw new Error('Invalid Git directory');
        return directory(value);
    }

    async function nestedGit(desktop, active) {
        if (!contains(desktop.path, active.path)) return true;
        for (let current = active.path; !samePath(current, desktop.path); current = path.dirname(current)) {
            try {
                const git = await fs.lstat(path.join(current, '.git'));
                if (git.isSymbolicLink() || !git.isFile() && !git.isDirectory())
                    throw new Error('Unsafe nested Git metadata');
                return true;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return false;
    }

    async function association(desktop, active) {
        if (!await nestedGit(desktop, active)) return ['desktop', desktop.path, desktop.identity];
        const [sourceCommon, activeCommon, sourceTop, activeTop] = await Promise.all([
            gitValue(desktop.path, '--git-common-dir'), gitValue(active.path, '--git-common-dir'),
            gitValue(desktop.path, '--show-toplevel'), gitValue(active.path, '--show-toplevel')]);
        if (!samePath(sourceCommon.path, activeCommon.path) || sourceCommon.identity !== activeCommon.identity
            || !contains(sourceTop.path, desktop.path) || !contains(activeTop.path, active.path))
            throw new Error('Unrelated Git workspace');
        const output = await run('git', ['-C', desktop.path, 'worktree', 'list', '--porcelain', '-z']);
        const registered = output.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
        if (!registered.some(value => samePath(value, sourceTop.path))
            || !registered.some(value => samePath(value, activeTop.path))) throw new Error('Unregistered Git workspace');
        return ['git', sourceCommon.path, sourceCommon.identity, sourceTop.path, sourceTop.identity,
            activeTop.path, activeTop.identity];
    }

    async function inspect(binding) {
        if (typeof claudeHome !== 'string' || !path.isAbsolute(claudeHome)) return null;
        let matched = false;
        try {
            const first = await scan(binding);
            if (!first.found.length) return null;
            matched = true;
            const desktop = await directory(binding.workspaceRoot);
            // Keeping the existing canonical Desktop root does not re-anchor access.
            if (first.found.length === 1 && samePath((await directory(first.found[0].cwd)).path, desktop.path))
                return null;
            for (const row of first.found) {
                if (row.hostSessionId !== binding.localSessionId || row.bridgeSessionId !== binding.bridgeSessionId
                    || typeof row.procStart !== 'string' || !/^[0-9]{1,32}$/.test(row.procStart)
                    || row.pidDomain !== domain || !Number.isSafeInteger(row.startedAt) || row.startedAt <= 0)
                    return { unavailable: true };
            }
            const observed = await processes(first.pids);
            const live = [];
            for (const row of first.found) {
                const processIdentity = observed instanceof Map ? observed.get(row.pid) : undefined;
                if (processIdentity?.alive === false) continue;
                if (processIdentity?.alive !== true || processIdentity.procStart !== row.procStart
                    || processIdentity.pidDomain !== undefined && processIdentity.pidDomain !== domain)
                    return { unavailable: true };
                live.push(row);
            }
            if (!live.length) return null;
            if (live.length !== 1) return { unavailable: true };
            const row = live[0];
            const active = await directory(row.cwd);
            const git = await association(desktop, active);
            const second = await scan(binding);
            const candidates = records => records.map(record => record.semantic).sort().join('\n');
            if (candidates(first.found) !== candidates(second.found)
                || first.home.identity !== second.home.identity || first.sessions.identity !== second.sessions.identity
                || desktop.identity !== (await directory(desktop.path)).identity
                || active.identity !== (await directory(active.path)).identity) return { unavailable: true };
            return { workspaceRoot: active.path, evidenceKey: JSON.stringify([
                binding.accountId, binding.organizationId, binding.localSessionId, binding.cliSessionId,
                binding.bridgeSessionId, binding.metadataFile, first.home.path, first.home.identity,
                first.sessions.identity, row.semantic, active.path, active.identity, git]) };
        } catch (error) {
            // Absence of the registry is ordinary. A missing workspace after a match is unsafe.
            if (!matched && error.code === 'ENOENT') {
                try { await fs.lstat(path.join(claudeHome, 'sessions')); }
                catch (missing) { if (missing.code === 'ENOENT') return null; }
            }
            return { unavailable: true };
        }
    }

    return async function resolveWorkspace(binding) {
        const resolved = await inspect(binding);
        if (!resolved || resolved.unavailable) return resolved;
        return { ...resolved, verify: async () => {
            const current = await inspect(binding);
            return !!current && !current.unavailable && current.evidenceKey === resolved.evidenceKey;
        } };
    };
}

module.exports = { createCliWorkspaceResolver };
