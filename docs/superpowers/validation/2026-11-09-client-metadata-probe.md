# Desktop Remote Control client_metadata probe

## Scope and approval

The user explicitly approved a feasibility probe of `client_metadata`, without modifying the CLI.
This is a transport experiment, not an implemented or released Session Stats fix.

Codex++ reads the producer's local numeric snapshot through native authenticated filesystem RPC. The proposed
Claude difference is to publish the same kind of numeric snapshot to session metadata and read it through the
existing authenticated session API. Configuration paths remain producer-local. This probe approval does not
authorize replacing the production transport or publishing a new version.

## Observed environment and method

- Claude Desktop 4.23118.0, Claude++ 0.3.9, Session Stats 0.8.0, Windows.
- Used the already selected, connected, nonshared Remote Control bridge session. A disposable bridge could not be
  shown to avoid starting a worker, so the probe used unique temporary top-level metadata fields on the target session.
- Temporarily attached a one-shot diagnostic through the existing Tweak hot reload. CLI and installed core were unchanged.
- Writer: Electron main-process `net.fetch`, native session URL and current cookie authentication.
- Independent reader: the receiving page's `fetch`, current cookie authentication, no-cache session GET.
- Both readers checked the exact session ID and bridge kind. Requests supplied the existing organization header.
- PUT body: `client_metadata_patch`, with `add` or `remove` targeting a single random probe namespace.
- No full metadata replacement, model messages, token extraction, UI input, or conversation-body logging.
- Synthetic payload included integer counters, fractional TPS/cache hit, booleans, null, nested child-agent data,
  a unique marker, and a revision. No actual conversation statistics were published.

## Live results

| Check | Observed result |
| --- | --- |
| Main-process and receiving-page GET | HTTP 200; same target bridge, connected, nonshared |
| Single request containing add then remove | HTTP 200; no field remained; treated only as preflight |
| Add revision 1 | HTTP 200; main GET returned the exact complete synthetic value |
| Receiving-page read of revision 1 | Two independent GETs returned the exact complete value |
| Update same path with `add`, revision 2 | HTTP 200; main GET returned the new complete value |
| Receiving-page read of revision 2 | Two independent GETs returned the new complete value |
| Remove probe field | HTTP 200; subsequent GET confirmed absence |
| Preserve a nonempty sibling field | Separate probe added two namespaces; writing/updating one preserved the other |
| Removal isolation | Removing the first namespace preserved the sibling; removing the sibling cleared both |
| Final cleanup | Main and receiving-page GET both returned an empty metadata object |

The first round trip reported `roundtripPassed: true`, `cleanup.fieldAbsent: true`, and
`cleanup.otherFieldsUnchanged: true`. The additional isolation probe reported `siblingIsolationPassed: true` with
the same cleanup checks. Comparisons used canonical complete values and hashes excluding only probe-owned keys.

Initially the session response omitted `client_metadata`; after cleanup it returned `client_metadata: {}`.
All temporary test fields were removed. Existing session metadata fields were initially absent, which is why
the separate two-field isolation probe was necessary. No attempt was made to reset the empty container by
overwriting metadata or to undo ordinary server-managed update timestamps.

## Review, restoration and limits

Independent review corrected two issues before write execution: cleanup must work after page navigation, and
an add/remove no-op cannot prove persistence. The durable round-trip script then passed focused review and syntax check.
Cleanup read the fixed session and removed only a field whose marker matched this probe.

The temporary hook was removed and `src/main.cjs` restored byte-for-byte to SHA-256
`2187a5591fa71f33cf2a49767199806fdfe69e494bd4b9f9cb83d5f82648a381`.
Temporary scripts, result files, locks and the backup were removed after recording these results.

This proves the current service accepts, persists, updates, exposes and removes an independent metadata namespace
using Desktop's existing authenticated HTTP access. It does not prove an automatic publisher on the other physical
machine, actual stats UI integration, long-running refresh behavior, concurrent writers to the same namespace,
payload limits, rate limits, or behavior after future Claude/service upgrades. No production transport or release
was changed; the existing custom-RPC path still does not handle Desktop local Code's CLI-owned bridge.
