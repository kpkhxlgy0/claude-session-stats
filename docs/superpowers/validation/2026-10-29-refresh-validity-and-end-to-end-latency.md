# Refresh validity and end-to-end latency

The earlier approximately one-second measurements covered a single store read. They did not measure the interval from selecting a child to receiving the first committed, validated snapshot. The user's report of more than five seconds was correct.

## Reproduced refresh failures

A fresh child sample could be discarded solely because an overlapping full discovery advanced its revision while preserving exactly the same parent binding. A deterministic regression received the old two-turn result instead of the fresh nine-turn result. The real-session baseline also recorded this discard: confirmation revision 45 was overtaken by discovery revision 46.

The publisher now retains a positive confirmation only while the latest known binding is still identical and has no newer negative evidence. An older failed confirmation cannot prune a snapshot whose exact parent was restored by a newer successful full discovery. That path preserves the earlier committed sample and does not publish the unconfirmed new sample. Real identity, workspace, metadata ambiguity and membership changes still invalidate the result.

A new foreground selection now queues its exact request immediately instead of waiting for the next two-second polling tick. Repeated reads of the same selection still share existing work. Cancellation, publication limits and snapshot expiry are unchanged.

Desktop metadata writes during a native workspace proof also rejected unchanged bindings merely because file timestamps or size changed. The added regression reproduces this with title, activity and counter updates, including a safe atomic file replacement. The correction performs at most one stable reread, compares the complete eligible declared binding set before live-workspace substitution, and retains final directory and file-version checks. It does not cache workspace proof success. RC disabling, archive/unavailable flags, CLI/bridge identity changes, declared-root changes, unsafe directories and unstable rereads remain rejected.

## Actual local request measurements

The same existing selected local child was read through the tweak's real main-process handler, publisher, workspace resolver and store. Its working directory is a verified worktree. Each measurement started with a tweak reload and sampled the foreground API approximately once per second for about 65 seconds. No prompt was sent, real transcript was modified, or user navigation performed. The native page could be hidden, so these numbers measure request-to-valid-response, not visible painting.

| Version / observation | First valid response | Reads after first success | Subsequent unavailable responses |
| --- | ---: | ---: | ---: |
| Released publisher with existing uncommitted store improvements | 15,089 ms | 22 | 0 |
| Generation and immediate-selection fixes, first run | 16,468 ms | 20 | 0 |
| Same fixes, detailed repeat | 8,612 ms | 24 | 0 |
| Final source, including harmless metadata reread | 13,883 ms | 23 | 0 |

The baseline's 15,089 ms consisted of approximately 1,767 ms before sampling, 1,668 ms collecting, 749 ms confirming parent bindings, 1,771 ms listing child membership, 3,601 ms waiting and checking before publication, 3,778 ms publishing with binding checks, and 1,755 ms until a reader received the committed result. Publication time includes workspace proofs and cannot be described as disk-write time alone.

The detailed repeat recorded 162 complete parent-binding proof cohorts for the target during 66.7 seconds of normal foreground and background work. Native process and Git worktree verification remain a substantial cost. All post-ready reads in these bounded windows succeeded, but the user's frequent active-use invalidation was not reproduced end to end in those windows. Deterministic tests establish the specific races above; these measurements do not establish a five-second cold-start guarantee or long-term absence of failures.

## Final verification

`npm test` passed all **514 tests**, without failures or skips. `npm run build`, `npm run validate` and `git diff --check` passed. The CLI proof-count test now drains the newly immediate selection refresh before measuring a subsequent read; the read itself still performs six Git calls and two fresh boundary proofs, including the post-snapshot-I/O rejection check.

Independent reviews found no remaining material issue in the publisher-generation handling or bounded semantic metadata reread. One earlier review finding about an older failed confirmation pruning a newly recovered binding was reproduced and corrected before these final checks.

The final real-session run lasted 66.8 seconds. Its first valid response took **13,883 ms**; all 23 subsequent reads were valid, taking 846–2021 ms each. Every returned revision's turns, steps, TPS and total tokens matched that revision's recorded committed child publication. There were no captured publication failures or reader invalidations in this window. This is a local API/publication consistency check, not a second-machine RC UI check. Cold latency remains unresolved at the five-second level.

The generated entry is restored after the bounded runtime observation, and the native temporary diagnostic directory is removed. Previous renderer, parent-store and resumed-subagent fixes remain present. All these changes are local and are not committed or published.
