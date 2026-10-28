# Selected subagent statistics validation

## Implemented behavior

Selected local/Remote Control child detail panes receive their own centered bottom overlay, 2px from the edge. The absolute bar adds no layout space, padding or margin to the transcript/composer. Parent metrics remain separate. Child samples use exact parent/agent/sidechain identity, deduplicate response updates, and retain the existing valid-response TPS formula. Parent v1 snapshots remain compatible; child v2 snapshots use separate same-directory files with exact agent identity.

## Verification

- `npm run build`: generated `index.js` from renderer source.
- `npm test`: 414 passed, zero failed/skipped, Windows Node.js 26.12.1.
- `npm run validate`: manifest/package consistency, generated bundle freshness, isolated-renderer evaluation and installation entry points passed.
- `git diff --check`: passed.
- Backend and UI work used failing tests before implementation. Tests cover sibling/parent isolation, replay, incremental append/replacement, unsafe paths and stale workspace proofs, v1/v2 compatibility, independent publication/ownership, stale pane replies, cleanup and no layout reservation.
- Independent review found a real-reader gap when a child panel also had an editor. The reader now excludes task-pane editors just like the renderer; its regression was verified failing before the fix and passing afterwards for both parent and child RC reads. No material findings remain.
- Production child parser was checked against actual local logs. Two independently rechecked samples returned complete usage with 49 steps / 8,003,312 tokens / about 19.23 tok/s and 30 steps / 3,392,723 tokens / about 115.38 tok/s. Immediate repeat reads were identical.
- Authorized read-only live inspection confirmed the selected task's view/tool/agent/session identity and the relatively positioned task-pane root. The original header, content and editor geometry was recorded without reading authentication data. No messages were sent.
- Claude++ runtime logs confirm final generated entry hot reload and Session Stats startup.

## Limits and handoff

The desktop became locked/unavailable during final screenshot verification; window activation failed, so no final pixel-placement claim is made. Automated DOM/CSS checks confirm the bar is absolute at the bottom and leaves pane/composer styles untouched. Real remote child values require this updated tweak on the runner too; older parent-only versions do not publish child snapshots. Missing child snapshots remain unknown rather than falling back to parent or UI-summary numbers.

The user subsequently confirmed that the child statistics were visible and numeric, then explicitly requested publication. This is user acceptance, not a claim of an automated final screenshot or independent remote-host verification.

Temporary read-only diagnostics and native-temp probe files were removed. The accepted change is prepared for publication as v0.6.0 to GitHub and the Claude++ Store.
