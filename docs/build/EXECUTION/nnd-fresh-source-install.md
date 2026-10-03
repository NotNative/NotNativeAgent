# Fresh source install bridge

Status: bounded source-build installation path. Existing NND targets and selected
package registrations are refused; immutable prebuilt staging remains inert and
upgrades require the separate native activation transaction. This path does not
claim signed distribution, login startup, or installed-product acceptance.

The Windows installer selects and validates an installed NNA, checks that its
NND registration is absent and the NND target does not exist, then acquires the
native install guard. The guard rejects another service owner, unfinished slot
or activation evidence, migration, and orphaned guard markers. With that owner
held, the installer repeats the fresh check, copies and builds NND, validates
its service package, registers it with NNA, pins the selected native identity,
and creates shortcuts. It releases the guard before starting the service:
native startup correctly rejects the guard's own pending marker.

Only after guard release does the installer ask the selected NNA descriptor's
Node and CLI to start the service. It accepts `ready` or `setup_required`, with
the exact installation/data identity, selected package version, generation and
loopback endpoint. It rechecks the selected package root and version after
attachment, so a same-version registration change during verification cannot
produce a success result. The native CLI child receives the selected data root
and no ambient NND tool credentials or harness overrides from the installer
shell. A fresh one-use attach ticket is redeemed over loopback in
an isolated verifier cookie jar. The verifier checks authenticated session,
denied ticket replay, unauthenticated second browser, bounded response bodies, and unchanged service
generation. Ticket and cookie are never written to an installer log, URL or
success output. NNA alone determines engine permissions and reviewer decisions.

The success message gives the loopback browser origin and selected NNA paths.
An ordinary browser shows the Native code form; the operator runs the selected
NNA Node/CLI command `nnd service ui-ticket INSTALL_ROOT` and pastes that
one-use ticket into the form. The desktop shortcut obtains its own ticket and
uses an isolated Electron session. Issuing a new browser ticket does not change
the installed service or grant wider NNA authority.

If copying, registration, guard release, startup or attachment is uncertain,
the installer reports an incomplete installation and preserves both products'
evidence. A second source install refuses an existing target or registration;
the operator must inspect native status and use an explicit recovery or future
upgrade workflow. It never merge-copies an existing installation or silently
converts a staged prebuilt slot into an active package.
