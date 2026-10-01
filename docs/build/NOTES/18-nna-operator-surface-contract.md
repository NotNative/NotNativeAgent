# NNA operator-surface contract

NND has implemented the safe host surfaces. Two capabilities must be projected
by NNA before NND can expose their interactive controls.

## Canonical conversation work projection

The Context/Work rail reads NNA's session-owned `metadata.nnd.work`, not the
OpenCode-compatible todo cache. NNA projects a revision, optional goal
identity/objective/status, and bounded task identity/title/status from its
durable `workStatus()` state. NND treats malformed or absent projection as
unknown, never invents a goal, and suppresses compatibility todos when the
configured engine is NNA. Evidence, blocked reasons, and staged completion
remain NNA-internal. The `work_status` output triggers an authenticated live
`session.updated`; ordinary session reads restore the projection after restart.

## Authored turn phase

NNA emits semantic `state_status` records for NND-owned engines, folds its
text/tool lifecycle records into streaming/tool phases, and projects the
latest validated phase through `metadata.nnd.turnState.phase`.
The Context rail displays that phase, even when token measurement is absent.
NND does not infer it from the compatibility `busy|idle|retry` transport
status. NNA settles the projection to idle after a completed turn; unknown
phase names remain absent. The full replayable turn-state contract, including
cursor and correction semantics, remains separate PA work.
The same phase is projected per live delegated child session. The Subagents
row displays it only when the child's own transport status is active; pending
permissions and questions still take precedence. A restored read-only child
reports idle, never a live-work phase.

Reconnect session reads use live-event revision/tombstone guards and the
`time.updated` recency guard. An older in-flight GET cannot replace a newer
phase or revive a deleted session, even when timestamps tie. Bootstrap takes
its revision baseline before fetching session lists and overlays live updates
and deletions over stale results. An accepted authoritative description
replaces the entire session record so removed metadata does not linger. This
is snapshot reconciliation, not a substitute for NNA's future bounded
event-cursor replay contract. NNA now retains a count- and byte-bounded in-memory SSE suffix
and accepts `Last-Event-ID` on the NND harness stream, with authorization
filtering on replay. A missing cursor or process restart still relies on
NND's snapshot recovery on every SSE reconnect; durable replay and explicit gap signaling remain
future contract work.

## Child-session steering

NNA must emit a versioned, replayable session projection containing
`capabilities.steerSubagent` for the exact child session, its parent-session
identity, and a capability revision or expiry. The authenticated NNA channel,
not an NND-supplied field, determines caller identity and entitlement. When
the capability is false, absent, expired, or superseded, NND renders that
transcript read-only and does not display a steering composer.

A steer request must carry the target child session id, parent correlation id,
and a client-generated operation id used for idempotent retry. NNA validates
the current grant and the parent/child relationship at request time; it must
not trust the claimed parent or caller. NNA then emits one correlated,
authoritative receipt or denial evidence frame. A retry with the same operation
id returns the original result rather than submitting the instruction twice.

An NNA revocation or projection correction immediately removes the control.
Any open draft becomes non-sendable and is never automatically resubmitted if a
later grant appears; it may remain local for the operator to copy or discard.
This preserves the observation-mode draft rule while preventing a stale grant
from authorizing an action.

## Browser preview and capture

NNA must publish a versioned, replayable allowlisted browser projection with a
page id, NNA-sanitized display URL and title, permitted actions, capture scope,
and a capability revision or expiry. The capture scope binds every request to
the authorized page, frame/region, and data class; NNA redacts or withholds
unsafe URL, page, capture, and diagnostic data before projection.

NND may display only the NNA-projected page in an isolated, untrusted browser
container. It must not navigate arbitrary URLs or expose browser content to
shell, filesystem, secret, or privileged IPC authority. Address and tab
controls submit scoped requests to NNA rather than navigating locally.
Navigation, capture, annotation, and user takeover each use a distinct,
idempotent operation id and NNA-authorized action; each resolves through one
correlated receipt or denial. A stale page, expired grant, or replayed request
is denied rather than applied to the current page.

## Permission review authority (2026-10-01)

NNA owns permission settings, scope, and its mandatory auto-reviewer. NND
does not create a parallel auto-accept policy or send automatic permission
approvals. NNA's Prompt, Auto-review, and Unattended postures all retain
review, revalidation, audit, and hard policy; scoped preauthorization must be
explicitly supported and authorized by NNA, never inferred from an NND toggle.

The unfinished NND auto-accept runtime was removed. Composer and scheduled
task auto-accept controls and the shortcut declaration were removed; legacy
scheduled flags are stripped during normalization. Governance projection
remains the source for the displayed review posture. Historical planning
references to an NND auto-accept runtime are superseded by this authority rule.

### Session permission mode integration

The Context rail exposes NNA's `GET/PUT /v1/nnd/sessions/:id/review-mode`
for an owned root session. NNA supplies the allowed modes, current choice,
effective posture, and revision. A write needs `nnd.session.update`, the
authenticated owner/workspace scope, a matching revision, and an idle session.
NNA persists the choice and emits `session.updated`; NND never stores a
parallel permission policy. Older servers and delegated sessions expose no
editable mode control. Runtime/session changes discard stale UI responses.

`default` resolves to NNA's startup posture, currently `auto-review`.
`auto-review` explicitly selects that reviewer posture. `unattended` keeps
mandatory review and denies unresolved escalations. No `full-control` mode
exists. `prompt` is an NNA Console posture but is unavailable on the NND
connection because it has no authenticated permission-decision transport.
The choice applies to the selected root session; NNA's delegated-child policy
remains independently governed. Failed writes require refresh before retry.

## Acceptance evidence

- Absence of a capability never exposes its control.
- Projections and evidence include a cursor/revision so reconnect can replay
  grants, denials, revocations, and corrections in order without inventing a
  capability state across a gap.
- Revocation hides the control; an already-open steering draft is retained only
  as non-sendable local text and is never silently retried.
- A stale client action is denied by NNA and rendered as a correlated receipt,
  not assumed successful locally.
- Browser fixture coverage includes scope mismatch, expired/revoked page grants,
  sensitive-data redaction, and an attempted arbitrary navigation.
- Mock harness fixtures provide allow/deny/revoke/retry sequences for both
  surfaces.
