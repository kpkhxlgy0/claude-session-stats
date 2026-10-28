# Selected subagent statistics

**Goal:** Match the published Codex++ Session Stats behavior: show the selected subagent's five metrics centered 2px above its detail pane bottom, with no layout height, padding or composer displacement. Keep parent statistics separate and preserve unknown TPS as `—`.

**Reference:** Codex Session Stats v0.5.0, commit `0ee82a31a3805d694d4c96a51c18796f69bd4797`. Reuse the runner-log / small-remote-snapshot architecture; no core changes or UI-derived token estimates.

## Verified Claude host contracts

- The live task pane is `[data-pane-root][data-perf-screen="tasks"]`, already relatively positioned. Its selected view has `{kind: 'subagent', toolUseId}` and `sessionRef`. A detail component has `openedToolUseId`, `paneView.agentId`, optional `task.taskId`, and the same `sessionRef`. Match these identities within this pane, never task names or the main thread alone.
- Child logs are `<project>/<parent CLI UUID>/subagents/agent-<agentId>.jsonl`. Rows use the parent sessionId, the exact agentId, and `isSidechain: true`. Parent metrics must continue rejecting sidechains.
- The UI's task summary has totalTokens/toolUses/durationMs only; it cannot substitute for response counts, cache hits or output-token TPS.
- Parent snapshots keep their v1 path/schema. Publish separate bounded child snapshots in the same verified directory, named `<bridge-id>.agent-<agentId>.json`, with a strict v2 child envelope including agentId. Readers verify parent/org/agent identity and existing freshness/replay checks. A missing child snapshot stays unknown; do not read remote raw transcripts.
- Agent IDs are exact ASCII letters/digits/underscore/hyphen, 1–64 characters; reject other values rather than rewriting them. Legacy parent readers and ownership cleanup must ignore neighboring child files.

## Implementation and ownership

- [x] Backend worker: independent exact-agent metrics mode and bounded incremental child log store. Expose `store.getAgentStats(parentCliUuid, agentId, context?)` and `store.listAgents(parentCliUuid, context?)`. Keep existing parent source resolution and migration checks.
- [x] Snapshot worker: strict optional child envelope/path and child publication using the existing atomic write, workspace proof, ownership and TTL rules. Parent files remain backward compatible. Extend `publisher.readLocal(localSessionId, {agentId, waitForPoll})` for the same published child sample.
- [x] Renderer worker: scoped pane binding and independent absolute overlay, local/remote requests, switch/close/remount cleanup and no duplicate child composer stats. Export `createSubagentBindings()` from a self-contained module for main-world evaluation.
- [x] Root: local IPC, remote reader/bridge integration, generated renderer bundle, full tests/validation and independent review. Remove every temporary diagnostic hook and scratch file before delivery.
- [x] User acceptance: actual pane binding and original geometry were verified; final automated screenshot inspection was unavailable. The user subsequently confirmed that the statistics appeared with numeric values and authorized publication to GitHub and the Claude++ Store as v0.6.0.

## Acceptance

Use test-first implementation. Verify child-response replay does not double count; parent/foreign-agent data never enters child metrics; missing usage/timing stays unknown; file replacement, unsafe links and identity changes fail closed; local/remote child selections and stale responses remain isolated. Confirm the bar is out of document flow and its removal leaves original layout intact. Publication was subsequently explicitly authorized by the user.
