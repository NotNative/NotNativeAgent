# NNA Console design contract

Status: active product and interaction contract.

This document records the intended behavior of the NNA Console. It defines the stable
operator workflows, safety boundaries, and presentation rules that implementation and
tests should preserve as the interface evolves.

## Product shape

The NNA Console is the native terminal operator surface. A stable session bar, conversation
viewport, composer, and compact status line remain spatially consistent. Temporary
surfaces such as help, configuration, and permission decisions replace only the
conversation viewport and restore the prior transcript position, draft, selection, and
focus when closed.

The interface remains useful without color. Symbols supplement explicit state and action
labels. The canonical runtime version is the only version displayed anywhere.

## Review interaction

The visible review posture has three operator-facing states:

1. **Prompt:** the mandatory reviewer evaluates every request and eligible requests also
   require an authenticated operator decision. An operator may create an explicit,
   inspectable, revocable conversation-scoped preauthorization for a declared operation,
   target, side-effect class, expiry, and conditions.
2. **Auto-review:** the mandatory reviewer deterministically approves bounded safe work,
   applies the immutable denial floor, and sends review-required work to the isolated
   semantic reviewer. Only an unresolved interactive escalation opens the permission
   surface. This is the startup default.
3. **Unattended:** the same mandatory auto-review pipeline runs without opening operator
   prompts. A semantic escalation becomes a bounded denial with actionable guidance, so
   the agent may choose a safer or more explicit approach instead of blocking the terminal
   on a human response. Hard policy remains unchanged.

Scoped preauthorization is an explicit response available from Prompt or Auto-review, not
an operating posture. It remains inspectable, revocable, expiring, conversation-bounded,
and subject to every review boundary.

No posture disables review, the private ledger, revalidation, audit, or hard policy. A
workspace-wide remembered approval and a literal bypass-all mode are intentionally not reproduced.
Shift+Tab may cycle the available postures when the terminal reports that chord reliably;
the current posture and consequence must always be visible in text.

The semantic reviewer packet contains a bounded redacted tool definition, normalized
arguments and target, deterministic risk classification, untrusted agent justification,
authenticated operator intent, mission authority, bounded causal conversation evidence,
and relevant ledger summary. Tool output and agent justification never become authority.

Deterministic review owns only mechanically clear approvals and the immutable denial floor.
Uncertain consequential operations reach semantic review. Its default is to approve a
reasonable, proportionate means of carrying out authenticated intent unless it identifies a
concrete conflict, scope divergence, or disproportionate irreversible harm. Operators need not
name ordinary intermediate commands or targets derived from prior results.

A guidance denial constrains the current route rather than completing the objective. The engine
prevents unchanged denied requests from consuming repeated semantic reviews and directs the
agent to continue through a safer, narrower, or more reversible approach. The agent asks the
operator only when reasonable alternatives are exhausted, and then identifies the attempted
operation, the denial, and the exact clarification needed. Immutable denials and reviewer
unavailability are reported distinctly and never misrepresented as missing user authorization.
The mandatory permission-event backstop must exceed the maximum configurable semantic-review
deadline so slow local inference cannot be misclassified as a failed reviewer subscription.

## Capability and command review

NNA should allow an agent to use every configured capability needed to fulfill authenticated
operator intent, subject to principal capability and the immutable safety floor. Review
exists to authorize safe useful work, not to reduce the agent to a read-only assistant.

A future process or shell tool must identify its interpreter and parse the request into a
bounded normalized execution plan before review. Each command, pipeline segment,
redirection, environment change, substitution, working directory, and target receives a
deterministic effect classification. Known destructive forms and unsafe targets are caught
without consulting a model. Malformed, ambiguous, or unsupported syntax fails closed.

Semantically complex plans that survive the deterministic floor may go to the isolated LLM
reviewer. Its packet contains the normalized plan and segment effects in addition to the
ordinary reviewer evidence. The LLM may approve exact authorized work, deny with guidance,
or escalate according to posture, but cannot override a deterministic prohibition or alter
the command.

Immediately before execution, NNA revalidates the command digest, interpreter, arguments,
environment, working directory, targets, authority, policy/tool versions, decision, and
expiry. Execution uses explicit containment, a minimized environment, bounded output and
deadlines, and process-tree cancellation. The ledger records terminal status and effect
certainty; unknown-effect work is never replayed.

## Turn activity and transcript

While work is active, the Console shows ordered model, review, tool, recovery, and queue
activity as it arrives. After completion, one compact terminal row for every tool call remains
visible beside the assistant response, followed by a turn receipt with status, duration, tool
count, and outcome. The activity group can be expanded to recover its ordered review evidence,
bounded arguments, and result detail.

Tool rows are collapsed by default after completion and show the tool name, concise target,
status, and duration. A `process.run` target includes its redacted executable and argv so the
operator can see what actually ran without expanding the activity group. Expansion reveals
the full bounded attributed arguments, including working directory and timeout, plus result details. Untrusted
model/tool content remains visibly distinct from operator and engine facts.
Each completed turn receipt is a mouse target that toggles its compact activity summary.
Full activity details are controlled with `Ctrl+O`; detail rows remain ordinary selectable
transcript text so click-drag copying cannot accidentally collapse them.

## Viewport behavior

The transcript owns an explicit bounded viewport. When it follows the end, new activity
keeps the newest content visible. Scrolling upward disengages follow mode and preserves the
operator's anchored content while work continues. Scrolling to the end or pressing End
reenables sticky follow. A visible indicator reports unseen activity while detached.
PageUp/PageDown and the mouse wheel operate this viewport. The Console uses the terminal's
normal screen buffer by default, preserving the host's configured scrollback capacity; the
alternate screen is an explicit opt-in for embedding hosts.

Resize and expansion must not alter authoritative transcript data, editor content, engine
state, or another session. Display-column measurement must account for wide and combining
Unicode characters.

## Composer

Enter submits or, during active work, sends authenticated steering at the next safe
checkpoint. Ctrl+J is the portable multiline fallback. NNA negotiates enhanced keyboard
reporting with supported terminals so Shift+Enter can be distinguished from Enter. Legacy
hosts that collapse the chord retain Ctrl+J and backslash+Enter; help must show the effective
binding. Bracketed paste never submits.

The editor supports multiline vertical movement, selection where reported, Home, End,
Delete, word movement, undo, history, bounded paste, and an optional external editor.
Typing `/` opens command completion and typing `@` may open a bounded workspace-path
picker. Pending permission owns focus; the draft remains intact.

## Sessions and configuration

Each tab owns its transcript, editor, viewport, active turn, cancellation, attachments,
provider-role routes, and temporary primary-model override. The Main authority tab publishes
provider-profile and role-route defaults for newly created tabs and configured external
adapters. A standard tab receives a snapshot at creation and remains independent afterward.
Selecting a provider resets that role to the profile's default model; `/model` changes only
the active tab's primary model and never rewrites the profile.

Destructive keyboard gestures require intent-specific confirmation within one second.
`Ctrl+C` twice cancels active work, while a fresh pair exits once idle. In the ordinary
editor, `Esc` twice clears a draft; with the editor empty, a fresh pair cancels active work.
Menu and help `Esc` remains an immediate nondestructive Back action.

On orderly shutdown, attached durable session identities, tab names, ordering, active tab,
and safe presentation state are stored in a bounded local pool. Startup validates and
reattaches eligible sessions without replaying provider or tool work. Missing, corrupt, or
locked sessions remain visible as recoverable errors rather than being silently discarded.
At a cold launch, a meaningful prior Main conversation is reattached as a standard
`Previous Main` tab with its transcript and complete route set. The Main authority position
then receives a fresh conversation using the persisted provider defaults and always receives
startup focus. Restored tabs remain available but never displace Main at launch. An unused
prior Main and empty standard tabs are not retained.

## Context

The status line shows bounded context usage derived from engine facts. `/context` opens an
inspectable breakdown, `/compact` requests an explicit auditable compaction, `/handoff`
replaces active model context with a terse self-handoff, and `/clear`
requires clear scope and confirmation. Automatic preflight compaction remains the default
and reports its boundary without interrupting ordinary work.

## Command and help registry

Help and completion are generated from one command registry. Each entry includes usage,
description, origin, availability, required capability, and effective binding. Core, user,
and extension commands remain attributed. Unavailable commands explain the missing
capability and cannot fabricate authority.
