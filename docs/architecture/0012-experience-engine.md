# Architecture decision 0012: Experience Engine and surface ownership

Status: accepted incrementally, 2026-08-14.

## Decision

NNA has three distinct state-owning engines:

1. `SessionEngine` owns conversational work, model steps, tools, recovery, and durable turn state.
2. `GovernanceEngine` owns evidence and policy decisions about admissibility, authority, and effects.
3. `ExperienceEngine` owns operator-facing conversation coordination, drafts, presentation state,
   interactive commands, attached surfaces, and user-experience services.

The Experience Engine is an application boundary, not an agent loop and not an authorization
boundary. It submits authenticated commands through canonical ingress, projects engine events,
and invokes explicitly injected services. It cannot mutate Session Engine state directly, approve
governed effects, widen authority, or treat rendered content as evidence.

## Surface separation

Terminal input decoding, mouse protocols, rendering, retained-screen output, and terminal-mode
lifecycle belong to the TUI surface adapter. Telegram transport, polling, message formatting, and
delivery belong to the Telegram gateway adapter. Headless and integration protocols remain their
own adapters. These surfaces may reuse Experience contracts but cannot depend on another surface.

Gateway process start, stop, PID, and detached-process recovery are runtime supervision concerns.
The Experience Engine may request those operations and present their status, but it does not own
their process lifecycle implementation.

## Dependency direction

Surface adapters depend on Experience contracts. The Experience Engine depends on canonical
ingress and public Session Engine contracts. The Session Engine may depend on governance and
infrastructure services. Governance and the Session Engine never depend on TUI, Telegram, or other
presentation modules.

Operating-system integrations such as the clipboard are injected, bounded services. A service may
own a helper process, but its protocol, serialization, shutdown, and failures remain explicit and
cannot become implicit state inside a renderer or input handler.

## Source ownership

Root files are composition roots or public engine entry points. Their private helpers live in
short, responsibility-named directories such as `engine/`, `governance/`, `experience/`, `tui/`,
and `gateway/`. Shared domains such as guidance, tools, providers, persistence, and observability
remain separate rather than being placed under an engine merely because that engine consumes them.

Moves are performed incrementally as path-only product slices whenever practical. Behavioral
changes are committed separately, with the canonical version advanced and the complete product
check passing for every slice.
