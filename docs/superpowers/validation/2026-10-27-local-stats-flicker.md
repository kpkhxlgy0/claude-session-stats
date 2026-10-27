# Local statistics flicker investigation

Session identifiers, machine names and project paths are anonymized; measured values are preserved.

## Observed failure before this follow-up fix

The reported session runs on the local machine, at `<local-session-id>`.
Read-only instrumentation in the installed main module observed the real front-end and main-process statistics calls without moving or clicking windows.

- All 20 DOM observations: document visible, one composer, one statistics bar, every displayed statistic was a dash.
- Nine successful main-process reads took 8346–14613 ms. They returned valid `ok` snapshots at revisions 18, 41 and 64 with TPS 82.03747247680508.
- Three probes matching the runtime's 5000 ms IPC limit all timed out at 5007–5016 ms.
- `claude-plusplus/packages/runtime/src/tweak-ipc.ts` applies that five-second timeout to renderer invocations. Late successful backend results do not undo an already rejected request.
- Independent deterministic reproduction also proved that a heartbeat can replace a snapshot while `readLocal` validates it, causing `ok/rev2 → unavailable → ok/rev2` with unchanged statistics. The prior tests preserved the newer publication but explicitly accepted the unavailable older response.

The observed front-end failure was numerical dashes, not disappearance of the bar or a hidden document. This finding supersedes the prior turn's hidden-window limitation for local foreground verification.

## Repair boundary

The production main handler requests a committed sample without waiting for the global background poll. Cold/unresolved reads return unavailable promptly and cannot invoke an independent statistics fallback. Existing directory, exact-file, binding, epoch, membership and final freshness checks remain.

A legitimate committed successor may be selected during validation; a confirmed older successful own publication may survive a newer successful heartbeat while still fresh and bound. Arbitrary replacements, removed bindings, failed successors and expired data are rejected. No higher IPC timeout, unchecked UI cache, or renderer visibility change is used.

## Publication commit window

The initial fast-read fix reduced successful native calls to about two seconds, but live validation still found an unpublished-candidate window. Trace at `1793116761952` recorded `Published snapshot changed` while captured/latest committed revisions were both 41 and the state remained active. Directory/workspace proof tracing did not reject that call.

The publisher now signals completion of each own candidate only after the final identity checks commit its snapshot/destination or failure cleanup finishes. A reader waits for this signal only when its safely read file exactly equals that in-flight candidate and neither committed sample. It rereads the file and revalidates the binding/directories/freshness afterward. It never waits for global statistics collection or trusts an uncommitted/arbitrary file. Independent review found no reader/publisher or file-handle deadlock.

## Final verification — 2026-10-28, Asia/Singapore

- Full `npm test`: 317 passed, zero failed, exit 0; `npm run validate` and `git diff --check` passed.
- Regression tests observed the expected failures before both repairs, including a real atomic rename paused before memory-state commitment and a failed identity check during that pause.
- Native foreground observation used the actual installed tweak, its normal renderer IPC requests, and the existing bar's DOM. No injected test statistics, model messages, window activation, or synthetic RC replies were used.
- After the first valid sample, 86.2 seconds of observation contained 37 successful reads and zero unavailable reads. Read latency: minimum 1582 ms, maximum 2274 ms, average 1917.73 ms.
- All 43 subsequent DOM observations reported a visible document, exactly one statistics bar, and `94 turns · 544 steps · ≈ 82 tok/s`, `158.1M tok`, `Cache hit 98%`. Snapshot revisions progressed through 64, 82, 105, 128, 151, 174 and 197 without reverting to dashes.
- The observation began with the window hidden; initial foreground/unresolved publication reads still showed waiting status before the first valid sample. This is not an assertion of instant startup or zero cold-start waiting. Invalid/expired identity evidence still fails closed.
- The peer's `src/main.cjs` and `src/snapshot-publisher.cjs` were synchronized with expected-SHA guards and byte readback. Final SHA-256 values: main `2fdf47760457e3d15ae804648398c469f7765ba6ab7f8221bfc5746d02e016f7`; publisher `53348e3daeabc2d859903319ab1ef119b0c4021928cb8ae5f141d0739803d86d`. This follow-up's real UI validation is local; prior two-machine snapshot parity is recorded separately.
- Temporary instrumentation was removed, the unrelated Codex++ entry restored byte-for-byte, and task scratch files removed before delivery. No commits, pushes, version bumps or releases were performed.
