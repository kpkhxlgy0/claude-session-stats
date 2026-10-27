# Worktree snapshot synchronization design

## Goal and scope

Restore local and Remote Control Session Stats for a Code session that entered an existing Git worktree after launch. Keep native access controls intact, read only the normal fixed snapshot path through RC, and verify the reported real session. No model prompts, new worktrees, temporary project copies, commits, pushes, version bumps or releases.

## Verified defect

Desktop metadata remains on its launch cwd while Claude Code's live session registry and worktree-state name another directory. CLI 2.1.308 defines workspace_root as the directory at session start/claim; EnterWorktree and mature set_cwd do not re-anchor it. Native read safety checks use the current session directory roots. A harmless one-shot marker at both candidate roots was rejected by the original anchor; it was removed, without reading or copying the refused statistics file.

## Decision

Use one consistent current-directory contract. The runner resolves a uniquely identified, live CLI session directory and proves a moved directory belongs to the same registered Git worktree/repository as the Desktop binding. RC always requests the fixed relative path .claude/session-stats/<bridge>.json without the fixed launch-root anchor. The same native read-file security checks remain authoritative. The receiver rejects anchored/unexpected responses, arbitrary paths and invalid snapshots. No deny-triggered path/anchor fallback.

Keeping the fixed anchor does not cover mature worktree changes. Updating only Desktop cwd cannot repair the CLI anchor. Copying the old refused snapshot, widening permissions, or trying absolute paths is excluded.

## Directory authority

- Match account/org/local ID/CLI ID/bridge ID from Desktop metadata to the CLI registry's exact sessionId, hostSessionId and bridgeSessionId where present.
- Read only bounded regular numeric-PID registry JSON files; never key files or messaging sockets.
- Require matching PID and process birth identity for moved workspaces. Fail on live conflicting candidates, unsafe or invalid matching records.
- Resolve and recheck canonical directory and metadata identities. Prove same Git common-dir and registered worktree membership for moved roots. Do not trust a folder name or the last history row alone.
- Ordinary sessions with no matching active registry retain their Desktop directory. An invalid/ambiguous matching candidate must not silently fall back.
- Revalidate before publication and local delivery; a changed root creates a new binding. Old payloads are never used as input for the new publication.

## Additional defect found during live verification

The new current-directory RC request successfully read the fresh snapshot, but its source was unavailable: the same CLI UUID exists in both original and worktree log directories. The current index discards duplicate IDs. Inspection proved the smaller file is an exact, newline-terminated byte prefix of the larger file; both contain the same-session relocation marker. Native migration failure can leave the original transcript active, so current cwd, directory encoding and mtime do not establish the log source.

For duplicate UUIDs only, allow a bounded disambiguation when the verified workspace matches the same-session relocation marker and every candidate is an exact completed-record prefix of one longest transcript. Read that transcript once through the existing metrics pipeline; never sum files, choose the newest mtime or assume the worktree copy is authoritative. Reject divergent, linked, oversized or unstable candidates. Cache only version-bound prefix proofs and revalidate before returning a sample. Without workspace evidence, preserve the prior duplicate rejection.

## Acceptance

TDD for registry identity/liveness/reuse, ambiguous mappings, Git association, enter/exit/switch races, and the reader's single request contract with no denial fallback. Existing fork TPS/counter behavior remains unchanged. Full tests, bundle validation and independent review precede live installation. Verify this real session via normal local stats and the other machine's normal RC reader, matching the same snapshot revision. If the new normal request is denied, stop instead of changing paths again.
