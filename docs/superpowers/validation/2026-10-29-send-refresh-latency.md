# Prompt submission refresh and parent read latency

## Reproduced causes

- Replacing the composer in the same session destroyed its existing footer and created a placeholder while the next stats request was pending. A brief detach/remount also removed the footer. Deterministic renderer tests reproduced both failures before the change.
- A normal log append racing the final collection check raised `ESTALE`, which unconditionally reset the metrics and cursor. A regression read two new records but parsed four records because earlier turns were read again.
- A real relocated parent session used approximately 29 MB and 19 MB source copies. Cold collection took 2073 ms and parsed 3388 records. Warm collection parsed zero records but took 1826, 2130 and 2480 ms; each warm read ran 15 Git processes and 3–4 PowerShell queries. Repeated workspace verification dominated these reads.

## Changes

The renderer reuses the existing footer only for the same session. A visible composer transition can retain its bar for at most 1500 ms; hiding the page/composer or changing routes still clears it. Explicit unavailable or mismatched statistics still clear usable numbers. Root-bound request tokens reject delayed success/failure and cleanup from an earlier composer, including A → B → A DOM reuse.

An `ESTALE` retry retains the incremental cursor. The next read still resets on file replacement, truncation, same-size rewrite or changed prefix guards, and source/fork/version checks run again. Continuous appends that never yield a stable sample remain incomplete. The append regression now parses only the two new records; replacement and continuous-write cases remain covered.

Parent reads use an operation-scoped context with two original caller verifications, before and after the complete operation. Internal source, directory, relocation and file-version checks remain active. Private immutable sample proofs are independent of a later poll mutating the cache entry. Shared waiters verify their own context and source candidates; new candidates discovered by a waiter receive their own final file/directory proof. No paths or callbacks are added to public statistics, and no successful authorization result is cached across operations.

The final callback-free checks preserve supported unique-log hard links and configured project-root aliases. Directory identity includes the link, resolved target and canonical location; replacing the directory or target is still detected. Duplicate-source resolver restrictions are unchanged.

## Measurements and checks

The same real session after the parent proof optimization returned valid statistics in 892 ms cold, then 985, 640 and 1659 ms warm. Warm reads parsed zero records and ran six Git processes plus 1–2 PowerShell queries. The three-read warm average fell from 2145 ms to 1095 ms, about 49%. The session continued to grow between measurements; filesystem caches and concurrent background load were not controlled, so this is a same-machine observation rather than a universal latency guarantee.

Regression coverage includes composer replacement/gaps, navigation, old request rejection, A → B → A reuse, incremental append retries, replacement, continuous writes, caller context mutation, changes during the final proof, concurrent waiters, candidate-set expansion, directory replacement and disposal. Independent review identified the A → B → A request race and the new-peer waiter gap; both were reproduced failing and then fixed.

The before/after measurement used read-only source access. No messages were sent to the real Claude conversation and no real logs were modified. Prompt-submission DOM changes were reproduced in the renderer fixture; a real human-triggered send was not claimed as an automated end-to-end test. The earlier large-background/remote-demand limitation remains outside this change.

Final verification: `npm test` passed **486 tests**, with no failures or skips. `npm run build`, `npm run validate` and `git diff --check` passed. The app's runtime log confirmed that the newly generated entry was reloaded through the existing development link. The temporary measurement directory was removed; no runtime diagnostic hook was installed. The changes are not committed or published.
