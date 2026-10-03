# Primary-only NND session workspace binding

Native NND sessions remain confined to the configured primary `workspace_root`. At session
creation, NNA verifies that the effective configured path is an existing canonical directory
without a symlink or junction component. It records the native principal's existing opaque
workspace ID plus the canonical path and filesystem device/inode in the durable session
catalog. It checks that the engine config points to that same configured root before engine
initialization and rechecks the binding before publication.
NND parent and subagent engines do not expose `workspace_change`; direct transition calls and
replay of an earlier workspace-change record are also rejected. The native prompt route
rechecks the stored filesystem identity immediately before handing the prompt to the engine.
The host passes that immutable identity to NND parent engines and their derived subagents.
Each tool call checks it before sealing arguments, before the reviewed decision enters
execution, and immediately before the executor runs. A changed identity yields a
no-effect rejection; it does not reuse the reviewer decision for a different tree.

On restart, each catalog record is checked against the currently configured primary path,
principal ID, and filesystem identity **before** constructing its engine. Legacy records
without an explicit binding are accepted only when their single workspace ID and directory
exactly match the configured primary; they are then written back with the binding. A
mismatched/replaced root or poisoned record fails setup rather than silently running a
session under a different root. Child snapshots continue to require exact owner workspace
IDs matching their parent, and event/session project IDs continue to use that one ID.

This step adds no secondary-root selection. `/session`, `/path`, and `/project` retain the
single-root contract. The authenticated managed `/path` response now includes NNA's
authoritative `workspace_id` when a configured engine is available, so an attached NND
client need not invent a synthetic principal scope. A later phase must supply per-session configuration and grant-aware
principal scope before secondary workspaces can execute.
These checks do not pin a Windows directory handle for the lifetime of an active tool. A
replacement after the final check, or while a long-running process operates, still requires
handle-based or OS-level isolation in a later F1 slice.
