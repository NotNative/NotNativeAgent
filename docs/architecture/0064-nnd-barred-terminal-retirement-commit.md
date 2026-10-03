# NND barred terminal retirement commit

Status: private durable cleanup proof. Native admission and the controller remain barred.

After ADR 0063 has removed every planned activation journal file and sidecar and
the original journal directory, the retained same-process owner may publish one
`install-slots/activation-retirement-commit.json`. It must still hold the genuine
data-root service lease and selected package-registry mutex. The private
operation reopens the external decision, canonical plan, original pending marker,
selected registration and discovery pointer, and recorded live Windows child.
It verifies the complete absence of the planned artifacts, the original directory,
and foreign activation entries. Both listeners must still be alive and the public
controller dark.

The bounded canonical commit binds the operation, stage, installation, data root,
generation, plan and decision hashes, completed receipt hash, marker hash,
registration revision, discovery hash, and child process identity. It contains no
controller token, UI ticket, or secret. Publication uses a single `wx` write; a
partial or uncertain result is not retried. The writer reopens the exact bytes
and the live evidence before returning `terminal_committed_barred`. A second
invocation refuses the existing file rather than treating it as a new success.
Concurrent cleanup and commit under the same service lease are refused.

This commit does not remove `installation-pending.json`, the external plan or
decision, or the new commit file. It does not change the selected registration,
publish the controller, or open native request admission. Ordinary startup and
installation remain barred. Future barrier retirement must verify this commit
after a crash and retain a durable, independently validated cleared witness when
removing the plan and decision. The ordinary admission guard intentionally
recognizes even a lone terminal commit as unresolved activation evidence; that
guard must be revised in the same future transition to validate the cleared
witness before admitting startup. Simply deleting the terminal commit, or
inferring success from absent plan and decision files, is unsafe.
