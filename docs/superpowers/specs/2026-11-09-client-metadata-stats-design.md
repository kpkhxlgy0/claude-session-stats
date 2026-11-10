# Desktop Remote Control statistics through session metadata

The user approved implementation after the live metadata probe. Keep producer-local parsing, configuration-root
resolution, numeric snapshots, TPS estimation, deduplication and UI behavior. Replace custom control-request RPC with
authenticated session metadata publication and GET. No CLI modification, prompt/message traffic, or remote paths.

## Approved difference from Codex++

Codex++ reads the producer's local snapshot through native filesystem RPC. Claude Desktop's CLI-owned bridge lacks
that extension point. The user approved storing the numeric snapshot in `client_metadata.claudepp_session_stats`.
The live probe proved root-field add, overwrite by add, independent reader visibility, sibling preservation and remove.
Existing cloud metadata fields must never be replaced. Core-native injection is no longer necessary.

## Protocol and lifecycle

- One exact namespace per session, updated with JSON Patch `test` followed by `add` at `/claudepp_session_stats`.
  Compare the original GET namespace if present, otherwise the original metadata root. A failed comparison must not
  fall back to an unconditional write. Live sequential and concurrent comparisons were verified against the service.
- Envelope fields: `protocolVersion: 1`, `bridgeSessionId`, `organizationId`, `publisherId`, `generatedAt`,
  `parent` (schema-1 snapshot or null), `agents` (array of schema-2 snapshots).
- Preserve snapshot schema and validation: 16 KiB each, 30-second age, 5-second future tolerance, identity and revision
  checks. Envelope maximum 256 KiB and 128 unique agents, matching the existing producer's child bound.
- All envelope snapshots have the same bridge, organization and publisher. Envelope generatedAt is the newest
  contained snapshot timestamp. A selected parent's age is independent of a newer child's timestamp.
- Producer reads only its existing verified snapshots. It does not parse logs again or sum parent/child totals.
- Main-process publication uses Electron net.fetch with existing cookies, the native organization/account headers,
  and the fixed Claude session endpoint. GET must confirm exact identity, bridge kind, nonshared status and connection.
- Publish at most once per session per 10 seconds, with 5-second request timeouts, two concurrent sessions, and a
  bounded scheduler. Keep 32 active scheduling entries and at most 4096 compact binding histories so rotation does
  not discard retirement/backoff. A full history refuses new network bindings instead of evicting safety history.
  Skip identical envelopes. Transient failures retain local stats and use bounded backoff.
- Stop aborts in-flight network work and prevents later writes. The last bounded cloud summary is left in place and
  expires under the existing age checks; do not race a successor publisher by issuing an unconditional delete.
- Receiver reads only GET session details with its existing authenticated page context, selects parent or exact agent,
  validates the snapshot and retains the existing replay/identity/expiry guards. It replaces displayed totals.
- Local statistics remain available without network access. No context-window indicator or change to TPS estimation.

## Scope and acceptance

Implement publication and reception in the Tweak. Remove the unused core RPC service/native compile adapters; retain
legacy SDK manifest/type compatibility where necessary so old Tweaks can continue their local statistics behavior.
No release, push, Store mutation or CLI change is included in this implementation request.

Acceptance requires producer-to-receiver fixtures for main and child snapshots, repeated reads, stale/future/foreign
data, cancellation, failed publication, and sibling-field preservation, plus fresh builds and independent review.
Live verification must distinguish this machine's automatic publisher from the other physical host, which requires
the user's later update. Never describe a fixture or synthetic marker as real two-machine stats acceptance.
