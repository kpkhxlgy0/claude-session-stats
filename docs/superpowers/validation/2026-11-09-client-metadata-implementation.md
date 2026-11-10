# Client metadata statistics implementation validation

## Implemented scope

Session Stats working version 0.9.0 publishes verified producer snapshots through the authenticated session API and
reads them from the receiving page. No CLI changes, model messages or credentials extraction are involved.
The Tweak works on the existing Claude++ 0.3.9 runtime. The core working tree separately removes the obsolete native
RPC adapters while retaining legacy SDK/manifest declaration compatibility. Nothing was committed or published.

The former probe-only approval was followed by the user's explicit implementation request. The approved design and
implementation scope are recorded in `../specs/2026-11-09-client-metadata-stats-design.md` and the matching plan.

## Final automated verification

- Tweak `npm run build`, `npm test`, `npm run validate`: 675 tests passed, zero failures/cancellations/skips.
- Core `npm test` (including the four-workspace build): 770 tests passed, zero failures/cancellations/skips.
- Both working trees passed `git diff --check`; the final generated Tweak entry matches its source.
- The existing configuration-root, fork/continuation, local/subagent, corruption-recovery and deduplication tests remain.
- Metadata integration uses the real source publisher, real HTTP publisher, real receiver and an in-memory session API;
  it covers parent/child samples, repeated reads, namespace isolation, expiry and successor publication after restart.

## Independent review and corrections

Review found and closed three issues before acceptance:

1. A GET-to-PUT race could overwrite a successor. PUT now uses a server-checked JSON Patch `test` of the original
   namespace (or metadata root if absent), followed by `add`. A failed comparison never falls back to an unconditional write.
2. Active-window eviction could forget a publisher's retirement/backoff. A separate bounded history retains these
   records across windows and temporary binding removal; capacity exhaustion refuses new identities rather than evicting them.
3. A newer local `unavailable` commit could be hidden by a previously read `ok` sample. Final batch export now rejects
   that stale success while retaining the existing valid newer-`ok` heartbeat behavior.

The reviewer independently reran 41 writer tests and the two new source race tests. No remaining material findings.

## Live service and installed Tweak checks

The real service accepted matching namespace and root comparisons. Stale comparisons returned HTTP 400 without
applying the following write. In four simultaneous two-writer trials, each round returned exactly one HTTP 200 and
one HTTP 400; subsequent GET retained the successful writer and preserved unrelated fields. All test fields were removed.

After the final implementation, the installed development Tweak hot-loaded successfully. A read-only diagnostic
waited through publisher handover, inspected the existing source instance, and fetched its real server metadata:

| Local producer binding | Connected | Fresh parent matches local stats | Published child snapshots |
| --- | --- | --- | --- |
| A | yes | yes; TPS about 102.20 | 2 |
| B | yes | yes; TPS about 64.04 | 6 |
| C | yes | yes; TPS about 83.26 | 52 |
| D | yes | yes; TPS about 66.60 | 3 |

All four envelopes matched the current producer ID and passed the production protocol. Seven other local bindings
were disconnected and did not expose fresh metadata. Actual session/account identifiers are omitted from this record.

The currently selected conversation runs on the other physical Desktop. Its production receiver completed GET and
returned `snapshot-missing`, not a control-request timeout. That runner has not yet installed this implementation;
its real cross-machine statistics acceptance remains pending that update. This is not a claim that its values display yet.

Temporary diagnostic hooks were removed; Main was restored byte-for-byte to the implementation tested above. All
ad-hoc scripts, locks, backups and reports in the native temporary directory were removed. The four producers' normal
numeric metadata remains as intended; stopped producers' last summaries expire after 30 seconds instead of being deleted.

## Remaining limits

No GUI automation or visual layout acceptance was performed. No GitHub/Store release or installed-core update was
performed. Service compatibility remains dependent on the existing session API; unsupported comparisons fail closed.
The scheduler retains 32 active slots and 4096 histories, and the metadata envelope has 128-agent/256-KiB limits.
