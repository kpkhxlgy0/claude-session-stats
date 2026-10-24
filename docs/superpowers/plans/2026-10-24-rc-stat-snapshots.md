# RC statistics snapshots implementation plan

> **For agentic workers:** use subagent-driven-development with the user-required explicit file ownership and parallel independent tasks. Do not commit or publish.

**Goal:** compute on the runner once and display the same verified statistics through RC.
**Architecture:** bounded Desktop metadata bindings feed a background atomic snapshot publisher; local IPC returns its sample. A replacement remote reader obtains the fixed JSON file through read_file, validates it with the shared pure protocol, and never falls back to event-derived TPS.
**Tech Stack:** CommonJS, Node fs, Electron bridge, existing node:test/jsdom.
**Spec:** ../specs/2026-10-24-rc-stat-snapshots-design.md

## Global constraints
Use only the fixed project-relative snapshot path and allowlisted schema; preserve the current local formula. Enforce identity, age, truncation and lifecycle checks. No new dependencies, new permission grants, prompts, SSH, commit/push/release. Current ordinary branch: codex/claude-rc-stat-snapshots, base 68e4cd351d29d90c2fd22aef1d2991b37cd04282.

## Shared interface (primary owns src/snapshot.cjs)
Export `createSnapshotProtocol()`, a self-contained serializable function returning:
- `normalizeBridgeId(value)`: cse_* or session_* -> session_*, otherwise null.
- `snapshotPath(bridgeId)`: fixed relative path or null.
- `projectStats(raw)`: allowlisted stats (turns, steps, totalTokens, inputTokens, outputTokens, cachedInputTokens, cacheHit, tps, usageComplete, status), or null for invalid values. Counts are nonnegative safe integers or null; cacheHit is 0..1/null, tps is positive finite/null; statuses ok/incomplete/not-found/unavailable.
- `makeSnapshot(binding, raw, {publisherId, revision, now})`: schema object or null; binding has bridgeSessionId and organizationId.
- `parseSnapshot(text, {bridgeSessionId, organizationId, now})`: {ok:true,snapshot} or {ok:false,reason:'invalid'|'identity'|'expired'|'future'}.
- constants `maxBytes=16384, maxAgeMs=30000, futureSkewMs=5000`.
Only the protocol file owns the wire schema. Remote reader serializes this factory into the page like the existing metrics factory.

## Task 1 — protocol and integration (primary)
Files: src/snapshot.cjs, test/snapshot.test.cjs, src/main.cjs, test/main.test.cjs, src/remote-bridge.cjs, test/remote-bridge.test.cjs, src/renderer.cjs, test/renderer.test.cjs, README.md, generated index.js.
- [x] RED then GREEN pure protocol cases, including privacy projection and invalid identity/time/value.
- [x] Integrate publisher start/stop and local reads; keep unbound local sessions working.
- [x] Expose remote unavailable state with specific tooltip; preserve identity guards and only approved metadata.
- [x] Add integration equality tests using real publisher output through reader transport; build the entry.

## Task 2 — publisher (worker A)
Exclusive files: src/snapshot-bindings.cjs, src/snapshot-publisher.cjs, test/snapshot-bindings.test.cjs, test/snapshot-publisher.test.cjs.
Produce `createSnapshotPublisher({claudeData,store,now=Date.now,pollMs=2000,heartbeatMs=10000,...test dependencies})` with `start()`, `readLocal(localSessionId)` (Promise of null if unbound; otherwise allowlisted stats plus snapshotGeneratedAt/snapshotRevision/snapshotPublisherId after successful publication, or status unavailable), `stop()` (may return cleanup Promise).
Produce bounded binding discovery from claude-code-sessions/<account UUID>/<org UUID>/local_<UUID>.json. Confirm file sessionId, cliSessionId, workspace root (nonempty worktreePath, otherwise cwd), bridgeSessionIds and nonarchived/non-unavailable state; reject explicit remoteControlUserEnabled=false. Do not require true userEnabled or true autoEligible: real records often omit them. Reject duplicate local/bridge identities across files. Bind metadata account/org, canonical workspace and source CLI UUID; do not export local paths or CLI IDs into snapshot.
- [x] RED tests using OS-temp real metadata/workspace fixtures and store stub/real store.
- [x] GREEN bounded discovery, identity recheck, atomic writes and shared local sample; no symlink descendant traversal.
- [x] Test unchanged heartbeat, new revisions, background publication, mapping changes, cleanup ownership, stopped writes, invalid/missing stats, ignored state and conflict handling.
- [x] Return targeted validation and any open integration concerns. No edits outside owned files.

## Task 3 — receiver (worker B)
Exclusive files: src/remote-reader.cjs and test/remote-reader.test.cjs.
Keep `createRemoteReader(win, createSnapshotProtocol, options={})` and `buildRemoteScripts(owner)` exports; replace synchronized-history metrics ingestion with snapshot transport. Keep current page/org identity acquisition and strict bridge/shared checks. POST /v1/code/sessions/<id>/events with {events:[{payload:{type:'control_request',uuid,request_id,request:{subtype:'read_file',path:<fixed path>,max_bytes:16384,encoding:'utf-8',anchor:{kind:'workspace_root'}}}}]}. GET a sequence cursor before posting; poll ascending events after that cursor for matching control_response. Do not return file contents to main; return only validated stats plus threadId, source:'remote_control', status, snapshotGeneratedAt/snapshotRevision/snapshotPublisherId. Unsupported/missing/denied/offline/expired replies return bound unavailable status (not event-derived estimates). Preserve 750ms peek bridge behavior; snapshot validity must be checked on peek.
- [x] RED tests for request shape and identity, final shared numeric values, race/switch/stop, wrong/old response, missing/truncated/big/invalid snapshots and freshness.
- [x] GREEN implementation, one request at a time, 12s bound, normal 5s polling and 30s error backoff; use test timing options.
- [x] Verify sequence pagination, transport/authorization failures, no model user messages, no arbitrary-path fallback and pending expiry.
- [x] Return targeted validation and open issues. No edits outside owned files.

## Review focus
1. Cross-account/org or ambiguous Desktop mappings must not expose another session's statistics.
2. Async map changes, stop/reload and file replacement must not publish or display a stale identity.
3. Large/malformed/replayed replies and receiver clock skew must fail closed without old-estimate fallback.
4. Writer may be running while its local tab is hidden; inactive readers should not cause overlapping RPC loops.
5. Filesystem destinations remain project-contained and existing unrelated state survives.

## Preflight / rulings
| Shared boundary | Check / ruling |
| --- | --- |
| Task 1 / 2 | protocol and publisher methods above are the integration contract; primary owns main and protocol only |
| Task 1 / 3 | keep source remote_control and explicit snapshot metadata; bridge/UI must support unavailable bound reply |
| Task 2 / 3 | same path/schema and UTC timing; equal statistics at equal snapshot revision, not zero transport latency |
| All tasks | user-approved implementation is sufficient authorization; parallel workers have disjoint file ownership; no worktrees or publishing |
| Task 1 | generate index only after renderer integration |
| Task 2 | bridge IDs in metadata prove binding, not live connection; receiver additionally confirms connected state |
| Task 3 | supported read_file was observed reaching the user's Desktop RC runner; a directory probe returned read denied, not unsupported; a valid snapshot path still needs roundtrip validation |

## Execution ledger
- Planning complete; metadata shape verified against actual Desktop files. Prior diagnostic code and temp file were removed and baseline is clean.
- Protocol: six expected RED cases, then 7/7 GREEN. Bridge/UI tests: expected RED for missing provenance and unavailable rendering, then 47/47 GREEN.
- Ruling: workspace root follows Desktop's existing getWorkspaceRoot adapter (worktreePath, otherwise cwd), not originCwd. The original repository can differ from the actual session workspace; publisher receives an explicit regression requirement. No Git worktree is created or used for development.
- Ruling: publisher uses two bounded metadata discovery passes per poll with strict per-binding rechecks, avoiding a full tree scan for every file operation; initial cold history loading can delay the first shared sample, while incremental reads are reused thereafter.
- Publisher: focused RED/GREEN lifecycle and workspace-root regressions complete, 20/20 targeted tests passed. Receiver: 20/20 targeted tests passed and independent scoped review passed with no material findings.
- Main/entry integration: local IPC returns the published sample; generated entry now awaits asynchronous cleanup before replacement. Entry/main/real-filesystem cross-component tests passed 11/11.
- Full suite passed 185/185; build, install-entry validation and whitespace checks passed.
- Native RC roundtrip passed on an existing local runner through the real Claude service: the production receiver read the generated workspace snapshot, accepted its workspace_root anchor and matching identity, and every numeric field/revision matched. TPS was 56.70977292103374 on both sides. The one-time diagnostic hook and OS-temp script were removed.
- The user-named conversation runs on another computer which has not yet received this implementation. This validation proves the protocol and local runtime, not installation or numerical comparison on that other computer.
- One interrupted RED fixture was removed using the same verified Temp path after dropping unnecessary -Force from the initially policy-rejected cleanup; no leftover fixture remains.
- Final review found three P2 publisher lifecycle gaps: returning bindings reset revisions under the same publisher; an older local validation can delete a newer legitimate publication; writing inside a watched tweak installation can trigger a reload loop. A single fix wave is assigned to the original publisher worker with direct regression coverage and scoped re-review.
- Ruling: snapshot publication fails closed inside canonical watched tweak installation roots (including installed junction targets), without changing the Claude++ core watcher. This prevents reload loops; such development-directory sessions cannot share a snapshot until their workspace lies outside the watched installation tree.


- Final fix-wave acceptance: all three findings addressed; independent scoped re-review found no new material regressions. Final full suite passed 201/201; load/build validation and whitespace checks passed. Current runtime continues publishing fresh snapshots after the lifecycle fixes.
- At implementation handoff, the changes remained uncommitted on codex/claude-rc-stat-snapshots; no version bump, push, release, store update, or installation on the user's other computer had been performed.
- Follow-up authorization: the user requested committing and pushing this feature, publishing a new version, and updating the Claude++ store. Release preparation targets v0.4.0 and preserves the requirement to update both the runner and receiver. Installation on the user's other computer is not part of this release operation.
- Release preparation verification: v0.4.0 package/lockfile/manifest versions agree; rebuilt entry, full 201/201 tests, manifest/install validation and git whitespace checks passed on the prepared release tree.
- The first release candidate was committed as 9d6af0c and pushed with tag v0.4.0. Linux CI passed, but Windows CI stalled in the delayed-local-validation test helper; both runs were cancelled for diagnosis and no release or store update was published. The same full suite passed locally under Node 24.22.1.
- Release correction targets v0.4.1, retaining the existing unpublished v0.4.0 tag. The scoped correction canonicalizes the test fixture destination to match the publisher's filesystem path and bounds test synchronization; it does not change production snapshot behavior.
- An OS-temp junction regression reproduced the original pause-helper failure. The corrected helper passes the alias and lifecycle regressions with separate readiness/held deadlines. A pre-existing Windows atomic stress assertion also failed intermittently under continuous readers; it now checks the documented unavailable outcome, full snapshot integrity, and exact recovery, with deterministic rename-lock exhaustion coverage. No production source changed in the release correction.
- v0.4.1 acceptance: independent scoped review reported no material findings; Node 24.22.1 full suite passed 205/205 in 12.58 seconds, manifest/entry validation and whitespace checks passed.
