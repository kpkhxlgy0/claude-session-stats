# Resumed subagent pane binding

The reported missing child footer was traced on the actual selected local pane. The route/session, selected/opened tool call and agent/task IDs matched, but the task record's tool call differed from the selected historical call. Native `paneView.isResumed` was true, `paneView.callId` matched the selected call, and the task still referred to the same agent. The old unconditional task-call equality check rejected this valid resumed-agent view.

The binding reader now accepts a differing task tool call only when the resumed flag is strictly true, the pane itself names the exact selected call, and its agent ID matches the task's explicit ID. All existing route/session, opened call, agent validation and conflicting-view/detail checks remain. This does not change which log or snapshot is read: both continue to be keyed by the exact parent session and agent.

The regression failed before the change and passed afterwards in local and remote fixtures. Additional cases reject missing/false/string resumed flags, absent or wrong pane calls, absent/different task IDs, malformed agents, wrong sessions/opened calls and conflicting selected views/details. A renderer integration test resumes an already visible child, updates the task's latest call, then checks that three refreshes preserve the same footer, update its counters and retain the 24px layout reservation.

The actual pane's direct binding changed from `detail-identity` rejection to the exact selected child binding after the fix. The native page was hidden during these probes, so its normal visibility cleanup was not counted as another rendering failure; this observation establishes real binding recovery, not a foreground screenshot or a second-machine UI test. Probes read only pane identity/visibility and the tweak's own fields, and no messages were sent.

The previous uncommitted prompt-refresh and parent-read performance changes are preserved. Final verification, generated-entry restoration and temporary-probe cleanup are completed before delivery; this change is not committed or published.
