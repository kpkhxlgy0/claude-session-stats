# Worktree Snapshot Synchronization Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans within the authorized scope.

**Goal:** Synchronize snapshots with the current verified CLI workspace and restore the real session's local/remote display.
**Architecture:** A bounded runner-side directory resolver supplements Desktop metadata. Publisher and receiver use one current-directory relative-path contract.
**Tech Stack:** Existing CommonJS Node/Electron modules and node:test; Git read-only inspection for registered worktree proof.
**Spec:** ../specs/2026-10-27-worktree-snapshot-sync-design.md

## Constraints

- Preserve native read checks; no fallback on denial, no alternative transport for refused file content.
- Recompute new snapshots from the existing metric store; never copy an old snapshot to a new directory.
- No credential/key/socket reads. No new model messages, worktrees, project copies or publish operations.
- Primary owns integration and live diagnostics. Worker owns CLI workspace resolution and, after the live duplicate-source finding, session-source/session-store and their focused tests.

## Tasks

- [x] Worker: TDD createCliWorkspaceResolver({claudeHome, ...testDependencies}) returning async resolveWorkspace(binding). Return null when no active CLI evidence exists; {unavailable:true} for unsafe/conflicting evidence; success {workspaceRoot, evidenceKey, verify:async()=>boolean}. Bind to exact registry IDs, process birth and Git membership. Keep cache bounded and revalidate semantic identity.
- [x] Primary: failing binding/publisher integration tests for entered worktree with stale Desktop cwd, switched/removed directory, and stale publication; pass resolver into discovery and rechecks through main/publisher. Keep functions retained outside wire/binding serialization.
- [x] Primary: failing reader test for a current-directory request, strict absent-anchor response, and no retry/fallback after denial; update existing fixtures and bundled renderer only if changed.
- [x] Primary: use a normal new publication at the verified workspace. Preserve old-root snapshots on binding migration so they expire; do not migrate their payloads.
- [x] Independent review and full test/build/manifest validation.
- [ ] Deploy source changes to installed local and peer runtime with baseline guards; verify the real session via normal RC. Restore all diagnostics and clean owned markers/scratch.

## Review focus

- PID reuse or multiple live registry records must not select a stale cwd.
- A different repository, unregistered worktree, symlink substitution or arbitrary path must not cause publication.
- Directory changes during discovery/write/local read must invalidate the old binding.
- Current-directory RC requests retain request identity, session/org, 16 KiB limit, strict schema, freshness and anti-replay checks.
- Denied reads never trigger a second transport, path or anchor.

## Progress and rulings

- Baseline: main v0.5.0 commit 92870032e58c2ba9af5787b9074726c64c3336c4, clean before this task.
- One harmless fixed-anchor diagnostic was denied; no refused payload was read. Diagnostic markers were removed.
- Native same-directory set_cwd is a no-op and cannot re-anchor a mature CLI session. Adopt the single current-directory contract as the minimum coherent repair.
- Directory contract implemented: 25 resolver tests and full suite 288/288 passed before the additional source finding; real native RC read the new snapshot in 1.9 s, returning source-unavailable rather than denied.
- Live verification found same UUID original/worktree logs. Exact bytes prove the 30,380,970-byte file is a newline-terminated prefix of the 70,860,115-byte file. Implement bounded prefix-chain validation only with active CLI workspace evidence; retain duplicate rejection otherwise. Native current writer is not inferred from directory or mtime.
- Added failing real-store/publisher/receiver integration case for duplicate prefixes; it must become green and reject later divergence.

- Real two-machine data parity verified on revision 18; 301/301 full tests pass. Visible foreground rendering remains unverified because both pages were hidden. See ../validation/2026-10-27-worktree-snapshot-sync.md for successful parity and the later reload-overlap denial.
- Follow-up local flicker investigation completed 2026-10-28: renderer timeout versus global poll wait and a publication commit window were fixed. Final tests 317/317; actual foreground had 37 successful reads and 43 stable DOM observations across 86.2 seconds and seven revisions. See ../validation/2026-10-27-local-stats-flicker.md. Source changes are synchronized to both installations, remain uncommitted, and preserve cold-start waiting and fail-closed identity checks.
