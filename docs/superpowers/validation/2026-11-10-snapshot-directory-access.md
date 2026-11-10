# Automatic snapshot directory access validation

User request: remove the need to type `/add-dir` for every existing or new Remote Control session. Native Desktop 4.23118.1.0 exposes `window['claude.web'].LocalSessions.addDirectories(localSessionId, [directory])`. It persists a session grant and asynchronously pushes `apply_flag_settings` to an active CLI. No global settings or project files are edited.

## Live evidence

On 2026-11-10, the running machine had 26 eligible RC-enabled local sessions. Before the change only one had the private snapshot directory in its session permission updates. After hot-loading the controller, all 26 had it. Native logs recorded 25 accepted additions and the existing grant. The active CLI PID 48748 remained the process started at 08:41 local time.

At 11:29:25 local time an authenticated native RC `read_file` request for bridge `session_01Dm7U4Gh5kTfHr8GQwVEGci` returned the exact published parent snapshot. Response path, publisher identity and complete numeric statistics matched the local snapshot: 299 turns, 2098 steps, TPS 65.56071614739773. This is a real native event round trip through the existing session transport; no prompt/chat message was sent. The other computer's rendered UI was not directly inspected.

Temporary diagnostic code was loaded through the existing local development tweak and returned only correlation/identity booleans and numeric statistics. Early attempts were invalidated by concurrent development hot reloads; another diagnostic-only comparison omitted native `cse_` to `session_` ID normalization. The production reader already performs this normalization. The final successful attempt used a current source, normalized identity and matching published metadata. The temporary require was removed, and both diagnostic source/result files were deleted without Force and verified absent.

## Automated evidence

Producer tests failed first for missing access APIs, then passed. A review found that a newly duplicated local identity needed a fresh global identity scan; its regression failed before the scan was added and passed afterward. Startup/stop integration tests likewise failed before the controller was connected.

Controller tests exercise real serialized page scripts in a VM with native-shaped API boundaries. Coverage includes old/new bindings, exact directory restrictions, stale identities, source rejection, trusted frames, native unavailability, historical bridge aliases, deduplication, bounded retries, and stopping pending work. Independent review additionally identified alias/frame rotation starvation and delayed queued apply after timeout. Dedicated regressions failed before the fixes, then passed: each session now completes its frame cycle before advancing its bridge alias; queued scripts remain cancellation-tracked until actual settlement and expire before any native call. Cancellation is tested independently of expiry by holding the renderer clock fixed.

Already-present native grants avoid disk/Git proof; fresh producer identity and directory verification remains immediately before each mutation. This behavior has a regression test.

Final checks after all code changes:

- Controller: 29 tests passed.
- `npm run build` and `npm run validate`: passed.
- `npm test`: 726 passed, zero failed/skipped/cancelled.
- `git diff --check`: passed.
- Final loaded controller logged all 26 grants as present; CLI PID/start time remained unchanged.
- At implementation acceptance the core checkout remained clean and no commit, push or release had been performed. The user's subsequent release request is packaged as v0.10.1; release preparation reran the full 726-test suite, build and manifest checks successfully.
