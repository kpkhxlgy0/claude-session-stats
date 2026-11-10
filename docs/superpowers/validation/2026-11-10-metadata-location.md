# Metadata location transport validation

## Scope

The user selected metadata-based path discovery followed by native selected-file reads, and explicitly directed
us not to repeat native `read_file` capability testing. This changes only the Session Stats tweak. Core, CLI,
statistics formulas, parsing/deduplication and UI layout are unchanged. No release or Store update is included.

## Verified behavior

- Producer exports its actual resolved snapshot directory and a verified parent snapshot's timestamp/publisher.
  Custom `CLAUDE_CONFIG_DIR`, environment default and unset-environment home fallback all have direct tests.
- A 65-child fixture returns the same small directory descriptor without enumerating, recalculating or reading
  those children for metadata. The bulk `readRemoteSnapshots` export was removed.
- Metadata version 2 has six fields and an 8192-byte bound. Legacy version 1 is parsed only for migration;
  expired known metadata is replaced with exact conditional JSON Patch while sibling fields remain intact.
  Fresh foreign publishers, retired writers, unknown schemas, failed comparisons and source cancellation stay protected.
- Receiver derives the selected parent/agent filename from that directory and correlates the native read response.
  Windows case/separators and POSIX path identity are tested. Traversal, unsafe roots, oversized descriptors,
  mismatched response paths/identities/publishers, stale samples and replayed revisions are rejected.
- Metadata is rechecked after the file response. A changed directory/publisher cannot lend its authority to an
  earlier read. Multiple readers and switching a selected child preserve independent request lifecycles.
- Integration fixtures use real temporary JSONL and snapshot files with an emulated authenticated service/event
  transport. Parent and child values match local publication across worktree changes, continuation, fork history,
  repeated reads and publisher restart. No repeated read adds token usage or turns.
- During restart, a new file publisher cannot be accepted under the old metadata owner. The receiver waits until
  the previous descriptor expires and the new descriptor is conditionally published.

## Commands and evidence

Test-first failures established missing location APIs/transport before implementation. The new source test failed
with `readRemoteLocation is not a function`, then passed. Reader directory/selected-file tests failed against 0.9.
Protocol/writer tests likewise failed before location support; a POSIX backslash identity regression was separately
observed failing and corrected.

- `node --test test/snapshot-publisher.test.cjs`: 97 passed.
- `node --test test/metadata-protocol.test.cjs test/metadata-publisher.test.cjs`: 55 passed.
- `node --test test/remote-reader.test.cjs`: 42 passed.
- `node --test test/snapshot-integration.test.cjs test/fork-snapshot-integration.test.cjs`: 8 passed.
- `npm run build`: passed.
- `npm run validate`: manifest, package, renderer and installation entry points passed.
- `npm test`: 691 passed, zero failed/skipped/canceled.

These are automated fixture results, not a claim of newly verified cross-machine behavior. Native `read_file`
capability was intentionally not probed. Both endpoints need the new directory-aware tweak; 0.9.0 readers cannot
consume version 2 location metadata. Existing source-hash-pinned 0.9.0 diagnostic scripts remain unchanged.

Independent review found no actionable material findings in the producer, migration, directory validation,
native event correlation, cancellation or pane lifecycle. `git diff --check` passed with only repository line-ending
normalization notices. No ad-hoc temporary artifacts from the canceled size probe remain.

The user subsequently authorized publication as 0.10.0. Release preparation changes version metadata and release
notes only; implementation verification above remains applicable. Final release checks additionally rerun the
build, package validation and full suite, and require Windows/Linux CI plus public Store read-back.
