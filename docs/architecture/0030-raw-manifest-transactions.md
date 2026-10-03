# Architecture decision 0030: Exact raw manifest transactions

Status: internal persistence prerequisite in `20261002-29`. This primitive
does not roll back NND, select a package, publish discovery or clear an
activation barrier.

## Receipt-backed bytes and absence

The holder of an existing manifest mutex may compare an expected source
revision and transactionally publish an exact bounded `Buffer`, or delete the
target to restore true absence. Request identity binds the copied target bytes
or absence as well as the operation payload, so replay with a changed target
cannot borrow an earlier receipt. Raw requests are distinct from ordinary
JSON-transform requests. An input buffer is copied before asynchronous work;
the caller cannot change the committed bytes by mutating it later.

The transaction uses the same prepared/saved/unpublished receipt states,
backups, conflict checks and interruption reconciliation as manifest JSON
transactions. Deletion records its intent before unlinking and records an
`absent` after-revision; Windows contention is retried within a bound. Exact
malformed bytes and line endings remain bytes, without parsing or reformatting.
The existing JSON transaction path keeps its prior behavior.

## Activation boundary

A future NND rollback wrapper must prove that the current registration is the
transaction's exact desired bytes, that its recorded prior bytes or absence
are authentic, and that all affected writers have stopped before invoking a
new raw transaction with its own operation ID. A free lease or missing PID
after a crash is not writer-quiescence proof. An unknown publication result
retains the activation barrier and requires receipt reconciliation. This
primitive alone cannot certify postmortem shutdown or service readiness.
