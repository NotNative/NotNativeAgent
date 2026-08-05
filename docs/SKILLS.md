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
id: review.code
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

NNA includes two direct workflow commands. `/troubleshoot [DESCRIPTION]` diagnoses the
current or another local session through redacted runtime evidence. `/devteam [REQUEST]`
runs a planner, coder, tester, and independent reviewer sequentially through the configured
Sub-agents provider route. Devteam is available only to standalone root NNA; an authenticated
host must grant derived sub-agent authority explicitly rather than inheriting it.

When an agent requests multiple independent `agent.run` calls in one model step, NNA may run
them concurrently. The effective concurrency is discovered from the loaded model assigned to
the Sub-agents route and registered with the shared provider scheduler. If the provider does not
advertise a valid parallel capacity, NNA safely executes one sub-agent at a time. Devteam itself
remains sequential because each delivery stage consumes the preceding stage's artifacts.

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
