# Architecture decision 0027: Private NND trial discovery preparation

Status: dormant promotion prerequisite in `20261002-17`. It does not select,
publish, attach or activate an installed NND package.

## Exact registration and child identity

The activation candidate hashes the same bounded, pretty JSON plus final newline
bytes that the manifest transaction writes. A later registration compare-and-swap
must use those exact bytes and retain the exact prior bytes or absence from the
prepared receipt. Equivalent parsed JSON is not evidence of an identical file.

The unpublished trial may create a private discovery generation using the
already-running GUI child's instance ID. It does this under the held native
data-root lease and registration mutex. Its controller returns no public record
and issues no attach ticket before durable activation. The discovery pointer
remains unchanged. Preparation is single-flight and cannot finish after stop.

Trial shutdown closes the child, native listener and private controller, then
discards its unpublished generation. Discard validates the generation and
refuses a record referenced by the current pointer. An uncertain close or
discard retains the singleton lease for diagnosis rather than claiming that
writers have stopped. These rules also apply when trial verification fails.

## Remaining activation boundary

A crash may leave an unpublished private generation. Recovery must identify and
retire only proven orphan generations before capacity is exhausted; absence of
a public pointer alone is insufficient evidence about a live child. The trial
still ends without registration or discovery publication and its principal is
read-only. Subsequent slices must add exact registration CAS, durable process
identity, pointer CAS, post-publication health, principal transition, live owner
transfer, rollback, and crash reconciliation before calling this an installer.
