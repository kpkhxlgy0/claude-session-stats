# Automatic recovery of corrupted snapshots

The user requests automatic backup and rebuilding after corruption, instead of persistent dashes requiring manual repair. A real parent snapshot and eleven child snapshots contained only zero bytes; the original logs and session bindings were valid. The publisher correctly refused unknown contents but consequently could never replace these derived files.

Recovery runs only for the exact parent/child snapshot destination under the currently verified managed directory, in the existing serialized publication path, when a fresh protocol-valid `ok` sample is ready. Empty, all-zero and other syntactically invalid JSON files qualify after a bounded stable regular-file read. Parseable JSON with unknown format or conflicting ownership remains untouched. Linked, multiply-linked, oversized or changing files do not qualify.

Before replacement, preserve the exact corrupt bytes in an exclusively created and synced file under `.claude/session-stats/corrupt-backups/`. Use the original filename and content digest so an identical corrupt payload reuses a verified existing backup across retries and restarts. Never overwrite an existing conflicting backup, and never delete backups during publisher cleanup.

Recheck the live binding, child membership, directory identities and unchanged corrupt destination before publishing. Only after backup success may a synced replacement be atomically installed. Backup, disk or validation failures leave the original in place and allow later retries. Readers do not themselves move files or substitute unrelated statistics. An `ok` sample with incomplete usage fields retains the existing independent-metric semantics; recovery does not require all providers to supply all usage fields.

This changes recovery of derived statistics only. It does not repair disks, modify source transcripts, invent unavailable metrics, or guarantee successful writes during an ongoing I/O fault. No commit, push or release is included in this implementation request.
