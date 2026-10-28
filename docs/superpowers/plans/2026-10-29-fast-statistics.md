# Faster Statistics Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independently owned resolver task; the primary agent integrates and validates the final behavior.

**Goal:** Show committed statistics promptly by avoiding redundant native verification and retaining valid samples through incomplete collection.

**Architecture:** A bounded Git association cache retains only successful proofs while control fingerprints match. Production uses two-second Git/process reuse. The publisher keeps a still-valid committed snapshot when the next confirmed sample is incomplete.

**Tech Stack:** Node.js CommonJS, Electron, node:test.

**Spec:** `docs/superpowers/specs/2026-10-29-fast-statistics-design.md`

## Constraints and review focus

- Preserve all existing uncommitted fixes; no commit, push, version change or release.
- Local and RC consumers retain the same published revision and metrics.
- Control files, cwd, session IDs and RC state changes must invalidate or force proof refresh.
- Cache expiry/backward time must not reuse old proof; uncertain fingerprints use native checks.
- Incomplete collection never extends the previous snapshot timestamp or lifetime.

## Tasks

- [x] Resolver worker: add failing cache tests in `test/cli-workspace.test.cjs`, implement bounded successful-association reuse in `src/cli-workspace.cjs`, and run targeted tests. Default cache remains disabled; production enables it.
- [x] Primary: add failing parent/child incomplete-refresh retention tests, then implement the narrow retention condition in `src/snapshot-publisher.cjs` and wire two-second resolver options in `src/main.cjs`.
- [x] Primary and independent reviewer: verify control changes, unchanged revisions/expiry and no cross-session reuse; run the complete test suite, build and validate.
- [x] Primary: measure the same real selected child through the production main handler, verify values against published revisions, restore the normal generated entry and remove native-temp probes. Record actual timings and remaining limits.
