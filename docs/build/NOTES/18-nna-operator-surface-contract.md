# NNA operator-surface contract

NND has implemented the safe host surfaces. Two capabilities must be projected
by NNA before NND can expose their interactive controls.

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
