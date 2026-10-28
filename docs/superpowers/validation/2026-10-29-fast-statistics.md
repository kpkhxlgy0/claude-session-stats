# Faster statistics validation

## Changes

Production main-process workspace resolution uses two-second process and Git association reuse. Git proof reuse requires exact Desktop/active directory identities and unchanged bounded control fingerprints, including `.git` redirection, relevant common controls and worktree registrations. Changed or uncertain controls cause native verification; unsafe/unbounded layouts are not cached. The cache holds at most 32 associations, never caches failures, and does not extend an entry's time on a hit. Git subprocesses disable optional locks.

The publisher retains its exact previously committed valid snapshot when the next confirmed collection is incomplete. It does not change the snapshot revision, generation time or 30-second expiry. Confirmed parent/child membership, identity changes, RC disabling and truly unavailable or malformed results still invalidate normally. Local and RC consumers continue to use the same published sample.

## Tests and review

The new parent/child retention tests failed before implementation and passed afterwards. They cover unchanged shared revisions, unchanged generation time, expiry and recovery, RC disabling, and child removal. The previous non-ok-publication race now uses `unavailable`, which must still reject an older success; `incomplete` deliberately retains the old sample.

The resolver suite passed 39 tests, including native Git fixtures for warm reuse, subdirectory cwd, control changes, registration additions/removals, foreign redirection, directory replacement, expiry/backward clock, unsafe/unbounded fallback and concurrent generation changes. The complete suite passed **523/523**, with no failures or skips. Build, manifest/bundle validation and `git diff --check` passed.

Independent review found no material blocker. External/global Git configuration dependencies outside the bounded controls, and process death/PID reuse invisible to registry changes, can be observed up to two seconds later. This is the requested bounded freshness tradeoff; session IDs, registry cwd and canonical workspace identities are still checked. No long-lived success cache or uncommitted local display path was introduced.

## Real same-session measurements

A direct resolver check of the previously measured relocated session took **531 ms**, with three Git calls and one PowerShell call. Two immediate repeats took **9 ms** and **7 ms**, with no native commands and the same valid evidence.

A bounded in-process probe then used the real main handler, store and publisher on the same existing child as the preceding 13,883 ms baseline. The resolver used the same two-second options as production, with a wrapper that counted native calls. Normal background publication continued. No messages, navigation or real transcript changes were generated. Requests ran approximately once per second, starting one second after tweak startup as in the baseline.

| Measurement | Result |
| --- | ---: |
| Request to first valid result | **1,097 ms** |
| Preceding same-session baseline | 13,883 ms |
| Bounded observation | 65.6 s |
| Valid reads from first success onward | 55 |
| Subsequent unavailable results | 0 |
| Successful read duration | 28–855 ms |
| Mean / median read duration | 174 / 93 ms |
| Exact revision/metric matches with published file | 55 / 55 |

Every successful read matched the concurrently observed published file's publisher ID, revision, turns, steps, TPS and total tokens. This verifies the shared snapshot consumed by RC, not an independent second-machine UI rendering. The page could be hidden, so latency is request-to-valid-response rather than a literal paint timestamp. Measurements are observations under this machine's current load, not a universal speed guarantee.

The normal generated entry was restored and runtime reload confirmed. Native-temp probes were removed. Earlier uncommitted fixes remain intact; nothing was committed, pushed or released.
