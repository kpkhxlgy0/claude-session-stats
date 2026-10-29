# Corrupted snapshot automatic recovery validation

## Reproduction and behavior

A real parent snapshot contained 487 zero bytes, and eleven child snapshots contained 501–507 zero bytes. Original session logs and the live workspace binding remained valid. The previous publisher rejected these files as unknown ownership and never replaced them. Manual preservation had already restored the live session before this implementation.

The publisher now recognizes stable, bounded, single-link regular files that cannot be decoded as UTF-8 JSON, including zero-filled, empty, whitespace-only and truncated files. Recovery is only available in serialized publication when the new sample is protocol-valid and `status: ok`; independently valid metrics with incomplete usage retain their normal behavior. Parseable unknown/foreign JSON and unsafe paths remain protected.

Recovery creates or verifies an exact-byte backup under the managed `corrupt-backups` directory, named by original basename and SHA-256 digest. Backup bytes and the recovery replacement are synced before atomic replacement. Existing backup conflicts are preserved. Directory, binding, child membership and unchanged destination checks run around recovery. Read/cleanup paths do not repair files, and publisher shutdown does not remove backups.

Partial backup cleanup is restricted to a file created by this attempt whose write did not complete, whose bytes are an exact strict prefix of the intended payload, and whose identity/version and directories remain unchanged. Independent review found the original cleanup could delete an external in-place rewrite; two additional failing regressions reproduced unrelated rewrites and post-write truncation, and both were fixed before final verification.

## Verification

- **565/565** tests passed, without failures or skips: 523 existing tests plus 42 recovery tests.
- Coverage includes parent/child cold and live recovery, exact backup bytes, empty/truncated/invalid UTF-8 input, valid foreign JSON, unsafe/linked/multiply-linked/oversized/changing paths, backup/replace/sync failure, retry/restart reuse, stop/binding/root/membership changes, concurrent readers, and unrelated backup preservation.
- Build, manifest/bundle validation and `git diff --check` passed. Normal valid publications do not traverse backup directories or add recovery sync calls.
- Independent final review reported no remaining material finding.

All twelve preserved real corrupt payloads were replayed in an inert native-temp workspace with a separate fixture Desktop mapping. Statistics were sampled read-only from the real parent and eleven child logs, then passed through the production publisher. All twelve files recovered, every backup matched the original bytes and original recorded hash, and local metrics/revisions matched the corresponding regenerated snapshot. Retry and shutdown left exactly twelve backups. The final replay took 171 ms after sampling; this is fixture recovery time, not a real UI latency guarantee.

No real session was intentionally corrupted and no source transcript was modified. The temporary replay directory was removed; the original manually preserved diagnostic backups remain in the user's managed statistics directory. The live development link loads the modified source. Changes remain uncommitted and unpublished.
