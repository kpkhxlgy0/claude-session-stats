# Claude configuration root and Remote Control stats

User-approved design: snapshots follow `CLAUDE_CONFIG_DIR` (default `~/.claude`) in a hidden `.session-stats` directory.
Claude++ core owns a session-scoped numeric stats capability; the tweak owns parsing, bounded caches, publication and display.

## Approved difference from Codex++

Codex++ uses the native `thread/read` path to derive the remote configuration root and bounded native filesystem RPC.
Claude's current REPL bridge provides neither an equivalent location resolver nor usable `get_settings` support.
The user approved core changes and a dedicated authenticated stats RPC. This avoids hardcoded user homes and generic
file permissions, at the cost of a version/hash-checked Desktop core adapter and a restart after installing core changes.
No generic remote filesystem endpoint, credential collection, model call or fallback directory probing is added.

## Implementation and acceptance

1. Publisher stores existing schema 1/2 snapshots in `<claudeHome>/.session-stats`, preserving ownership and atomic writes.
2. Core invokes the registered provider with the actual bridge session identity and cancellation signal.
3. Provider returns only the unique live parent/child binding's existing fresh snapshot. Reading never re-adds usage.
4. Receiver requests `claudepp_session_stats` protocol 1 and validates exact envelope, identity, bounds, age and replay order.
5. Local UI and remote UI share the same sample; unavailable or unsupported capability has an explicit tooltip.
6. Test custom/default roots, parent/child isolation, repeated reads, cancellation, stop, stale responses and fork integration.
7. Build both repositories, review the patch, and distinguish automated verification from actual two-machine acceptance.

Both endpoints require Claude++ 0.3.9 and Session Stats 0.8.0 or newer. The Desktop bridge adapter does not extend an
independent terminal CLI process. Old snapshot directories remain untouched. Publication of these versions was
explicitly authorized after local installation and restart verification; Store pins are managed separately.

## Verification on 2026-11-09

- Session Stats build and package validation passed; all 616 tests passed.
- Core workspace builds passed. Its full suite completed 783 tests with two outdated future-version fixtures failing;
  those fixtures were corrected for core 0.3.9, and all 19 tests in their file passed on rerun.
- Independent review found a transport-close race. The fix invalidates requests on close and on a new connection
  generation; the final review had no remaining findings. The actual hash-matched native module also passed a syntax
  check after transformation without executing the host module.
- The user completed core 0.3.9 and tweak 0.8.0 installation and restarted Claude. The restarted local runtime was
  confirmed at core 0.3.9; 101 fresh snapshots were observed under the actual Claude configuration root. Temporary
  passive diagnostics were removed from the release source.
- Live Remote Control validation of the cross-machine session remains pending the other endpoint's update. A local
  request timed out while that endpoint's installed core version was unknown; this is not a successful remote test.

## Post-release finding and approved feasibility probe

After both endpoints were updated, Desktop local Code was found to delegate its Remote Control bridge to its CLI
child. The published Desktop adapters do not intercept that path. The inspected CLI SDK/headless bridge does not
register the shared-request/read-file callbacks or forward unknown requests to its Desktop parent. The existing
RPC implementation therefore does not establish support for this Desktop Remote Control path.

The user subsequently approved testing a `client_metadata` transport and explicitly ruled out modifying the CLI.
This approved experiment differs from Codex++ by storing the numeric payload on the authenticated session service
rather than reading a producer-side file over native filesystem RPC. The live probe verified isolated-field add,
update, main-to-receiver readback, sibling preservation and deletion; see the
[validation record](../validation/2026-11-09-client-metadata-probe.md).

That approval and result covered feasibility testing only. The user then explicitly approved implementation; see the
[metadata implementation plan](2026-11-09-client-metadata-stats.md) and its linked validation. These working-tree
changes have not been released. Do not describe the existing 0.8.0 release as a completed fix for the CLI-owned path.
