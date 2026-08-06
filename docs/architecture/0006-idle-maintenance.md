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
