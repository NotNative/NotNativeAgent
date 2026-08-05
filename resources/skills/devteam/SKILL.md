---
id: devteam
version: 1
description: Turn an agreed software change into a planned, implemented, tested, independently reviewed delivery using bounded specialist sub-agents
invocation: both
requires_tools: [agent.run, fs.read_text, fs.write_text, fs.create_directory, fs.delete_file]
---
# Devteam

Run a sequential software-delivery pipeline. The current conversation and any request supplied with the invocation define the work. Resolve material ambiguity with the user before starting.

1. Create `.devteam/` if needed. Preserve artifacts from an interrupted or blocked prior run unless the user authorizes replacing them.
2. Delegate to `agent.run` with type `planner`. Require it to inspect the repository and write `.devteam/spec.md` containing scope, acceptance criteria, constraints, affected areas, tests, and explicit non-goals. It must not edit product code or tests.
3. Read and validate `spec.md`. Delegate to type `coder`, requiring it to implement only that specification and write `.devteam/changes.md` with files changed, decisions, checks run, and remaining concerns.
4. Delegate to type `tester`, requiring it to read the specification and handoff, add or update focused tests, run relevant verification, and write `.devteam/test-results.md` with commands and exact outcomes.
5. Delegate to type `reviewer`, requiring an independent read-only review of the specification, diff, and test evidence. It may write only `.devteam/verdict.md`, with verdict `PASS` or `REVISE` and prioritized findings.
6. If the verdict is `REVISE`, permit one corrective cycle: delegate the precise findings to a coder, then a tester, then a reviewer. Store that cycle's handoffs under `.devteam/cycle-1/`. Do not continue looping after that cycle.
7. Write `.devteam/final-summary.md` with the delivered outcome, verification, review verdict, changed-file summary, and any remaining user action. Report it concisely to the user.

Do not commit, push, switch branches, publish, deploy, or broaden scope. On success, remove intermediate handoff files after producing the final summary; leave `.devteam/` present. On failure or uncertainty, preserve all artifacts and explain the blocker.
