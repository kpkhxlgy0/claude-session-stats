# Session Average TPS Implementation Plan

> **For agentic workers:** Use the assigned file ownership below. Follow test-driven development; do not commit or push as part of this task.

**Goal:** Keep an estimated whole-session average TPS visible across user turns, tool execution, and subsequent generation, as selected by the user.

**Spec:** The design discussed in this chat: aggregate verified response output tokens and their existing request-time estimates before dividing. Preserve the `≈` label because these intervals include request/first-token waiting; do not claim DSH's pure decode-time semantics.

**Architecture:** Reuse the existing deduplicated response map. Compute `sum(output_tokens) / sum(valid response seconds)` over matching valid samples. Remote snapshots exclude the currently streaming response from this TPS calculation only, keeping previous samples and existing usage totals. New user inputs/tool results establish timing for later responses without clearing the session average.

**Tech Stack:** Existing CommonJS modules, Node test runner and jsdom 26.1.0. No new dependency or upstream data source.

## Global Constraints

- Session scope remains the currently verified local log/relocation ancestry or Remote Control synced main-session history.
- Numerator and denominator must use the same deduplicated valid responses; never estimate tokens from text or average per-response rates arithmetically.
- A valid sample has finite start/end timestamps, duration at least 100 ms, and nonnegative safe-integer output tokens. Missing/invalid or pending samples contribute neither tokens nor time. Known zero-output samples still contribute valid time.
- No usable positive rate means `null`/`—`. The tooltip must describe a session average over valid response samples, including wait time and excluding tool-only gaps.
- Preserve existing counts, identity checks, aliases, relocation handling and transport behavior. No model/context, authentication, or runtime settings changes.

## Tasks and ownership

- [x] Metrics worker: modify `src/metrics.cjs` and `test/metrics.test.cjs`, `test/session-store.test.cjs`, `test/session-history.test.cjs`. Extend `snapshot({ pendingResponseId, pendingResponseIds = [], pendingRequestIds = [] } = {})` to omit matching raw message IDs or unresolved request-ID fallback samples from TPS only; default output shape stays unchanged. RED then GREEN tests for weighted means, holds across turns/tools, known zero output, missing data, replay/alias deduplication, and sample replacement.
- [x] Primary: modify `src/remote-reader.cjs` and `test/remote-reader.test.cjs`. Pass the active stream ID into `snapshot` instead of blanking all TPS; retain no-value behavior before the first completed sample. Verify partial streams/final snapshots, tools, new turns and replay.
- [x] Primary: update the TPS tooltip in `src/renderer.cjs`, assertions in `test/renderer.test.cjs`, and the README. Regenerate `index.js` using `npm run build`.
- [x] Primary: run all tests, `npm run validate`, and `git diff --check`; review changes independently and check hot-reload logs.

## Review focus

- Never add pending response time without its matching output tokens.
- Partial/missing data must not inflate an average; only the matching valid sample set contributes.
- Replayed user inputs, message blocks, and request-ID aliases must not duplicate samples or reset prior results.
- Switching session/organization and local file replacement must not retain another session's average.
- The label must remain an estimate and must not promise first-token exclusion or token-by-token live speed.

Ruling: Keep abandoned unfinished Remote Control stream IDs excluded from TPS until a matching completion is observed, and do not reopen completed stream IDs on replay. Clearing only the active-stream pointer would otherwise promote partial responses into valid session-average samples.

## Progress and validation

- Initial metrics/local implementation: RED observed (15 expected failures), then 65/65 targeted tests passed.
- Remote/UI integration: three stream-average regressions and one tooltip regression observed RED, then 47/47 remote/renderer tests passed.
- Initial full suite: 152/152 passed; generated entry validation and `git diff --check` passed.
- Read-only replay of a real local log: 3,369 records; every non-TPS metric unchanged; the session average survived 333 new-input/tool-result boundaries. Temporary replay ran in memory and did not modify the log.
- Runtime logs confirmed the installed junction hot-reloaded the changed sources and regenerated entry.
- Independent review found two P2 gaps despite green tests: requestId-only partial samples bypassed the pending-message filter, and replayed completed stream delta/stop could alter an active stream. Fix round 1 is assigned to the original metrics implementer with ownership extended to the remote reader and its tests. Both issues require direct regression coverage and scoped re-review before completion.
- Fix round 1: both original P2 findings addressed; 78/78 metrics/remote tests and 161/161 full tests passed, with build validation and whitespace checks. Scoped re-review identified a new recovery issue: an unclosed replay segment could keep later genuine responses excluded forever. Fix round 2 must reset replay depth at a genuine new input while retaining exclusion of abandoned response samples; repeated prompt identities must not reset that boundary.
- Fix round 2: genuine prompt/tool inputs reset replay depth and replayed inputs do not; 34/34 remote tests and 163/163 full tests passed. Re-review confirmed recovery but identified a late old stop crossing the new-input boundary. Fix round 3 must reject an end timestamp preceding the active input/start boundary and prevent the associated untrusted usage delta from contaminating that response. If no reliable current usage arrives afterwards, retain previous confirmed TPS rather than promoting the ambiguous sample.
- Fix round 3: late stop timestamps are checked against the raw input/start boundary; contradictory tails roll usage back to the identity-confirmed baseline. A later valid current usage is required before admitting that ambiguous sample; otherwise it stays excluded and future streams remain readable. Two new regressions observed RED, then 36/36 remote tests passed. Scoped re-review is pending.

- Final acceptance: scoped re-review marked all findings addressed with no new material regressions; the final full suite passed 165/165, and entry/manifest validation plus whitespace checks passed. Installed Claude++ hot-reload logs confirm the new sources started successfully. No native UI automation, commit, push, or release was performed.

- Release preparation (2026-10-24): the user explicitly authorized commit, push, a new release, and the store update. Version metadata and release notes are prepared for v0.3.0. Fresh `npm ci`, build, 165/165 tests, install-entry validation, and whitespace checks passed; remote main still matches the implementation base. Publication will use this verified release tree.
