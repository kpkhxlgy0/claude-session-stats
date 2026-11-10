# Client Metadata Stats Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Follow the explicit file ownership below.

**Goal:** Make Desktop Remote Control stats use the proven metadata channel without changing the CLI.
**Architecture:** Producer exports verified existing snapshots; a bounded Main HTTP publisher patches only our
namespace. The receiving page GETs the envelope and validates the selected snapshot with the existing protocol.
**Tech Stack:** CommonJS Tweak, Electron fetch, Node test runner; TypeScript Claude++ core cleanup.
**Spec:** `../specs/2026-11-09-client-metadata-stats-design.md`

## Global constraints

No credentials logged/read directly, no model calls, no CLI edits, no UI automation, no release/push. Preserve the
existing uncommitted probe documentation. Work in the user-selected canonical checkouts; earlier worktree creation
was explicitly declined. Parallel implementation is restricted to disjoint owned files. Do not commit independently.

## Task 1: Metadata protocol and receiver

Owner: receiver worker. Files: new `src/metadata-protocol.cjs`, `test/metadata-protocol.test.cjs`, existing
`src/remote-reader.cjs`, `test/remote-reader.test.cjs` only.

Export `createMetadataProtocol(createSnapshotProtocol)` returning `key`, `maxBytes`, `maxAgents`,
`makeEnvelope(snapshots, {bridgeSessionId, organizationId, now})`,
`parseEnvelope(value, {bridgeSessionId, organizationId})`, and
`readSnapshot(value, {bridgeSessionId, organizationId, agentId, now})`.
Parse/read return `{ok:true,envelope}` or `{ok:true,snapshot}` and `{ok:false,reason}` on failure; make returns null
or an envelope. Structural parse validates every snapshot using its own timestamp; read applies real age to the
selected sample. make omits stale samples and rejects ambiguous publishers/identities.

- [x] Add failing tests for real GET metadata reads, wrong identities, age isolation, malformed/oversize/duplicate
  agent envelopes and no POST/event polling. Preserve route-change cancellation and replay tests.
- [x] Implement protocol and replace receiver RPC transport with one GET and metadata selection.
- [x] Run the two targeted test files; report exact results and limitations.

## Task 2: Main-process HTTP publisher

Owner: publisher worker. Files: new `src/metadata-publisher.cjs`, `test/metadata-publisher.test.cjs` only.
Export `createMetadataPublisher({source,fetch,now,pollMs,timeoutMs,...testOptions})` with `start()` and `stop()`.
Source contract: `listRemoteBindings()` yields `{bridgeSessionId,organizationId,accountId}`; async
`readRemoteSnapshots(bridgeSessionId,{organizationId,signal})` returns fresh verified snapshots or null.
Use Task 1's metadata protocol. No source/global configuration or auth-secret reads.

- [x] Tests first: GET exact identity before PUT; namespace-only patch; no writes for shared/offline/foreign data;
  local source revoked/stop/timeout; coalescing, bounded concurrency/backoff, old/new publisher protection.
- [x] Implement bounded Main writer. Inject fetch; production Main supplies Electron net.fetch.
- [x] Run focused tests with protocol once available. Do not modify publisher source or Main wiring.

## Task 3: Remove obsolete core transport

Owner: core worker. Exclusive repository: `D:/Unity/claude-plusplus/claude-plusplus`.

- [x] Remove service creation and native compile hooks, provider leases, implementation-only tests and related docs.
- [x] Keep legacy manifest permission/type compatibility if removing it would prevent older Tweaks from loading;
  expose no functional legacy service or native hooks. Document deprecation rather than claiming working RPC.
- [x] Adjust core tests and run build + directly affected tests. Do not install/restart/publish or bump versions.

## Task 4: Source integration, UI copy and validation

Owner: primary. Files: `src/snapshot-publisher.cjs`, `src/main.cjs`, their tests, renderer tooltip copy, README,
manifest/package metadata, generated index.js, design/plan/validation docs.

- [x] Add failing tests for read-only export of confirmed existing parent/child snapshots, no duplicated usage,
  stale bindings and stop; implement source methods without re-reading/recalculating raw logs.
- [x] Wire the new writer; remove old provider registration/permission use. Update receiver tooltip/version guidance.
- [x] Build Tweak, run complete relevant suites and core final checks, review combined changes independently.
- [x] Verify actual local publication where a live owned binding exists; disclose external-host acceptance limits.

## Progress and rulings

- Baseline: Tweak HEAD 49cc839; core HEAD 6356b0b. Two pre-existing probe documentation changes are preserved.
- User approved implementation on 2026-11-09 after reading successful live probe results.
- Ruling: leave the last cloud summary on stop to expire, rather than delete without atomic ownership comparison.
- Ruling: aggregate only individual snapshots in a bounded envelope; never sum child and parent counters.
- Native account header confirmed from Desktop's existing helper: `X-Expected-Account` with the binding's account UUID.
- Review correction: conditional `test` precedes namespace `add`; live stale comparisons reject with HTTP 400 and four
  simultaneous two-writer rounds each yielded exactly one HTTP 200 and one HTTP 400, preserving the winner.
- Review correction: preserve ownership/backoff across active-window rotation with a 4096-entry bounded history.
- Review correction: final batch export rejects an earlier successful sample after a newer unavailable commit.
- All four tasks complete. Final Tweak build/validation and all 675 tests passed; core build and all 770 tests passed.
- Independent review's three findings were fixed and targeted re-review passed without remaining findings.
- Final actual publication/GET checks matched four connected local producer sessions, including a 52-child session.
  The selected other-machine session still needs the runner update; see the
  [final validation record](../validation/2026-11-09-client-metadata-implementation.md).
