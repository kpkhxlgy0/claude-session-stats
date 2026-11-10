# Remote statistics location discovery

The user chose `client_metadata` for the actual producer directory and native `read_file` for the selected snapshot.
They explicitly instructed us to treat `read_file` as working and not repeat its capability probe. This supersedes
the bulk numeric metadata transport and the proposed metadata request/reply mailbox. No CLI or core change.

## Contract

- Keep snapshots in the producer's resolved `CLAUDE_CONFIG_DIR/.session-stats`, defaulting to `~/.claude/.session-stats`.
- Publish only a bounded location descriptor in the existing `claudepp_session_stats` namespace: `protocolVersion: 2`,
  `bridgeSessionId`, `organizationId`, `publisherId`, `generatedAt`, and `directory`. No statistics or child list.
- Directory is an absolute Windows drive or POSIX path, normalized with forward slashes and ending in `.session-stats`.
  Reject traversal, relative paths, device/UNC paths, controls, URI forms and Windows alternate streams. Limit the
  descriptor to 8192 UTF-8 bytes and directory to 4096 characters.
- Keep the existing session/account validation, conditional JSON Patch, rate limits, cancellation, bounded scheduler,
  and publisher handover. A valid expired version 1 numeric envelope can be conditionally replaced; unknown schemas
  are untouched. Version 1 consumers do not understand version 2; both endpoints need the new tweak.
- Receiver gets the descriptor through the authenticated session GET, validates identity and freshness, derives one
  filename using `snapshotFilename(sessionId, agentId)`, and performs the existing native read-file request/response.
  It never enumerates or uploads other agents. Main and visible child panes have independent reads.
- Retain exact path/response matching, maximum snapshot size 16384 bytes, 30-second freshness, publisher matching,
  revision/replay checks, and cancellation on navigation. Native denial does not trigger another path or transport.
- Existing local generation, TPS, deduplication, fork handling, UI layout, and memory bounds remain unchanged.

## Alternatives and approved difference

Bulk numeric metadata failed with 66 samples and is not the desired on-demand behavior. A metadata request/reply
mailbox would require a new request protocol and receiver writes. The user's chosen directory advertisement reuses
native selected-file reads and keeps metadata small. Codex++ similarly discovers a producer path then reads the
selected snapshot; Claude uses metadata for discovery instead of native `thread/read`.

## Acceptance

Test actual custom/default producer roots, directory-only payload independent of child count, legacy handover,
selected parent/child requests, independent panes, malformed/stale/foreign locations, changed paths, repeated reads
without accumulated totals, and cancellation. Build, package validation, relevant full test suite and independent
review are required. No live `read_file` capability test, CLI change, Git push, Store update or release in this task.

## Release follow-up

After implementation, the user explicitly requested publication on 2026-11-10. Session Stats 0.10.0 is the release
for this directory protocol; GitHub publication and the Claude++ Store pin are now authorized. The implementation
scope above and its exclusion of native capability probes remain unchanged.
