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

Workspace names and sidebar removal live in the desktop service's bounded
`workspace-presentation.json` document, keyed by native workspace ID. Removing a sidebar entry
preserves its files, sessions, and native admission. View options reveal removed entries; a new
folder selection makes an existing entry visible again. Display writes are serialized and atomic.
Grouping and expansion are device preferences scoped to the current runtime.

Each new conversation has a durable browser draft ID, workspace, configured provider/model,
review mode, prompt, and attachments. The native engine currently exposes Standard agent mode.
Auto-review and unattended review use the existing mandatory NNA reviewer. The first-use default
folder is `<desktop data root>/workspaces/default` and goes through normal native admission.
Existing conversations and workspace choices take precedence over first-use initialization.

Native session creation accepts an optional bounded `operation_id` and SHA-256
`start_fingerprint`. The operation ID derives a session identity scoped to the authenticated
actor. A durable creation fingerprint binds the workspace, route, review mode, initial title,
and first-message fingerprint. Repeating the same creation returns its session; changed input
under that operation ID returns HTTP 409. The session catalog preserves the creation fingerprint
and model route through restart. A retained deletion receipt refuses reuse. When a creation
record is absent, an engine with existing conversation history cannot be published as a new
conversation, including after deletion receipts have expired.

The draft persists its start snapshot before creation. First-message retries retain the created
session and message ID, revalidate their directory and model, and resend the original snapshot.
Definite pre-creation refusals allow edits. Unknown outcomes retain the snapshot for recovery.
Navigation during a start does not select the completed session or overwrite another draft.

Operator controls and uploads resolve the same authenticated admitted workspace scope as session creation. Sidebar width, manual ordering, grouping, and expansion are presentation preferences. Native operator panels expose Context, Activity, and Walkthrough; unsupported mutation surfaces are hidden.

New conversation drafts are mirrored to the authenticated desktop service with per-draft compare-and-swap revisions and atomic writes. Their workspace, prompt, attachments, route, review mode, and start snapshot survive a service restart that changes the browser origin. Creation and first submission wait for the saved start snapshot. Deletion keeps a bounded receipt so a delayed window cannot restore a removed draft. Conflicts and storage failures preserve local input and expose retry guidance. Browser storage remains a cache; a full cache cannot bypass the required service save.

Native sidebar width, grouping, filters, expansion, manual workspace ordering, and conversation pins also have service-backed presentation storage. Their revisions are independent of workspace names and execution authority.

A sidebar fork without a message boundary uses the last settled timeline message. Explicit message boundaries remain supported. Forks inherit the parent's admitted workspace, model route, and review mode unless a valid route override is supplied. Busy and unsettled timelines cannot create a child. Restoring an archived conversation reloads its invalidated transcript cache in the owning workspace.
