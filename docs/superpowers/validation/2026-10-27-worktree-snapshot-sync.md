# Worktree snapshot synchronization validation

Session identifiers, machine names and project paths are anonymized; measured values are preserved.

Date: 2026-10-27. Branch: `codex/claude-worktree-snapshot-sync`. Changes remain uncommitted; no version bump or release.

## Verified causes and fixes

- CLI 2.1.308 keeps `workspace_root` at session start/claim while its current directory and read safety boundary follow worktree entry. Desktop metadata retained `<project-root>`; the live CLI registry, matching process birth and registered Git worktree identify `<project-root>/.claude/worktrees/<worktree>`.
- Publisher now regenerates snapshots at the verified current directory. Receiver uses one fixed relative current-directory read contract with the native permission checks unchanged. No deny-triggered path, anchor or transport fallback.
- Two same-UUID transcripts caused the prior index to return not-found. The 30,380,970-byte worktree copy is an exact newline-terminated prefix of the 70,860,115-byte original-directory file. This does not prove the native live writer. The new bounded source proof selects a unique complete extension only when all candidate files and the live-workspace relocation evidence agree; it never merges their totals.

## Automated validation

- `npm test`: 301 tests, 301 passed, zero failures, exit 0.
- `npm run build`: exit 0.
- `npm run validate`: manifest, package, renderer bundle and install entry points verified, exit 0.
- `git diff --check`: exit 0.
- Independent read-only review closed identity, nested Git association, local fallback, historical-path probing and context-cache findings. No remaining code blocker was reported.

## Real session and two-machine result

- Local route: `<local-session-id>`.
- CLI: `<cli-session-id>`.
- Remote Control route: `<bridge-session-id>`.
- Peer machine: `<receiver-machine>`, already open on that exact Remote Control route.
- The running publisher's `readLocal` result and the peer's production `createRemoteReader` both returned status `ok` with these exact shared identifiers:
  - Publisher `<shared-publisher-id>`.
  - Revision `18`; generatedAt `1793114823434`.

| Field | Both machines |
| --- | ---: |
| turns | 94 |
| steps | 544 |
| totalTokens | 158128432 |
| inputTokens | 157643403 |
| outputTokens | 485029 |
| cachedInputTokens | 154914402 |
| cacheHit | 0.9826887713150927 |
| tps | 82.03747247680508 |
| usageComplete | true |

These are real native/API results, not mocked network responses. The receiver read only the normal fixed snapshot through authenticated RC; no credentials, raw transcript or refused old snapshot were transferred through the diagnostic transport.

## Timing and remaining visual acceptance

- Independent real-source cold calculation plus workspace discovery: 4614 ms; warmed source call: 3161 ms. Both numerical results matched.
- Full local publisher/readLocal during hot-reload startup: 11272 ms, including startup publication and binding rechecks.
- Successful peer RC read: 2685 ms.
- Both Claude pages reported `document.visibilityState === 'hidden'`. The existing renderer deliberately removes its statistics bar in hidden documents. Therefore data parity is verified; visible foreground rendering was not verified.
- A second diagnostic overlapped a subsequent local hot reload and returned `snapshot-denied` after 1489 ms. Native RC uses this error for multiple file failures, including missing files; the timing is consistent with the known stop/start publication gap, but the native cause was not independently distinguished. No alternative path/anchor or repeat probe was attempted after that denial. The live registry still identified the same worktree, and metadata-only inspection subsequently confirmed renewed 481-byte snapshot publication. Foreground acceptance should include recovery after reload; do not report uninterrupted visibility as verified.

## Installation and cleanup

The local tweak is the existing repository junction. Nine changed/new runtime files were synchronized to the peer with expected-SHA guards and byte readback. After restoring peer diagnostics, all nine hashes matched the intended product source and the peer's temporary result file was confirmed absent. Main/source versions remain 0.5.0 pending an explicit release request.

Temporary native diagnostic hooks are removed before delivery. No Git worktree, temporary project, model message, permission relaxation or old-snapshot migration was used.
