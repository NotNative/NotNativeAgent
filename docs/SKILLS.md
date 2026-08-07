# Skills

NNA skills are bounded Markdown workflow packages. They help a model follow a repeatable
process, but they are not executable plugins and never grant tools, permissions, secrets,
filesystem access, or a wider workspace scope.

## Local discovery

Standalone NNA discovers bundled product skills, then skills from `~/.nna/skills` and,
for a trusted workspace only, `<workspace>/.nna/skills`. A skill is either a `SKILL.md` inside one child directory or a
top-level `*.skill.md` file. Discovery is bounded to 128 skills, one directory level below
each root, 64 KiB per body, and 192 KiB of bodies in total. Symlinks are ignored.

Each file begins with restricted YAML-style frontmatter:

```markdown
---
id: code-review
version: 1
description: Review changed code for correctness
invocation: both
requires_tools: [fs.read_text]
---
Read relevant files before reporting prioritized findings.
```

`invocation` is `user`, `agent`, or `both`. `/skills` opens the catalog and `/skill ID
[REQUEST]` invokes a user-accessible skill for one turn. Agents see bounded catalog
summaries and use the always-visible `skill.search` and `skill.load` tools to select and
load agent-accessible bodies. `nna skills --json` provides machine-readable introspection.

## Authoring a skill

Use a short, memorable, command-like `id` such as `webdesign`, `pricecheck`, or
`server-audit`. The ID names the reusable workflow; it is not a command plus a modifier.
Put modes, variants, targets, and desired outcomes in the invocation request or the skill
body rather than encoding them in dotted IDs such as `webdesign.modern`.

Create the package in exactly one appropriate scope:

- `resources/skills/<id>/SKILL.md` for a built-in workflow shipped with NNA;
- `~/.nna/skills/<id>/SKILL.md` for a user-wide custom workflow;
- `<workspace>/.nna/skills/<id>/SKILL.md` for a workflow intentionally local to one
  trusted workspace.

Choose `invocation: user`, `agent`, or `both` deliberately. Declare only tools the
workflow actually needs, and write the body as an evidence-driven procedure with explicit
inputs, ordered stages, completion criteria, failure behavior, and verification. A skill
never grants its declared tools; normal tool availability, review, and host authorization
still apply.

Custom skills use the generic invocation form `/skill <id> [request]`, for example
`/skill webdesign improve the settings page`. A small number of important bundled
workflows also have memorable command aliases. `/devteam`, `/research`, and
`/troubleshoot` remain workflow commands backed by their corresponding skills; skill
authors should not assume a new alias exists merely because a skill was registered.

NNA includes three direct workflow commands. `/troubleshoot [DESCRIPTION]` diagnoses the
current or another local session through redacted runtime evidence. `/devteam [REQUEST]`
runs a full evidence-driven software team through planning, dependency-aware implementation,
testing, independent criticism, targeted repair, and a whole-product integration gate.
Every run inherits the target repository's own standards plus NNA's judgment-based Power of
Ten baseline; interface work also receives UI ownership, lifecycle, bounded-work, platform,
accessibility, and failure-preservation gates without requiring a separate invocation mode.
`/research [QUESTION]` performs source-diverse discovery, builds a dated evidence ledger,
tests contradictions, closes material gaps, and produces an independently reviewed synthesis.
These sub-agent workflows are available only to standalone root NNA; an authenticated host
must grant derived sub-agent authority explicitly rather than inheriting it.

When an agent requests multiple independent `agent.run` calls in one model step, NNA may run
them concurrently. The effective concurrency is discovered from the loaded model assigned to
the Sub-agents route and registered with the shared provider scheduler. If the provider does not
advertise a valid parallel capacity, NNA safely executes one sub-agent at a time. Devteam and
research preserve dependency order, but may fan out independent work packages, source classes,
or read-only reviews up to that discovered capacity. Overlapping edits and integration-sensitive
work remain serialized.

Use `/agents` to inspect the endpoint and model assigned to the Sub-agents route, whether root
sub-agent execution is available, and the scheduler's running, queued, and discovered-capacity
state. The view is read-only and never probes or starts a provider.

## Authenticated hosts and NNO modules

An authenticated headless host can provide exact inline skill descriptors in
`manifest.skills`. Inline skills are rejected from ordinary local manifests. The
descriptor bodies and SHA-256 grant digest are bound to durable-session provenance, and a
resume with a different grant fails closed. An agent-invocable hosted skill requires exact
`skill.search` and `skill.load` tool grants; every declared `requires_tools` entry must
also be present in the host's exact tool grant.

NNO reads skill bodies from modules already filtered to the authenticated user's module
scope, converts them to bounded values, and sends only those whose required business
tools are allowed by current RBAC. NNA therefore does not receive host filesystem access
to discover NNO module files, and a skill hidden by NNO cannot be recovered through model
prompting.

Skill bodies and retrieved content remain subordinate to engine policy, authenticated
host scope, the mandatory tool reviewer, and server-side authorization at every business
tool boundary.
