# Claude fork inherited TPS validation

Date: 2026-10-25 (Asia/Singapore). Installed Claude Desktop: 3.6556.2.0.

## Implementation and checks

- Desktop fork: verify native parent metadata and the copied message prefix; preserve original timestamps and exclude the cutoff record.
- SDK fork: follow per-record provenance to original timing; avoid counting rewritten fork timestamps and replay twice.
- Independent TPS accumulator; existing non-TPS scopes and relocated-log behavior remain intact.
- Both consumers use the runner's existing snapshot format. The receiver still reads only the snapshot.
- Full tests: 255 passed, 0 failed/skipped. Build, package validation and whitespace checks passed.
- Independent review fixed three issues: legacy flat metadata layout, cached null ancestor metadata, and attachment source UUID cutoff aliases. Final review reported no remaining P1/P2.

## Native observations

A dedicated idle validation fork was created with Desktop's native fork API in an existing workspace. No worktree was created. The initial inheritance checks below sent no model message; the later RC acceptance sent exactly one message after explicit user authorization. The original transcript SHA-256 remained unchanged throughout.

| Observation | Parent TPS | Fork TPS | Cold fork read |
| --- | ---: | ---: | ---: |
| New local native fork, 21.65 MB copied transcript | 72.0138502265379 | 72.0138502265379 | 479 ms |
| Existing native fork on the other machine | 72.49224466077544 | 72.49224466077544 | 1,384 ms |

The local fork's warm read took 80 ms. These are two different sessions, not a cross-device comparison of one session.

Seven runtime files were synchronized to the other machine after verifying their installed v0.4.1 baseline, checking each previous hash before writing, and checking readback bytes. Temporary diagnostics were removed; release/version/commit operations were not performed.

## Completed real RC acceptance

Production main → store → publisher → local snapshot → RC receiver integration tests cover both native copy and SDK rewrite formats, continuation, parent appends, restart, and missing ancestry. Same-revision scalar fields match exactly.

The user explicitly authorized one message in **Session Stats｜Fork 继承 TPS 验证**. Desktop's native `sendMessage` sent `只回复 OK` once; the transcript contains one new user message and one assistant reply, `OK`. Native RC enable returned success. The validation branch remains available with RC enabled.

The new response produced 4 output tokens over 3,395 ms. Reading the original parent's valid samples independently yielded 583,755 output tokens over 8,106,149 ms. Their combined weighted average is `(583755 + 4) / ((8106149 + 3395) / 1000) = 71.98419541222047 TPS` (floating point rounding within 1e-10).

The receiving machine executed its installed production RC reader in its authenticated Claude frame, bound to this real bridge session. The diagnostic supplied the target route while retaining the real document/organization context and native fetch; no UI navigation or fabricated network responses were used. It performed the actual RC `read_file` request against the runner's snapshot.

| Field | Running machine | Receiving machine |
| --- | ---: | ---: |
| Snapshot revision | 218 | 218 |
| TPS | 71.98419541222047 | 71.98419541222047 |
| Branch turns / steps | 1 / 1 | 1 / 1 |
| Branch output tokens | 4 | 4 |

All 13 scalar/status/version fields matched exactly, including publisher ID and generation timestamp. The receiver completed the real RC read in 1,356 ms. The existing renderer formats this TPS as approximately 72 tok/s; a separate visual layout/screenshot check was not performed. Temporary hooks were restored byte-for-byte, with no commit, push or release.
