# Corrupt Snapshot Recovery Implementation Plan

> **For agentic workers:** Use subagent-driven-development with explicit ownership; root integrates and verifies the implementation.

**Goal:** Automatically preserve and rebuild syntactically corrupted parent and child statistics snapshots.

**Architecture:** Detect a stable bounded corrupt destination only during publication of a verified `ok` sample. Save a durable content-addressed backup, revalidate, then atomically replace; preserve unknown valid JSON and unsafe paths.

**Tech Stack:** Node.js CommonJS, node:fs/promises, node:crypto, node:test.

**Spec:** `docs/superpowers/specs/2026-10-29-corrupt-snapshot-recovery-design.md`

## Constraints and review focus

- Preserve original bytes and leave the original untouched if backup or verification fails.
- Parent/child identity, valid foreign JSON, links and concurrent changes remain protected.
- Repeated failures/restarts reuse identical backup contents; cleanup never removes them.
- Normal publications retain existing performance and snapshot compatibility.
- Never intentionally corrupt a real working session to validate the fix.

## Tasks

- [x] Worker: reproduce zero-filled/empty/truncated parent and child failures; implement backup/recovery and targeted failure/race tests in the publisher or a focused helper.
- [x] Root: document the behavior and independently review ownership, durability, races and retry behavior.
- [x] Root: replay the preserved real corrupted bytes in a native-temp fixture, verify exact backup bytes and regenerated common snapshot statistics, then remove the fixture.
- [x] Root: run full tests, build and validate; verify the live development link still produces valid snapshots and record results. Leave changes uncommitted and unpublished.
