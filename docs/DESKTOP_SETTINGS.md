# Desktop and web settings

The native settings foundation ships in version `20261015-11`. Desktop and web use the same
settings pages and the selected installation's background service.

## Available preferences

| Page | Supported behavior |
| --- | --- |
| General | Desktop/browser lifecycle guidance, installed desktop/web version, verified NNA installation details |
| Appearance | System/light/dark mode, separate built-in light/dark themes, interface scale |
| Conversations | Enter or Ctrl/Cmd+Enter to send, spellcheck, conversation width, Markdown/plain user messages |
| Notifications | Off/static/animated successful-turn indicator; reduced motion suppresses animation |
| Keyboard | Record, validate, replace conflicting bindings, reset one command or all displayed commands |

Keyboard currently exposes focus input, new conversation, toggle sidebar, open settings and cycle
theme. It does not offer bindings for unsupported terminal, worktree or model-switch commands.
Provider/model management, installed skills and the existing native configuration controls remain
available under Agent, Capabilities and Advanced. The composer still selects configured models;
these preferences cannot change provider routes, review policy or workspace admission.

OS notifications, sounds, font downloads, persistent browser selection and unsupported editor
preferences are not exposed by this foundation. They need their own complete adapter and acceptance
slice. The broader [settings plan](DESKTOP_SETTINGS_PLAN.md) remains the roadmap.

## Persistence and recovery

`GET/PUT /api/ui-preferences` uses the application's authenticated API boundary. The server accepts
only the shared presentation preference registry. It stores `ui-preferences.json` under the native
desktop data root supplied to the supervised service. Credentials and execution configuration do
not enter this document. Updates use a bounded body, a revision comparison, the configuration lock,
and atomic file replacement. Invalid updates fail as a whole. Corrupt storage is retained for repair.

Preferences apply immediately. The status remains Saving until the server confirms the new revision
and applied values. Network failures preserve the local edit and offer Retry. Another window's write
produces a conflict; local edits remain visible until the operator explicitly reloads saved settings.
Connection changes invalidate pending results and writes. Reads and saves have a 15-second deadline.
Reloading the browser, reopening the desktop and service port changes restore preferences from the
service, without depending on a previous browser origin's local storage.

The status explicitly names interface preferences. Provider and Advanced forms retain their own
save/publication actions; a saved appearance preference must not imply that an edited engine profile
has been published.

Native turn completion uses the service-authored `turnOutcome` on turn Activity records. This
optional field survives parent/child history persistence. It distinguishes completed, cancelled,
needs_input, failed and unknown outcomes without reinterpreting the legacy display status or its
summary. Compatibility messages use their explicit successful finish field. Idle alone, cancellation,
error, token limits and historical transcript loading do not prove success. The indicator is off by
default and clears after four seconds when enabled.

## Verification

Run the UI and web test suites from their package directories. The foundation tests cover actual
controls, their consumers, disk persistence, concurrent revision conflicts, rejected input, corrupt
storage, failed saves, response validation, late results, keyboard input and completion evidence.

The explicit installed Electron acceptance command is:

```powershell
node desktop/scripts/electron-installed-settings-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

This uses the selected installed Electron payload and live registered service, with isolated shell
window state. It changes interface scale through the real control, verifies the server revision and
document effect, restores the original scale, reloads the renderer, checks restoration, captures a
screenshot and confirms that closing the shell leaves the same service generation running. Run it
while other windows are not editing preferences; a concurrent revision refuses restoration instead
of overwriting another window's changes. Its evidence directory is a local test artifact.
