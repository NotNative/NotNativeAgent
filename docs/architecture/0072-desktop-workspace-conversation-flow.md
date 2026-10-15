# Desktop workspace and conversation flow

The native admission service owns executable workspace identities. The desktop sidebar and
composer consume one shared inventory projection. Concurrent readers share one request. A
successful admission supersedes earlier reads; responses from a previous connection are discarded.
A failed refresh preserves the last snapshot and exposes a retry state. Presentation metadata
must not grant workspace authority or replace native filesystem identity checks.

The desktop and browser share conversation controls. Directory selection is a host capability:
desktop uses its native chooser, and web uses an authenticated server directory browser.
Workspace registration, conversation drafts, engine sessions, and submitted messages have distinct
identities. Starting a conversation must preserve those identities across partial failures.
