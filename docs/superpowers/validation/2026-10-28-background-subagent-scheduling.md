# Background subagent scheduling and RC demand-channel investigation

## Reproduced regression

The v0.6.0 publisher expanded all children before publishing parents and serialized the complete discovery/sampling/confirmation/publication sweep. Parent and selected-child requests also shared one priority slot. Real snapshot timestamps exceeded the protocol's unchanged 30-second lifetime, so valid source data became unavailable to local and RC readers.

Read-only measurements on Windows, Claude Desktop 3.6556.2.0 and CLI 2.1.308:

- Discovery found 24 parent bindings in approximately 423 ms.
- One active worktree parent had 22 children at the initial sample (23 later). Individual child reads took 2179–2496 ms and launched 27 Git processes plus 4–5 PowerShell identity queries each.
- Another parent had 35 children. Its sampled child reads took 85–89 ms without Git/PowerShell calls.
- Both parent sources returned normal statistics independently. The problem was scheduling and repeated proof work, not missing transcripts.
- The previous 32-child cache was smaller than the observed working set. In one later observation, the root and worktree contained 135 and 23 child snapshots.

## Implemented direction

Keep background publication so existing remote receivers remain compatible. Separate parent, child, foreground-parent and foreground-child scheduling; use bounded child batches, publish small completed groups, and preserve exact binding checks, per-destination serialization, monotonic revisions and actual sample timestamps. Do not extend freshness or replace failed shared snapshots with independently calculated local numbers.

Child storage accepts at most eight IDs per batch. It shares parent-source location/proof within that batch, retains fresh pre/post verification, checks each child identity and final file version, and shares overlapping reads of the same child. The cache holds up to 256 children; idle incomplete-line and guard buffers have a 16 MiB aggregate budget. Parsed transcript bodies are not retained.

Two reads of eight real worktree children took 2625 ms and 2420 ms total. They launched 24 Git processes per batch and five/four PowerShell queries. The second read parsed zero additional transcript records. These are same-machine observations with uncontrolled filesystem caches, not universal timing guarantees.

The first concurrent-publication candidate failed sustained acceptance: foreground child snapshots still crossed 30 seconds, background child samples exceeded 60 seconds, and the selected child API returned unavailable after initially becoming ready. A 65-second profile recorded 1107 Git processes, 93 PowerShell queries, 1093 binding rechecks and 85 global discoveries. Concurrent durations are not additive wall-clock time. A child batch that took about 2.6 seconds alone reached 6.6 seconds under this load. This ruled out treating publication concurrency alone as the fix and identified repeated concurrent identity proofs as the next bottleneck.

Subsequent changes merge only checks waiting for a future proof, never callers arriving after that proof started. Completed proof results are not approval caches. Unchanged samples before their heartbeat skip publication entirely without renewing the old timestamp. Each child completes its own flight after all of its bridge destinations finish, independently of a slower sibling. A foreground child uses an exact safe file read and retains post-sampling membership confirmation instead of also enumerating every sibling before sampling.

Each batch/discovery now owns a short-lived operation context. The expensive original workspace proof runs once before and once after the operation; internal source callbacks retain all source, directory, relocation and version validation without repeating the same outer proof. The context expires in `finally`, rejects changes to its root or verification callbacks, and is not stored as approval across calls. Unique and duplicate-source cold/warm reads and directory discovery all have regression assertions for two original context checks. Review caught an ordering error: the final original context check must follow source callbacks. It is now followed only by callback-free directory, all parent-candidate and child-file version checks, covering both late binding revocation and source changes during the final Git inspection.

## RC demand-channel evidence

The investigation used bounded read-only probes through the already authenticated, exact target session. It did not read/export credentials, send chat messages, create pages, modify remote files or install a new CLI control handler.

- Existing CLI code confirms `read_file` control requests. No supported arbitrary write/notification handler was established.
- A bounded history query saw eight matching snapshot `read_file` requests among 32 events. This establishes historical visibility only.
- A subsequent 24-second observation started at the newest cursor, saw five new events and two matching requests, and paired one native success response and one native error response. Two repeated GET batches at the same cursor returned the same observed events. The successful native response demonstrates that this particular concurrent observation did not prevent normal handling; it does not prove every future delivery/acknowledgement scenario.
- A separate main-process probe successfully fetched the target session and its latest event through the exact existing WebContents Session's `fetch()` API. No target-page JavaScript was used for that probe. The installed app reported Electron 44.9.3.
- No existing independent non-target page was available for the planned alternate-page test. Closing the target page, background Session lifetime, logout/account switching and reconnect behaviour remain unverified.

A future demand channel can observe existing snapshot reads, validate the exact organization/session/child path, and renew a short-lived demand lease. Missing-snapshot requests must also establish demand; receivers then use their normal retry. This is a moderate change involving a bounded event observer/cursor, lease deduplication/expiry, scheduler priority and account/reconnection cleanup, with corresponding tests. It does not require inventing a new RC command, but the lifecycle checks above must be resolved before replacing background publication. No production demand channel is enabled in this change.

## Disappearing child overlay

The user also observed that the entire child bar could disappear permanently. A read-only inspection of the actual visible task pane found a valid pane key but zero bars and an empty binding result. The old depth-first Fiber traversal reached exactly its 3000-node budget (2979 visited, 21 queued) before reaching the selected detail control. Retrying the same long transcript therefore could never recover the binding.

Bounded structural inspection found the selected view/detail controls outside the message-render subtree. The native AssistantMessage hosts had matching `data-cds="AssistantMessage"` in committed props and DOM. An optional `data-cds-bubble-stack` prop was present but undefined, so that DOM attribute was absent; a first fixture-only predicate using that attribute was insufficient and was corrected after a failing native-shape regression.

The reader now excludes only the descendants of verified message presentation hosts. The host must belong to the exact pane in both DOM and committed Fiber ancestry, have an unambiguous current host binding and matching presentation markers. Boundary props and all surrounding view/detail conflicts remain checked; unknown oversized control trees still fail closed at the original limit. Regression coverage grows a previously visible pane to 3101 body nodes, polls repeatedly in both local and remote modes, rejects a conflicting sibling control, then verifies recovery after the conflict is removed.

The live pane subsequently returned the exact selected child binding and one mounted statistics bar. Numeric readiness and sustained refresh are checked separately below; mounting a placeholder alone is not accepted as data recovery.

Examining every sample, rather than just the final successful samples, exposed a second binding failure: four of seventeen samples lost the bar while the exact stats API remained valid. React bailout reused children between current and alternate pane trees, so upward-only `committed(host)` could disagree with the message node reached by traversal from the already committed pane. The final predicate accepts only that visited host or its reciprocal same-DOM alternate, within the same React root family and the current pane or its reciprocal same-DOM alternate ancestry. The root pane's committed test, message markers and all control identity checks remain. Local and remote fixtures flip both committed roots and DOM host pointers six times; wrong hosts, unpaired alternates and foreign roots remain rejected.

## Background scaling limit

Full metadata uniqueness checks are retained, while a post-sampling batch resolves only its target workspaces. Complete discovery still owns the parent catalogue; partial negative evidence is ordered by generation, and explicit global metadata contradictions still invalidate affected sessions. A lost workspace proof forgets all owned paths in that parent family without reopening old child snapshots.

This improves foreground independence but does not establish a 30-second refresh guarantee for every idle child. In the large real workload (six parent snapshots and over 160 child snapshots), some unselected child files still exceeded the existing TTL. A bounded experiment with four child families and eight concurrent publications also failed that guarantee and was reverted to two families/four publications. The full-background limitation remains explicit; a future remote demand lease is the appropriate next extension rather than marking stale files fresh or declaring all remote child scenarios fixed.

## Final acceptance

- Final `npm test`: **466 passed**, zero failed, cancelled or skipped. Bundle/manifest validation and `git diff --check` passed. Independent final reviews found no remaining material findings in the accepted code.
- The final real page observation lasted approximately 80 seconds and collected 17 samples. All ten samples while the page was visible had exactly one selected-child binding and one child bar. Seven samples were explicitly `document.visibilityState === 'hidden'`, where cleanup is expected; these are not failed binding samples. Of the visible samples, seven were numeric, two were initial cold placeholders and one was the immediate visibility-return placeholder.
- The selected-child API became ready at 9676 ms, then succeeded on all 14 subsequent samples, with zero unavailable results after readiness. All 14 matched the exact published snapshot version and values; maximum observed age was 20003 ms. Its final value was one turn, 117 steps and 52.0661 tok/s (displayed as approximately 52).
- The parent API had 13 successful samples, all matching their exact published snapshot, and one unavailable sample after initial readiness. This result is not described as uninterrupted parent availability. Its successful samples remained below the TTL (maximum observed age 18777 ms).
- These are local UI/API and shared-file observations. The RC event-channel probes above establish bounded transport feasibility, not a full second-machine UI acceptance test. No claim is made that every idle remote child remains fresh under the observed workload.
- The production entry is restored to its original generated content and checked by hash at delivery. Temporary probes are disabled and the task's native-temp scratch directory is removed before delivery. The change remains uncommitted and unpublished.
