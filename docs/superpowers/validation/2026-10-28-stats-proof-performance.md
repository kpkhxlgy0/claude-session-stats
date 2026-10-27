# Session Stats proof and cold-start performance

## Measured baseline

The installed v0.5.1 was profiled on the same real local worktree session. Instrumentation recorded native child-process durations, statistics API calls and only the tweak's own DOM fields. No raw transcript or credentials were exported, and no windows were moved or clicked.

- Twenty-two successful reads averaged 1965 ms (1688–2240 ms). Each launched 20 Git processes and typically 1–3 PowerShell process-identity queries.
- First valid statistics after the instrumented plugin reload arrived after 13878 ms.
- In the 65-second observation window, background work launched another 545 Git processes and 63 process-identity queries. Concurrent process durations cannot be added as wall-clock latency.
- A binding recheck called a complete workspace inspection and immediately repeated it through `verify()`. Local delivery performs checks before and after snapshot I/O, making four complete inspections per read.

## Fresh-proof change

An explicit `resolveVerified(binding)` method performs a complete fresh inspection, including final registry and canonical directory checks. The binding layer consumes that result directly while retaining its final Desktop metadata version/ancestor checks. The generic resolver's `verify()` contract remains unchanged.

Two combined Git `rev-parse` queries plus the worktree listing replace five child processes per inspection. Rechecks filter exact immutable binding IDs before expensive resolution; unresolved workspace roots are not prefiltered. Process cache TTL remains 250 ms. There is no completed-proof approval cache or sharing across a snapshot-I/O boundary.

An intermediate real 65-second observation produced 50 successful reads averaging 797 ms (536–1183 ms), six Git processes each, and no unavailable result after the first successful sample. First display still took about 7.7 seconds.

## Cold-start scheduling

Cold tracing showed 23 statistics calls before first display. The requested session was eighteenth: its collection started after 1961 ms, took 2006 ms, and first successful delivery arrived after 7631 ms. Waiting for other samples and publications added substantial delay after its own calculation.

The latest fast-read request can now receive a first publication batch when it lacks a fresh committed snapshot. Both the requested batch and the remaining batch receive complete global binding confirmation after sampling, followed by the existing per-publication checks. Samples remain deduplicated across both batches. A later global confirmation invalidates early publications that no longer match and retains an unavailable marker until the next discovery, preventing independent local fallback.

Fresh protocol-valid non-OK snapshots keep normal scheduling. Requests cannot interrupt already running collection or a priority decision already passed. The full poll is still serialized, and `completedPoll` is set only after remaining work finishes.

## Final verification

- Full `npm test`: 333/333 passed. An additional run of the affected suites under a real Windows 8.3 temporary-directory alias passed 116/116. Bundle/manifest validation and `git diff --check` passed.
- Independent review confirmed separate pre/post snapshot-I/O verification, fresh registry/PID/Git checks, generic resolver compatibility, and global confirmation for each scheduling batch.
- Review caught a possible independent fallback after an early publication was invalidated. Three regressions first failed, then passed after recording unavailability before state deletion/cleanup. The state clears only after a new initial discovery, and recovery is tested.
- With final code, an immediate native fast-read request at plugin startup selected the requested session first. Its collection began after 541 ms and took 1848 ms; the first valid API result arrived after 5642 ms. Twenty-four successful API reads over the 30-second test averaged 707 ms (557–1028 ms), with six Git processes each and no unavailable result after readiness.
- That final cold test used the actual installed publisher and real session data through its API; the Claude page was hidden. It establishes requested-session scheduling and API latency, not a foreground rendering time. The earlier 65-second foreground run of the proof optimization had 50 successful reads, averaging 797 ms, without a later unavailable result. A separate final-code hidden-window run also completed eight normal API probes successfully.
- These are same-machine measurements with filesystem caches uncontrolled; they are not universal latency guarantees. Cold generation still takes several seconds. Requests arriving after a sampling decision cannot preempt already running work.
- Temporary instrumentation was removed, the main entry restored byte-for-byte, and task scratch artifacts cleaned before delivery. Validation was completed through the local development junction on `codex/claude-stats-proof-performance` before release integration.
