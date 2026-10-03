# NND resumable retirement evidence cleanup

Status: private cleanup foundation; ordinary admission remains barred.

The verified external retirement decision in ADR 0062 authorizes removal of
the exact activation journal and sidecars recorded in its bound plan. The
retained same-process owner must hold the genuine data-root service lease and
package registration mutex. `cleanupRetirement` is available only through
that retained owner. Historical files cannot fabricate a live owner.

Before the first removal and after every removal, cleanup reopens the external
decision, canonical plan, selected registration, pending marker, and discovery
pointer. It checks the retained child against its recorded Windows process
identity, checks the native and controller listeners, and requires the trial
to remain unpublished. The operation checks all remaining recorded file
hashes, directory identity, plain paths, private ownership and access rules,
and the bounded activation directory inventory. Unknown entries or changed
evidence stop cleanup before another deletion. No caller paths are accepted.

Cleanup unlinks at most twelve recorded files and removes only the empty
original journal directory. It never uses recursive deletion. On resumption,
only absent recorded artifacts are tolerated; every artifact still present
must match the same plan. The external decision hash stays fixed throughout
one invocation. Unrelated slot and staging receipts are never deletion
targets. An unexpected activation sibling causes preservation and refusal.

Cancellation requests do not release filesystem ownership. Both native lease
and registry work tracking retain the actual cleanup promise until it
settles. Concurrent cleanup calls sharing a service lease are refused. A
live-owner loss, selected-registration change, or missing selected discovery
pointer prevents further cleanup, even when historical decision bytes remain
valid. Process death therefore does not authorize a replacement owner to
continue: later verified owner recovery remains separate work.

Success returns `retirement_evidence_cleaned_barred`, which is an observation
of removed evidence, not a durable terminal activation commit. Cleanup keeps
`installation-pending.json`, `activation-retirement.json`, and
`activation-retirement-decision.json`. It neither changes the selected
registration nor opens native or controller admission. All ordinary startup,
attach, installation, and registration barriers remain in force. Terminal
commit, barrier retirement, old-process observation, and public admission are
outside this slice.

The focused fixture tests inject filesystem interruption after each of the
thirteen possible deletions, then reopen the exact remaining evidence. They
also cover unknown or changed artifacts, loss of retained ownership,
registration and pointer changes, and missing external authority. These are
local filesystem crash-prefix simulations with native ownership probes
injected. A Windows-only focused acceptance test exercises the actual private
ACL verifier through all thirteen removals and confirms the three admission
barriers remain. An actual process-death acceptance run remains outstanding.
