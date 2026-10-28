# Relocated session recovery after Desktop restart

## Confirmed failures

The user reported unavailable Session Stats after migrating Claude++ to its local source checkout and removing the old installation copy. The tweak junction, enablement, runtime and entry bundle remained intact. Existing core LocalSessions-channel warnings were not the cause: this tweak uses its own local-log reader and Remote Control bridge.

Two real local sessions reproduced independent gaps in the migration proof rules:

- The presentation session had returned to the Desktop project root. Its two logs were a complete strict prefix pair (approximately 30 MB and 83 MB at investigation time). The resolver returned no workspace evidence for a same-root registry, so duplicate-source selection returned `not-found`. The historical relocation marker named the earlier presentation worktree rather than the current root.
- The release session remained in the release worktree. Its live registry had the matching Desktop/CLI IDs and process-start identity, but omitted `bridgeSessionId`; the old resolver rejected it. Its two logs were also equal-length, byte-identical complete copies (approximately 19 MB each), which the old source resolver rejected independently.

These paths do not use the deleted Claude++ source directory. File names, metadata, byte comparisons and numeric statistics were inspected; transcript text was not included in diagnostic output. No original session log was modified or relocated.

## Change and boundaries

- Complete same-root registry records now produce recheckable process/workspace evidence. Legacy incomplete same-root records retain their ordinary single-log fallback without becoming proof for duplicate logs.
- A missing registry bridge ID can be resolved through the unique Desktop binding, while exact host/CLI identity, one live process, process-start identity and directory association remain required. An explicitly conflicting bridge ID is rejected.
- Equal-length complete logs must compare byte-for-byte before one is selected deterministically; strictly extended logs still select the longest verified history once. Existing proof becomes invalid after replacement; a new complete comparison may establish a new proof for the changed files.
- Historical relocation directories need fresh association with the Desktop project or a registered related Git worktree. Metadata versions, process identity, directory identity and source versions are rechecked; no positive proof is reused across an I/O boundary.
- Review caught and corrected two new boundary problems: historical UNC/device paths are rejected before filesystem probing, preserving their raw spelling until validation; each body scan permits at most four distinct historical-directory proof attempts before failing closed. Repeated paths are deduplicated only within that scan.
- Divergent files, incomplete prefixes, invalid identities, changing versions, unrelated workspaces and exceeded limits remain unavailable. Statistics are not combined across copies.

## Verification

- New regressions reproduced the failures before implementation. Six affected suites passed 140 tests after the review fixes.
- Final `npm test`: **347 passed, zero failed, zero skipped** (12.84 seconds). `npm run validate` and `git diff --check` passed. The previous full run before the two review fixes passed 344 tests.
- Independent final review found no remaining material issue. Its in-memory probes confirmed zero filesystem probes for eight UNC/device spellings, and four callback attempts per scan for 100 distinct unsuccessful historical markers, including a subsequent scan.
- Temporary bounded renderer logging observed the current visible sessions' existing IPC replies change to `status: ok`. The release session returned 25 turns, 193 steps and 88.27519533043616 estimated tok/s; the presentation session returned 124 turns, 716 steps and 80.10625662179876 estimated tok/s. These are measurements at validation time, not fixed expected values for future turns.
- The diagnostic entry was restored byte-for-byte before final tests. Its SHA-256 is `001b0a44c2a7a30a48473654532482eef8c0c295defff58be705c78f2a91dd0a`; `index.js` has no diff.
- Final read-only probes reused the production binding, source and metrics code for three reads of each actual session. All six were `ok`; every projected statistic matched the running publisher's current protocol-valid snapshot. The release session took 1383 ms initially and 1150–1200 ms for subsequent reads, with 15 Git calls per read. The presentation session took 798 ms initially and 59–63 ms subsequently, with zero Git calls in this final observation. Filesystem caches and concurrent application activity were not controlled, so these are not general latency guarantees or a remote UI benchmark.
- An earlier probe overlapped development hot reload and encountered a temporarily removed snapshot after one successful read. It was repeated after implementation froze; all six final reads succeeded. Hot reload still has a cold publication interval.

The implementation checks above used version 0.5.2 through the existing local development junction, before preparing the 0.5.3 release. Another machine's Remote Control UI was not operated during this task.
