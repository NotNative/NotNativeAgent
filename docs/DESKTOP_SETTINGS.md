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

## Providers and models

These controls ship in version `20261015-13`.

Provider management has Connections, Models and Routing views. Connections use the native
OpenAI-compatible provider adapter. Add and Edit open a focused dialog; credentials are environment
references or existing Secret Broker bindings. The broker's public labels and field names identify
the selection. Secret values are never fetched or displayed. A save must confirm the requested
fields and binding. Existing profiles carry a revision; an outdated editor receives a conflict
and retains its input. Close the editor and refresh to load the newer profile.

The `active` profile flag identifies the saved primary provider; other profiles remain available.
Discovery and connection tests run on explicit clicks in Settings. A successful catalog test confirms
model presence, not inference. Discovered catalogs are shared with the composer and scoped to the
current service connection. Failed discovery retains profile defaults and remembered favorites.

Models supports search, favorites and picker visibility. Preferences use provider/model pairs, so
identically named models on separate providers remain distinct. Favorites sort first within each
provider. Hidden models remain available to existing conversations, and the current selected model
stays visible. Favorites and hidden choices persist in the installation's interface preferences;
they do not enable providers or redirect execution. The complete settings document stays below
32 KiB; an oversized update is rejected before replacement.

Choosing a model in Models only prefills the primary-route form. Save primary route publishes the
selection, and Apply saved provider routing explicitly makes it available to new sessions. Existing
sessions keep their route. Routing exposes the native role bindings and supported tuning controls
with preview, revision checks and publication receipts. Unsupported adapter options are not exposed.

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

Provider acceptance against the same registered installation uses:

```powershell
node desktop/scripts/electron-installed-providers-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

This checks the real installed editor, temporarily saves and restores a provider display name,
performs diagnostics, saves and restores a favorite, filters models, and opens native routing.
It verifies server acknowledgements, records an Electron screenshot, and checks that closing the
shell leaves the same background service running. Run it without concurrent provider/preference edits.

The version `20261015-13` acceptance also used the main installer in the registered application and
desktop locations. Browser checks covered creation, correction of invalid limits, an actual stale
editor conflict, failed discovery with a saved model, persisted picker preferences, primary-route
save/activation/restoration, and native tuning publication/restoration. Temporary providers were
removed. Gateway stayed stopped and disabled. The full core, UI and web suites passed.
