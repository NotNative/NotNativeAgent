# Local NND integration

## Browser ownership

NND-owned sessions use `nnd_browser` through the desktop's Electron Chromium
guest. They do not register NNA's Playwright-backed `web_browse`, so browser
actions cannot silently run in a separate, invisible browser. The tool is
registered when the NND service supplies a browser callback at startup. If no
Electron browser controller is connected, its calls report that no capable
desktop browser is connected. A service started without a callback and NND
subagents advertise neither interactive browser tool.
Standalone TUI/headless NNA retains `web_browse` and its separately managed
Playwright runtime, even when an NND package is installed. Package registration
does not change the active surface or select a browser backend.

`nna nnd package activate ROOT` records an installed NND GUI package in
`config/nnd-package.json` after verifying its `nna-integration/nnd-local/integration.json`
identity, protocol `1.0`, version agreement with `package.json`, and built web and
server entrypoints. `nna nnd package status` revalidates the record; it reports
`valid:false` when the installed package has moved or drifted. `nna nnd package
deactivate ROOT` removes only a matching registered root. NND's Windows installer
calls these commands after building and before uninstalling. Installing NND before
NNA requires rerunning the NND installer after NNA is installed.

This registration is a package-identity milestone, not daemon activation yet.
The desktop shell still owns the NND web service and starts a local NNA child;
`nna nnd serve` remains available without a registered GUI package for that
transitional path. NNA-owned web-service supervision and a persistent browser
door remain required for the ADR 0020 drop-in deployment shape.
Scripted installed desktop launches set `NNA_NND_INSTALL_ROOT`; when present,
`nna nnd serve` refuses to start unless that exact root is the active,
version-valid package. Source/development launches omit the variable and keep
their existing local child path. The root is a local install identity, not a
browser-provided authorization claim.

`nna nnd serve` starts NNA's authenticated loopback service for a local
NotNativeDesktop process. NND owns the child process and reads one JSON
readiness line from stdout. The line contains protocol `1.0`, the loopback
endpoint, an instance ID, and an ephemeral bearer token. Diagnostics use
stderr. NND must keep the token in its server process.

NNA loads its configured manifest and constructs the governed session engine
before it emits readiness. Missing or invalid configuration fails startup.
Requests need both the bearer token and a fresh `X-NNA-Principal` envelope;
the route layer checks the permissions and workspace grants.

The local session API supports creating/listing sessions, reading transcript
messages, submitting a turn, renaming a title, archiving/restoring, cancelling
an active turn, and removing a session from the desktop catalog. Each mutation has its own
`nnd.session.*` permission. Catalog removal closes the governed engine but
retains its NNA journal for recoverable operator inspection; it is not a
secure erase. Browser-supplied directory fields cannot select the engine's
workspace.

The authenticated event stream emits SSE `id` fields and retains an in-memory
suffix bounded by 2,048 published events and 16 MiB of serialized frames. A reconnecting client may send
`Last-Event-ID`; NNA replays events after a known cursor in order, applying
the same principal and complete-workspace-grant filter as live delivery. A
missing or expired cursor does not trigger a partial replay; NND reconciles
from session/status/transcript snapshots on every SSE reconnect. The replay window is not durable
across an NNA process restart.

Session listing accepts `roots=true` for parent sessions or `roots=false` for
child sessions; omitting it returns both. `limit` bounds the returned list in
parent-then-child order, with each group sorted by session ID. NND has no list
cursor yet, so a limit smaller than the available list cannot discover the
remaining sessions. `GET /session/:id/children` lists an owned parent's
accessible child sessions in session-ID order. These read paths require `nnd.read`
and the full original workspace grant. They do not grant child steering.

With durable persistence, NNA keeps a bounded session catalog beside its
session journals. A new NND child reopens those sessions under their original
subject and workspace grants before it emits readiness. An invalid catalog
stops startup while preserving the file for inspection. Ephemeral NNA
configurations keep sessions in memory only.

`nna integration serve` remains the NNO-owned entry point. It still requires
an installed NNO activation. The NND command has a separate NNA-owned local
activation and does not change NNO's installation contract.

The session description projects canonical NNA conversation work in
`metadata.nnd.work`: revision, goal identity/objective/status, and bounded task
identity/title/status. The projection comes from `SessionEngine.workStatus()`;
it is not the OpenCode-compatible todo cache. Completion evidence, blocked
reasons, staged completion, and journal details remain inside NNA. A committed
`work_status` output causes a live `session.updated` projection, and normal
session reads reconstruct the same summary after restart. If work state cannot
be validated, the field is absent rather than fabricated.

NND-created engines use a distinct `nnd` output surface. NNA emits semantic
`state_status` records for that surface; its NND host also folds NNA-authored
text/tool lifecycle records into streaming/tool phases. The owned session
description projects the latest validated phase as `metadata.nnd.turnState`.
The projection includes only the phase name; it carries no reasoning text,
provider payload, tool arguments, or decision details. NNA's completion path
settles it to idle. NND's generic busy/idle status remains transport and
reconciliation bookkeeping, not the source of a semantic phase. This phase
display does not yet satisfy the broader replayable 13-state wire contract.
For NND-owned delegations, the child engine uses an `nnd_subagent` output
surface and the child registry projects the same validated phase on the
child session. Live phase changes update that child description without
borrowing the parent's turn state. A completed child settles to idle; its
restored display-only snapshot retains that idle fact without a live-work claim.

The opt-in `POST /v1/nnd/sessions/:id/walkthrough` route is a separate,
model-only inference seam for NND's diff walkthrough. It requires
`nnd.walkthrough.generate` and ownership of the NND session. The caller sends
a 64-hex revision and a bounded array of aliased staged/working hunks; NNA
validates the shape and 64 KiB digest bound before resolving the configured
primary model route. The call runs through the provider scheduler with no
tools, a 45-second deadline and an output cap no greater than the configured
route/provider cap. Diff text is explicitly
untrusted; the route returns model text plus provider/model attribution and
echoes the revision. NNA does not assert that a model's anchors or prose are
correct: NND must resolve aliases against its own snapshot, reject unknown
anchors, and verify the revision before showing a generated walkthrough.
This route does not mutate a session transcript or invoke an agent turn.
