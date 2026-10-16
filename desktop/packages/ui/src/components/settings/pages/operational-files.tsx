// SPDX-License-Identifier: Apache-2.0
import { useAgentConfiguration } from './use-agent-configuration.ts';
import { AgentSettingsEditor } from './agent-settings-editor.tsx';

export function FileSettings() {
  const state = useAgentConfiguration();
  return <div className="space-y-4 text-xs">
    <h3 className="text-sm font-semibold">Attachments and managed copies</h3>
    <p>Attach files from the conversation composer. NNA validates type and size, then manages its own copy; source files are not changed.
      Plain text is limited to 64 KiB. The configured byte ceiling also bounds attachments. No indexing or extraction service is required.</p>
    <p>These user defaults require restarting NNA before newly constructed engines consume them. Retention concerns managed copies;
      it does not erase conversation records or execution evidence. Removing an unsent attachment affects only that draft.</p>
    <button type="button" disabled={state.loading || !state.authorized} onClick={() => { void state.load(); }}>Reload file settings (discard edit)</button>
    {state.error ? <p role="alert">Could not read attachment configuration. Reload to retry.</p> : null}
    {state.loading ? <p role="status">Loading file settings…</p> : null}
    {state.view ? <AgentSettingsEditor key={`${state.view.installation_id}:${state.view.data_id}:${state.view.source_revision}:${state.view.resolution_revision}`}
      view={state.view} groups={['files']} onReload={() => { void state.load(); }} /> : null}
  </div>;
}
