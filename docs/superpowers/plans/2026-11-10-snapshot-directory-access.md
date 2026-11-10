# Automatic snapshot directory access

Goal: Session Stats makes its existing private snapshot directory available to native Remote Control reads without a manual `/add-dir` in each session. Cover existing eligible sessions and newly discovered sessions while the tweak is enabled.

Decision: Reuse Desktop's native `window['claude.web'].LocalSessions.addDirectories(id, [directory])` through a trusted main frame. Desktop owns persistence and live `apply_flag_settings` synchronization. Avoid editing session JSON or global permissions, generating prompt attachments, or restoring a custom CLI patch. Only the producer's validated fixed snapshot directory is eligible. This implements the user's explicit request for automatic per-session access.

- [x] Expose verified local identities from the snapshot producer without altering remote metadata.
- [x] Add an access controller with bounded polling, idempotent registration, retry on unavailable Desktop bridge, stale-identity checks and stop cleanup. Test old/new sessions, failure recovery, untrusted frames, stale identities and directory constraints before implementation.
- [x] Start/stop it with the tweak, independently of stats reading and metadata publication.
- [x] Run targeted tests, build/validation and the full suite; independently review the permission scope.
- [x] Verify real existing-session native metadata updates, unchanged CLI process, and native remote-read result. Distinguish accepted/persisted permissions from successful RC reads.

Implementation was completed without committing or publishing. The user subsequently requested publication as v0.10.1 through the existing commit, tag and Store workflow. Work stays in the existing checkout; no temporary project or worktree. Native API absence remains retriable and reported rather than widening access.
