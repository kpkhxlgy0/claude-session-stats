# Metadata Location Implementation Plan

> **For agentic workers:** Use test-driven implementation and independent review, in the existing user-selected checkout.

**Goal:** Publish the real producer snapshot directory and read only the currently viewed snapshot through read_file.

**Architecture:** The producer advertises a version 2 location descriptor through the current metadata publisher.
The receiver derives an exact main/agent file path and reuses the prior native request/response reader.

**Tech Stack:** CommonJS, Electron authenticated fetch, node:test, existing Claude++ tweak API.

**Spec:** `../specs/2026-11-10-metadata-location-design.md`.

## Global constraints

No CLI/core changes, no read_file capability probe, no new dependencies or worktree, no publication. Preserve prior
uncommitted diagnostic artifacts. Directory descriptor: 8192 UTF-8 bytes, directory 4096 characters, version 2.
Snapshots: existing 16384-byte / 30-second validity and identity/replay rules. Native denial has no fallback.

## Review focus

- Legacy metadata migration must use exact compare-and-swap without replacing sibling fields or an active writer.
- Windows and POSIX locations must derive only the known current session/agent filename.
- Large child populations cannot affect metadata payload size or require bulk snapshot reads.
- Parent/child concurrent readers and navigation cannot mix paths, samples or publishers.
- Repeated reads and fork/resume fixtures must retain the existing totals without addition.

## Tasks and ownership

- [x] Metadata worker: `src/metadata-protocol.cjs`, `src/metadata-publisher.cjs`, and their two test files.
  Add failing directory protocol/publication tests; implement version 2 location methods, legacy migration and
  directory-only source calls; run those tests. Source contract is `readRemoteLocation(bridgeSessionId,
  {organizationId, signal}) -> {bridgeSessionId, organizationId, publisherId, generatedAt, directory} | null`.
- [x] Reader worker: `src/remote-reader.cjs` and `test/remote-reader.test.cjs`. Add failing location-to-selected-file
  tests; reuse the v0.7 native event transport; preserve current context/agent lifecycle; run its test file.
  Shared protocol methods: `makeLocation(value)`, `parseLocation(value, expected) -> {ok, location}|{ok:false,reason}`,
  `snapshotPath(location, agentId) -> string|null`, `samePath(actual, expected) -> boolean`.
- [x] Primary: `src/snapshot-publisher.cjs`, source tests, integration helper/tests, main tests, README and docs.
  Add and verify failing source tests; expose only verified resolved location, remove obsolete batch exporter;
  adapt actual-file integration fixtures and verify local/remote equality and no duplicate totals.
- [x] Primary integration: build renderer, run `npm test`, `npm run validate`, inspect diff and independent review.
  Record outcomes and the intentionally omitted native capability probe. No commit or publication in this task.

## Progress

Initial source baseline: c6b08ce (Session Stats 0.9.0). Existing diagnostic scripts/report are uncommitted task artifacts.
The previous temporary metadata size-probe directory was removed without running or injecting its script.

Implementation is complete. Fresh `npm run build`, `npm run validate`, and `npm test` passed (691/691).
The directory source suite passed 97/97, protocol/writer 55/55, reader 42/42 and actual-file integration 8/8.
Independent review found no actionable material findings; `git diff --check` passed. No live read_file capability
probe was performed, as instructed. No commit, release or Store update was performed. Both endpoints must receive
this change before cross-machine use of the directory protocol.

## Release follow-up

The user subsequently authorized GitHub and Claude++ Store publication. Prepare version 0.10.0, verify the release
commit and Windows/Linux CI, publish its tag/release, then pin the Store entry to that exact commit. The existing
0.9.0 diagnostic scripts/ZIP are local troubleshooting artifacts and are excluded from the release commit.
