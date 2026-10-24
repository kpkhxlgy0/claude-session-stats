# RC statistics snapshots

User-approved design (2026-10-24): the running Desktop computes statistics from its original local JSONL, writes a small snapshot in the project, and the receiving Desktop reads that snapshot through RC. Both surfaces display the same numeric sample; transport polling can delay which revision is visible.

## Contract and behavior
- Preserve the v0.3.0 whole-session TPS formula and all other local metrics.
- File: `.claude/session-stats/<canonical session_ID>.json`, relative to the session's original workspace root. Use RC `read_file` with `anchor: { kind: "workspace_root" }`, UTF-8, at most 16,384 bytes. Never read arbitrary remotely supplied paths.
- Schema v1 contains only producer `claude-session-stats`, bridgeSessionId, organizationId, publisherId, revision, generatedAt (UTC epoch milliseconds), and the allowlisted numeric/nullable statistics plus status and usageComplete. No title, prompt, filesystem path, local transcript ID or credentials.
- Publisher runs every 2 seconds, discovers nonarchived Desktop records with explicit bridgeSessionIds, rereads identity before publishing, writes atomically, and refreshes unchanged snapshots at least every 10 seconds. It publishes independently of the visible local tab.
- The local IPC read for a bound session returns the same sample that was successfully written. Failure to publish must be visible and must not claim a shared revision.
- Receiver uses Desktop's current logged-in page and the existing organization/session identity checks. It verifies an unshared bridge session and a connected worker, correlates one read_file control request by a random request ID, and accepts only a matching valid snapshot.
- Poll normally every 5 seconds with one in-flight request per identity, a 12-second RPC limit, and 30-second backoff after unavailable/denied/missing data. Fresh snapshots are at most 30 seconds old; future skew over 5 seconds is rejected. Cached data must expire even before another successful fetch.
- Never calculate remote TPS from synchronized event timing as a fallback. Missing writer, offline worker, invalid identity/schema, truncation or expiry shows unavailable statistics with a meaningful tooltip. No model prompt, permission escalation, token extraction, arbitrary file read, SSH service, or additional network listener.
- Both runner and receiving machines need the implementation. Installing only the receiver cannot create the runner's snapshot. Live verification of the user's other computer is conditional on that installation; do not claim it occurred.
- No new dependencies, version bump, staging, commit, push or publication in this implementation task.

## Filesystem and lifecycle
Treat the snapshot directory as application-owned state. Refuse symlink/reparse descendants, unknown existing destination ownership, duplicate mappings and invalid path IDs. Create a local ignore file for generated files without editing repository-wide ignore rules. Preserve unrelated files; cleanup only this publisher's own snapshot/temp files. Stop and identity changes must invalidate pending writes and reads.

## Acceptance
Tests cover real filesystem publication, local/remote numeric equality, concurrent readers, wrong session/org, overwritten mapping, atomic replacement, unsafe destinations, stale/future/rollback snapshots, stopped/disconnected sessions and missing/old peer. A native RC roundtrip uses an existing consenting session and the fixed snapshot path when available; all temporary diagnostic artifacts are removed.
