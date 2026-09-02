# Idle maintenance boundary

NNA treats self-improvement as low-priority, cancellable maintenance rather than hidden
agent authority. One process-level idle arbiter coordinates every Console conversation.
Any operator, gateway, configuration, permission, foreground-provider, or foreground-tool
activity cancels the current maintenance signal and restarts the idle clock.

Each stage is independently checkpointed in a local SQLite store. A forced restart marks
queued or running work cancelled before another stage can begin. Watermarks advance only
after the preceding stage and its effects are durably committed. Failed, uncertain,
cancelled, or denied turns remain distinguishable and cannot silently become project
truth.

Authenticated host sessions cannot schedule idle maintenance. Maintenance cannot broaden
review authority, resolve or expose credentials, modify NNA source, activate generated
skills, or perform deployment. Later stages must use the shared fair provider scheduler,
retain foreground capacity, and degrade independently when NNM or another optional service
is unavailable.

The deterministic harvest also emits a bounded operational diagnosis. Any failed,
cancelled, denied, timed-out, or uncertain-effect episode is quarantined from later
learning. The diagnosis contains counts, stable reason codes, and suggested inspection
actions; it does not retain transcript content or invoke a model.

The current staged pipeline is deterministic evidence harvest, operational diagnosis,
project-memory proposal, detached NNM effect reconciliation, then read-only NNM hygiene.
Every stage has its own durable receipt. Optional-service failure degrades only that stage;
operator activity cancels the shared signal before the next stage can begin. Project memory
and hygiene findings remain quarantined proposals until a separately authorized action
applies them.

Deterministic optional-receipt defects, such as an oversized NNM receipt journal, settle the
affected stage once and advance or close the packet. The coordinator does not retry unchanged
input at every idle interval; new evidence can create a new independently fingerprinted packet.

Stage start and terminal state are also projected into local forensic telemetry as
content-free `maintenance.stage` events. They contain run identity, stage number, stable
result code, duration, and input/output fingerprints. The SQLite checkpoint remains the
source of truth: a telemetry outage cannot prevent a stage from committing or recovering.

Operational diagnosis may recognize an explicit authenticated operator request to package
a workflow as a skill. It records only a bounded, secret-screened `skill.workflow_opportunity`
candidate in `proposal_only` state. This recognition does not invoke devteam, write a skill
package, alter a catalog, or activate anything. Building and promotion remain distinct,
explicitly authorized future stages with baseline evaluation and independent review.
