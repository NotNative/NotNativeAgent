# Local NND integration

## Selected native service

The installed Windows path uses NNA supervision. Invoke the selected installation's
recorded Node and CLI with `nnd service start|status|stop|attach INSTALL_ROOT`;
`INSTALL_ROOT` identifies NNA. NNA verifies the registered NND package, retains
data-root ownership and starts the GUI child through private pipes. Browser and
Electron use the same GUI service. Closing Electron leaves native work running.
Attachment returns a short-lived UI ticket; native credentials remain private.

The native listener starts in setup-required state when configuration is missing or
invalid. The GUI can read setup state and explicitly activate saved configuration.
Manifest creation/repair through the GUI remains pending; use independent NNA setup
for that operation. Execution readiness does not establish provider connectivity.
Native permissions and mandatory reviewer governance remain authoritative.

## Workspace admission foundation

The native listener serves `GET /v1/nnd/workspaces/admissions` and the matching
admit, revoke, and operation-receipt endpoints. An authenticated local operator
can record a canonical directory after filesystem identity checks. Reads recheck
the stored identity and the existing primary and secondary grant document;
retries use durable operation receipts. Admission currently records an inventory
only. Session creation and engine execution still use the configured primary
workspace. The inventory reports `selection_enabled:false` until those paths
consume the admitted identity and pass a real multi-workspace turn.

## Existing NND catalog migration

Stop legacy NND processes and disable unsupported old autostarts before invoking
the selected native CLI's `nnd service migrate INSTALL_ROOT`. Migration requires a
valid saved manifest with an explicit absolute workspace and verifiably stopped
catalog sessions. It accepts only recognized legacy local operator grants and
matching workspace/journal provenance. Foreign or uncertain data is refused.

Original catalog bytes and transaction hashes remain in the protected runtime
migration directory. Only workspace grants in parent/child catalog records change;
journals, activity, review modes and TUI data remain intact. The operation is bounded
to 64 parent contexts, 256 child snapshots and 64 MiB combined evidence/staging.
Migration is explicit and never runs during ordinary service startup.

After interruption, `nnd service migration-recover INSTALL_ROOT` restores incomplete
changes or verifies a committed transaction before removing the pending marker.
Unexpected modifications preserve evidence and block startup. Do not delete a marker
to force admission. Interrupted installer guards use a separate marker; their verified
recovery and transactional installer rollback remain planned work.

## Legacy source launch

The following child-owned `nnd serve` contract remains for explicit development and
compatibility. It does not describe the installed supervised service above.

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

## Managed memory

When NND enables agent memory for a managed child launch, it supplies an exact
loopback memory callback and bearer token. NNA registers `openchamber_memory`
only for root NND-owned sessions, consumes and removes the launch variables, and
never propagates the credential to standalone TUI/headless surfaces or delegated
engines. A callback request carries the current workspace, the selected action,
and bounded parameters. The desktop server continues to own memory identity,
authorization, storage, and updates; NNA only presents its bounded action result
to the model.

`nna nnd package activate ROOT` records an installed NND GUI package in
`config/nnd-package.json` after verifying its `nna-integration/nnd-local/integration.json`
identity, protocol `1.0`, version agreement with `package.json`, and built web and
server entrypoints. `nna nnd package status` revalidates the record; it reports
`valid:false` when the installed package has moved or drifted. `nna nnd package
deactivate ROOT` removes only a matching registered root. NND's installers
require an installed NNA before copying the GUI package, activate it after
building, and deactivate it before uninstalling when NNA remains available.
During source development, they can first offer to run a local NNA installer
from the sibling checkout; unattended bootstrap requires explicit opt-in.
An NND service process may run separately for NNA supervision, but NND is not
an independently installed agent runtime.

Registration establishes package identity; service activation is a separate
operation. Explicit legacy source launches may still let the desktop own its web
service and local NNA child. `nna nnd serve` remains available for that compatibility
path. Installed Electron instead attaches to the selected supervised native service.
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

Local NND sessions resolve configured provider credentials through NNA's
existing `nna.local` Secret Broker realm, including delegated child engines.
The credential stays in the NNA child process and is never returned to the
browser. This lets the desktop use the same provider binding as the TUI.
NNO keeps its deployment-specific secret realm; its session engines do not
receive an unscoped broker because NNO secrets may have principal-specific
workspace or user grants.

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
the same principal and complete-workspace-grant filter as live delivery. The
first `server.connected` payload has `properties.replayStatus`: `fresh` when no
cursor was supplied, `complete` when the cursor remains in the ring and is
visible to the current principal and full workspace grant, or `gap` when the
cursor cannot certify a complete suffix. The opener has no SSE `id` field and
never replaces the client's last resumable cursor. A missing, expired, or
foreign-scope cursor produces `gap` and no partial replay. NND must reconcile
from authoritative session, status, and transcript reads after `gap`; it also
reconciles on every SSE reconnect until its replay consumer uses this signal.
The replay window is not durable
across an NNA process restart. While subscribers are connected, NNA sends an
SSE comment heartbeat every 10 seconds; comments carry no event ID and never
enter the replay suffix. This keeps NND's 30-second idle-stream watchdog from
discarding a healthy but quiet connection.

Session listing accepts `roots=true` for parent sessions or `roots=false` for
child sessions; omitting it returns both. `limit` bounds the returned list in
parent-then-child order, with each group sorted by session ID. NND has no list
cursor yet, so a limit smaller than the available list cannot discover the
remaining sessions. `GET /session/:id/children` lists an owned parent's
accessible child sessions in session-ID order. These read paths require `nnd.read`
and the full original workspace grant. They do not grant child steering.

`GET /session/:id/message?limit=N` returns the newest `N` projected messages
(`1..200`) and, when older history remains, an `x-next-cursor` header. Send
that opaque cursor as `before` with a bounded `limit` to read the next older
page. Cursors are exclusive except for the internal live-child boundary token,
which preserves the correct older page when a transient streaming preview
becomes a completed message. Unknown or stale cursors fail rather than silently
returning a partial history. An unbounded message read retains its legacy
200-message view. The same read permission and workspace grant apply to every
page; a cursor cannot select another principal's session.

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
reconciliation bookkeeping, not the source of a semantic phase.
For NND-owned delegations, the child engine uses an `nnd_subagent` output
surface and the child registry projects the same validated phase on the
child session. Live phase changes update that child description without
borrowing the parent's turn state. A completed child settles to idle; its
restored display-only snapshot retains that idle fact without a live-work claim.

Session descriptions also include `metadata.nnd.projection`. The identical
frame is emitted as the owner/workspace-scoped `nnd.projection` event after
`session.created` and `session.updated`, with properties `{sessionID, frame}`.
Version `1.0` contains sessionID, an opaque engine-context epoch, a positive
revision, updatedAt, and three allowlisted display fields: turnState,
activeTools, and context. Each field is either its existing validated shape
or null (unknown/unavailable). Revision advances only when these fields change;
an engine-context restore creates a new epoch. The current authored phase set
has twelve names: idle, preparing, waiting_provider, reasoning, streaming,
awaiting_approval, running_tool, recovering, attention_required, cancelling,
failed, and needs_input. A missing phase is not a fabricated idle observation.
Tool names/count and numeric context estimates contain no arguments, provider
payloads, reasoning, or permission decisions. Known SSE cursors replay frames
inside the bounded in-memory suffix; process restart and expired cursors require
authoritative session snapshots. Durable event history remains separate work.

The NNA-authored Activity projection retains separate start and terminal
milestones for parent turns, delegated turns, and tool calls. A terminal
correction keeps its own stable evidence ID, while the earlier start remains
an historical log entry rather than being overwritten by completion. These
owner-scoped, bounded snapshots contain classified summaries and tool
evidence only; prompt text, tool arguments, and tool output never enter the
Activity record. NND can therefore replay a readable sequence after restart
without treating a past start row as the current session status.
Parent tool evidence also carries the host-authored prompt request ID. NND
can match completed file mutations to the latest turn without inferring
ownership from timestamps; older records without this correlation remain
session-level evidence. This is provenance for the tool event, not a claim
that a current Git diff contains only that turn's edits.

The Context rail's numeric token estimate is also an NNA-authored projection.
NNA saves only its bounded estimated-token count, optional positive limit,
measurement label, and observation time when a turn settles. On restart, the
last observation is restored for the owned session; an invalid catalog shape
is rejected rather than projected. Context text, prompts, and provider payloads
are never part of this saved measurement, and a session that has not reported
an estimate continues to show the limit as unknown.

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

`POST /v1/nnd/sessions/:id/notification-text` is a separate model-only call
requiring `nnd.notification.generate` and the session's original owner/workspace
grant. Input contains kind (completion, error, question, or subtask), title
(120 characters), body (1000 characters), and assistantText (6000 characters).
Ordinary multiline body/context is accepted. An optional `model` selector uses
`profile/model` from that session's configured profiles; it cannot widen the
primary route's network trust zone. Otherwise the configured primary route is
used. NNA owns endpoints and credentials. The call offers no tools, uses the
provider scheduler, caps output at 256 tokens or the lower configured cap, and
has a five-second deadline. Two calls may be in flight globally and one per
session. Invalid output and tool attempts fail; provider failures return generic
unavailability. Valid output contains only title/body (120/500 characters) plus
provider/model attribution. NND must retain deterministic fallback text when
generation is unavailable and recheck event eligibility before display. This
route neither grants permission nor mutates a transcript or live agent turn.
