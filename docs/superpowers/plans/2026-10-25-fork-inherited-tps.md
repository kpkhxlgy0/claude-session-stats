# Claude Fork Inherited TPS Implementation Plan

**Goal:** Include verified inherited fork history in session-average TPS and share the exact runner-produced value with local and RC consumers. Validate an actual native fork. The user subsequently authorized one minimal model turn in the dedicated validation branch to activate RC.

**Scope:** Preserve Claude's existing response-duration estimate and approximate label. Preserve other metric rules and relocated-transcript behavior. Publication follows the completed implementation and native validation.

## Observed native contract

The installed Desktop UI fork copies the selected source transcript prefix without rewriting conversation UUIDs, session IDs or timestamps. It persists `forkedFromSessionId` (the parent Desktop local ID) and optional `forkedAtMessageUuid` in Desktop metadata. The cutoff is excluded from the copy. RC/worktree unbinding may append control metadata. A native-created idle fork confirmed this structure and left the parent transcript unchanged.

The separate SDK fork implementation rewrites session and message/parent UUIDs, records copied origins as `forkedFrom: {sessionId, messageUuid}`, and changes the last copied row's timestamp to the fork time. Both formats need coverage; the SDK implementation must not be used to infer Desktop UI behavior.

Directly counting the rewritten copied timestamps can inflate inherited response duration. Resolve the declared original rows and their original timing instead of summing parent averages or adding duplicate copied responses.

## Work and ownership

- [x] Reader worker: add bounded fork lineage and a separate TPS accumulator, with source/version/boundary guards and no transcript cache on disk.
- [x] Metadata worker: implement bounded, unambiguous Desktop parent mapping, including legacy flat layouts and final identity/semantic rechecks.
- [x] Primary: inspect a real native fork, independently compute expected TPS, update README/tooltip and rebuild the generated entry.
- [x] Primary: add production main -> reader -> publisher -> local snapshot -> RC receiver parity coverage, including continuation, restart and unavailable ancestry.
- [x] Independent review and final full tests/build/validation; synchronize runtime files to the other machine with baseline/hash checks.
- [x] Real fork same-revision RC acceptance: after the user authorized one minimal prompt, the runner and receiving machine returned identical TPS and 13 matching fields for snapshot revision 218.
- [x] Restore diagnostic hooks and clean diagnostic scratch files. Keep the clearly named native validation branch available for inspection.

Completed acceptance evidence and its verification scope are recorded in `../validation/2026-10-25-fork-inherited-tps.md`.

## Initial decisions

- Use the original row's timestamp when `forkedFrom` proves the copied row's identity; never use the fork-time rewrite as inherited generation duration.
- Copied rows already rewritten to the child ID retain the existing non-TPS counters. The new change is limited to TPS, its lineage verification and cache validity.
- Existing `relocated` marker + complete `parentUuid` chain behavior remains unchanged; fork lineage is a separate source of proof.
- The receiver consumes the authoritative snapshot and performs no parent-log discovery.
