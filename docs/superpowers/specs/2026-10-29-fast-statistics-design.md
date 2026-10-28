# Faster statistics refresh

The user requests faster display and skipping redundant checks. Previous measurements found a 13.9-second cold request and roughly 1.5-second reads of already-published statistics, dominated by repeated native process and Git commands.

Keep the existing shared committed snapshot for local and RC consumers. Reuse successful Git association checks for up to two seconds only while exact workspace identities and bounded Git control fingerprints are unchanged. Reuse the existing PID-set process query for two seconds in the production main process. Registry identity, current cwd, session/agent IDs, RC eligibility, snapshot data format and expiry checks continue; an observed control change causes a fresh native check. Process death or PID reuse without a detectable registry change, and external/global Git configuration dependencies outside the tracked controls, may be observed up to two seconds later. Cache hits do not extend this window.

When collection temporarily reports `incomplete`, retain the same binding's already-published valid snapshot until its existing expiry. Do not alter its timestamp or revision, publish partial metrics, or hide a confirmed session/root/child-membership change. A first incomplete sample still displays unknown values; malformed, unavailable and missing sources keep their existing rejection behavior.

Alternatives considered: showing uncommitted local samples would break the common local/RC sample contract; removing all identity checks risks displaying a different session. Reusing expensive proofs with cheap change checks preserves the contract with a bounded freshness tradeoff. This implementation choice follows the user's request to skip redundant synchronous work; no new release is included.

Verify native-call reduction, expiry/backward-clock behavior, control/identity changes, incomplete refresh retention, real request-to-result timing and shared snapshot values. Do not claim a latency target without a real measurement.
