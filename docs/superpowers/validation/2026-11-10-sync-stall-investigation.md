# Remote statistics refresh investigation

The user reported that both endpoints were updated, and subsequently confirmed that the running Desktop still shows
local statistics. Initial investigation and the subsequently supplied producer log are distinguished below.

## Verified observations

- This receiving machine runs Claude++ 0.3.10 and Session Stats 0.9.0 at commit
  `c6b08ceb7c678b9f9051dab718cade5cf85a4bd6`. Installed Runtime SHA-256 matches the release build.
- Native Desktop has updated to 4.23118.1. The receiver identifies one visible composer and one organization.
- Session GET succeeds with HTTP 200 and identifies the expected connected, nonshared bridge. Its statistics
  namespace passes structural validation. The selected session is not a local producer binding on this machine.
- Five GETs over approximately one minute returned the same parent revision 106, 299 turns, 2098 steps, TPS about
  65.56 and 32 child snapshots. The timestamps did not advance. The actual receiver returned `snapshot-expired`.
- A later probe sent only JSON Patch `test` operations against the exact existing namespace. Both one-test and
  two-test requests succeeded with HTTP 200 in about 361 ms; request sizes were 16,823 and 33,619 bytes. The
  namespace's canonical digest was unchanged. This did not replace, refresh or fabricate any statistics.
- Those checks used this machine's authenticated context, including its expected-account header. They do not prove
  that the other machine's cookies, account binding or requests are correct. Test-only PUT may update server-managed
  session bookkeeping timestamps; these must not be mistaken for a producer statistics update.

## What remains unknown

Local UI values alone do not prove that a Remote Control binding or published snapshot exists: Main can fall back to
its local session store when `readLocal()` returns null. The producer can also skip a null/invalid candidate, reject
an ownership or revision change, time out while reading a batch, or fail its HTTP request. Current production code
does not record these distinct outcomes.

Static review identified these paths but did not prove any occurred on the target producer. JSON key ordering is
normalized by the protocol and is not evidence of a comparison bug. No timeout, age limit or identity rule has been
relaxed, and no production behavior change has been made as a speculative fix.

The next required evidence is one target producer publication attempt: binding presence, source read duration and
candidate outcome, ownership/revision decision, and GET/PUT status. A bounded, reversible producer-side diagnostic
is available in `scripts/Diagnose-RemoteStats.ps1` and `scripts/diagnose-remote-stats.cjs` because this chat cannot
directly read the other machine's process or logs. The ZIP beside them contains the exact reviewed scripts.

## Diagnostic-tool verification

- Defaults to 90 seconds, requires PowerShell 7.3+, and is restricted to the known 0.9.0 source hashes.
- Temporarily observes the existing factory; it does not create a second publisher or issue extra network requests.
- Logs fixed stage names, numbers and hashes; no authentication data, URLs, paths, messages or complete metadata.
- A mock factory invocation made exactly one source read and the original GET/PUT pair, with all expected stages.
- Two isolated APPDATA executions verified normal byte-exact restoration and preservation of a concurrent user edit.
  They intentionally had no running app and correctly reported `diagnostic-not-loaded`.
- Independent review corrected default-enabled configuration handling and PowerShell byte-array overload compatibility.
  The final explicit byte-array write/restore function smoke and syntax checks passed; no review findings remain.
- Temporary fixtures and local cloud probes were removed. Actual Tweak production files remain unchanged from release.

The wrapper's temporary insertion and removal both hot-reload the Tweak, so it cannot establish the private cache or
retirement state that existed before insertion. The following evidence was received after preparing that diagnostic.

## Supplied producer log

The user's 275-line log reproduced a failure even after the writer reset:

- Initial candidate: one parent snapshot, PUT 200.
- Three later candidates: 66 snapshots (one parent and 65 agents), PUT 400 each; session GET remained at the first value.
- Local source reads took 2129, 1570 and 1941 ms. All candidates passed validation and replacement checks; there were
  no lower revisions, older timestamps or changed values at the same revision. Binding count was 26.
- This locates the stall at the server rejecting bulk publication. The log contains no error response body, so it
  does not establish an exact array-count or stored-metadata-size limit. Earlier large test-only requests did not
  prove that equally large metadata values could be persisted.

The user rejected bulk synchronization: only the currently viewed parent or child should be transferred. They then
chose metadata for the real producer directory and the previous native `read_file` path for the selected file, and
explicitly said not to repeat the `read_file` capability probe. The unexecuted temporary size-probe script and backup
were removed. No limit probe or native capability probe was run for this change.

Implementation and acceptance follow `../plans/2026-11-10-metadata-location.md`. The old diagnostic ZIP intentionally
targets only the published 0.9.0 source hashes and is not a diagnostic for the new location transport. No release or
Store update is included in this follow-up.

After that implementation was completed and reviewed, the user requested publication as 0.10.0. The old diagnostic
scripts and ZIP remain local artifacts; they are not shipped in the new release.
