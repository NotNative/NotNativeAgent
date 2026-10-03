# Unpublished NND native request admission

Status: private prerequisite. It does not promote the native principal or
activate NND.

The supervised NND child receives a native integration token before activation
completes. The native listener currently derives a read-only trial principal,
but a future same-process principal promotion would immediately make ordinary
write routes available to that child while the activation journal and admission
barrier are still unresolved. A principal switch alone cannot be the transfer
commit point.

An unpublished trial therefore installs a closed-only admission gate on its
native integration listener. The gate is created only after consuming the
receipt-bound trial capability. It binds the selected installation and data
identity, stage and activation operation IDs, trial generation, original
service lease, and original package-registry mutex. After bearer authentication
and before principal resolution or route dispatch, it rechecks that ownership,
the generation, and the live trial state. It allows GET and HEAD reads and
denies every other HTTP method regardless of the principal's permissions.
Loss of either owner or a changed/stopping child rejects even reads. There is
no public flag or method that opens this gate.

Consequently a private attach probe cannot use an ordinary native mutation
route. A later transfer slice needs a distinct private probe and a durable
completion/admission decision before it can permit ordinary writes. Until then
the trial's existing confirmed-stop or unresolved-shutdown behavior remains.
