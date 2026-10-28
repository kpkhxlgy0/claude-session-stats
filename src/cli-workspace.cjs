'use strict';
const nativeFs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
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
    now = Date.now, processCacheMs = 250, gitCacheMs = 0, maxRegistryEntries = 512,
    maxRegistryBytes = 64 * 1024, maxRegistryTotalBytes = 4 * 1024 * 1024 } = {}) {
    const domain = `${platform}:${hostname.toLowerCase()}`;
    const gitTtl = Number.isFinite(gitCacheMs) ? Math.min(2000, Math.max(0, gitCacheMs)) : 0;
    const gitAssociations = new Map();
    let processBatch;
    function samePath(left, right) {
        if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
        const normalizedLeft = path.resolve(left), normalizedRight = path.resolve(right);
        return platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
            : normalizedLeft === normalizedRight;
    }

    function run(command, args, maxBuffer = 256 * 1024) {
        return new Promise((resolve, reject) => execFile(command, args,
            { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer,
                ...(command === 'git' ? { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } } : {}) }, (error, stdout) => {
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

    async function gitDirectories(cwd) {
        const output = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute',
            '--git-common-dir', '--show-toplevel']);
        const values = output.replace(/\r?\n$/, '').split(/\r?\n/);
        if (values.length !== 2 || values.some(value => !value || /[\x00-\x1f\x7f-\x9f]/.test(value)))
            throw new Error('Invalid Git directory');
        return Promise.all(values.map(directory));
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

    async function gitFingerprint(desktop, active, git) {
        const parts = [];
        let probes = 0, bytes = 0;
        const stamp = info => [identity(info), info.size, info.mtimeMs, info.ctimeMs];
        async function control(file, read = false) {
            if (++probes > 1024) throw new Error('Git control probe limit');
            let before;
            try { before = await fs.lstat(file); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                parts.push([file, null]);
                return null;
            }
            if (before.isSymbolicLink() || !before.isFile() && !before.isDirectory()
                || before.isFile() && (before.nlink !== 1 || before.size > 64 * 1024))
                throw new Error('Unsafe Git control');
            parts.push([file, before.isDirectory() ? ['directory', identity(before)] : stamp(before)]);
            if (!read) return before;
            if (!before.isFile() || (bytes += before.size) > 128 * 1024)
                throw new Error('Git control byte limit');
            // Reject links before opening; compare the handle and pathname again so
            // replacement races cannot establish a reusable proof. O_NOFOLLOW is
            // unavailable on Windows, where these identity checks remain required.
            const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
            try {
                const opened = await handle.stat();
                if (!unchanged(before, opened)) throw new Error('Git control changed');
                const buffer = Buffer.alloc(64 * 1024 + 1);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                const after = await fs.lstat(file);
                if (bytesRead !== before.size || !unchanged(opened, await handle.stat())
                    || after.isSymbolicLink() || !unchanged(opened, after)) throw new Error('Git control changed');
                const text = buffer.subarray(0, bytesRead).toString('utf8');
                parts.push([file, text]);
                return text;
            } finally { await handle.close(); }
        }
        const common = git[1];
        for (const [root, expected] of [[common, git[2]], [git[3], git[4]], [git[5], git[6]]]) {
            const checked = await directory(root);
            if (checked.identity !== expected) throw new Error('Git root changed');
            parts.push([root, checked.identity]);
        }
        const registrations = path.join(common, 'worktrees');
        const before = await control(registrations);
        if (before && !before.isDirectory()) throw new Error('Unsafe Git registrations');
        for (const [cwd, top] of [[desktop.path, git[3]], [active.path, git[5]]]) {
            let current = cwd, depth = 0;
            for (; !samePath(current, top); current = path.dirname(current)) {
                if (++depth > 64 || !contains(top, current) || await control(path.join(current, '.git')))
                    throw new Error('Git discovery changed');
            }
            const marker = path.join(top, '.git');
            const info = await control(marker);
            if (!info) throw new Error('Missing Git marker');
            let gitdir = marker;
            if (info.isFile()) {
                const value = await control(marker, true);
                const match = /^gitdir: ([^\x00-\x1f\x7f-\x9f]+)\r?\n?$/.exec(value);
                if (!match) throw new Error('Invalid Git redirection');
                gitdir = path.resolve(top, match[1]);
            }
            // Only the common directory and its immediate registration directories
            // are bounded, known control locations. Other layouts use native Git.
            if (!samePath(gitdir, common) && !samePath(path.dirname(gitdir), registrations))
                throw new Error('Unbounded Git control location');
            if (!samePath(gitdir, common) && !before) throw new Error('Missing Git registrations');
            const admin = await control(gitdir);
            if (!admin?.isDirectory()) throw new Error('Unsafe Git administration directory');
            if (!samePath(gitdir, common)) {
                const relative = await control(path.join(gitdir, 'commondir'), true);
                if (typeof relative !== 'string' || !/^[^\x00-\x1f\x7f-\x9f]+\r?\n?$/.test(relative)
                    || !samePath(path.resolve(gitdir, relative.trimEnd()), common))
                    throw new Error('Git common directory changed');
            }
        }
        for (const name of ['config', 'config.worktree', 'commondir']) await control(path.join(common, name));
        if (before) {
            const names = [];
            const handle = await fs.opendir(registrations);
            for await (const child of handle) {
                if (names.length >= 128 || !child.isDirectory() || child.isSymbolicLink())
                    throw new Error('Git registration limit or link');
                names.push(child.name);
            }
            for (const name of names.sort()) {
                const entry = path.join(registrations, name);
                if (!(await control(entry))?.isDirectory()) throw new Error('Git registration changed');
                for (const file of ['gitdir', 'commondir', 'HEAD', 'locked', 'config', 'config.worktree', 'prunable'])
                    await control(path.join(entry, file));
            }
            if (!unchanged(before, await fs.lstat(registrations))) throw new Error('Git registrations changed');
        }
        return JSON.stringify(parts);
    }

    async function fingerprint(desktop, active, git) {
        try { return await gitFingerprint(desktop, active, git); }
        catch { return null; }
    }

    async function association(desktop, active, cacheAllowed = true) {
        if (!await nestedGit(desktop, active)) return ['desktop', desktop.path, desktop.identity];
        const key = JSON.stringify([desktop.path, desktop.identity, active.path, active.identity]);
        const time = now(), cached = gitAssociations.get(key);
        if (cacheAllowed && cached) {
            if (time >= cached.time && time - cached.time < gitTtl
                && await fingerprint(desktop, active, cached.git) === cached.fingerprint) {
                const checked = now();
                if (checked >= time && checked - cached.time < gitTtl) return cached.git;
            }
            if (gitAssociations.get(key) === cached) gitAssociations.delete(key);
        }
        const [[sourceCommon, sourceTop], [activeCommon, activeTop]] = await Promise.all([
            gitDirectories(desktop.path), gitDirectories(active.path)]);
        if (!samePath(sourceCommon.path, activeCommon.path) || sourceCommon.identity !== activeCommon.identity
            || !contains(sourceTop.path, desktop.path) || !contains(activeTop.path, active.path))
            throw new Error('Unrelated Git workspace');
        const git = ['git', sourceCommon.path, sourceCommon.identity, sourceTop.path, sourceTop.identity,
            activeTop.path, activeTop.identity];
        const before = gitTtl && cacheAllowed ? await fingerprint(desktop, active, git) : null;
        const output = await run('git', ['-C', desktop.path, 'worktree', 'list', '--porcelain', '-z']);
        const registered = output.split('\0').filter(field => field.startsWith('worktree ')).map(field => field.slice(9));
        if (!registered.some(value => samePath(value, sourceTop.path))
            || !registered.some(value => samePath(value, activeTop.path))) throw new Error('Unregistered Git workspace');
        if (before !== null) {
            if (before !== await fingerprint(desktop, active, git))
                return association(desktop, active, false);
            const checked = now();
            if (checked < time) return git;
            if (gitAssociations.size >= 32 && !gitAssociations.has(key))
                gitAssociations.delete(gitAssociations.keys().next().value);
            gitAssociations.set(key, { git, fingerprint: before, time: checked });
        }
        return git;
    }

    async function inspect(binding, relocationCwd) {
        if (typeof claudeHome !== 'string' || !path.isAbsolute(claudeHome)) return null;
        let matched = false;
        try {
            const first = await scan(binding);
            if (!first.found.length) return null;
            matched = true;
            const desktop = await directory(binding.workspaceRoot);
            // Legacy same-root records still support ordinary single-log reads, but
            // cannot establish identity proof for relocated duplicate transcripts.
            if (first.found.length === 1 && samePath((await directory(first.found[0].cwd)).path, desktop.path)
                && ['hostSessionId', 'procStart', 'pidDomain', 'startedAt'].some(key => first.found[0][key] === undefined))
                return relocationCwd === undefined ? null : { unavailable: true };
            for (const row of first.found) {
                if (row.hostSessionId !== binding.localSessionId
                    || row.bridgeSessionId !== undefined && row.bridgeSessionId !== binding.bridgeSessionId
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
            let relocation, relocationGit;
            if (relocationCwd !== undefined) {
                relocation = samePath(relocationCwd, active.path) ? active
                    : samePath(relocationCwd, desktop.path) ? desktop : await directory(relocationCwd);
                relocationGit = relocation === active ? git : await association(desktop, relocation);
            }
            const second = await scan(binding);
            const candidates = records => records.map(record => record.semantic).sort().join('\n');
            if (candidates(first.found) !== candidates(second.found)
                || first.home.identity !== second.home.identity || first.sessions.identity !== second.sessions.identity
                || desktop.identity !== (await directory(desktop.path)).identity
                || active.identity !== (await directory(active.path)).identity
                || relocation && relocation.identity !== (await directory(relocation.path)).identity) return { unavailable: true };
            const evidenceKey = JSON.stringify([
                binding.accountId, binding.organizationId, binding.localSessionId, binding.cliSessionId,
                binding.bridgeSessionId, binding.metadataFile, first.home.path, first.home.identity,
                first.sessions.identity, row.semantic, active.path, active.identity, git]);
            return { workspaceRoot: active.path, evidenceKey, ...(relocation ? {
                relocationEvidence: JSON.stringify([relocation.path, relocation.identity, relocationGit]) } : {}) };
        } catch (error) {
            // Absence of the registry is ordinary. A missing workspace after a match is unsafe.
            if (!matched && error.code === 'ENOENT') {
                try { await fs.lstat(path.join(claudeHome, 'sessions')); }
                catch (missing) { if (missing.code === 'ENOENT') return null; }
            }
            return { unavailable: true };
        }
    }

    async function resolveWorkspace(binding) {
        const resolved = await inspect(binding);
        if (!resolved || resolved.unavailable) return resolved;
        return { ...resolved, verify: async () => {
            const current = await inspect(binding);
            return !!current && !current.unavailable && current.evidenceKey === resolved.evidenceKey;
        } };
    }
    // Each call owns fresh registry/root checks. Git association reuse is separately
    // bounded by its TTL and unchanged control fingerprint.
    resolveWorkspace.resolveVerified = inspect;
    // Historical markers must not initiate network or device namespace probes.
    resolveWorkspace.resolveRelocationVerified = (binding, cwd) => typeof cwd === 'string' && path.isAbsolute(cwd)
        && !/^(?:[\\/]{2}|[\\/](?:\?\?|device)[\\/])/i.test(cwd)
        ? inspect(binding, cwd) : Promise.resolve({ unavailable: true });
    return resolveWorkspace;
}

module.exports = { createCliWorkspaceResolver };
