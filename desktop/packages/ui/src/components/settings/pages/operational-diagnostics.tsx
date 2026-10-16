// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { readNativeInstallation, type NativeInstallationView } from '../../../lib/nnd/installation.ts';
import { readNativeEnvironment, type NativeEnvironmentView } from '../../../lib/nnd/environment.ts';
import { useNativeObservation } from './use-native-observation.ts';
import { downloadTextDocument } from '../../../chat/session-export.ts';

async function readSummary(signal: AbortSignal) {
  const [installation, environment] = await Promise.all([readNativeInstallation(signal), readNativeEnvironment(signal)]);
  if (installation.installation_id !== environment.installation_id || installation.data_id !== environment.data_id)
    throw new Error('Diagnostic sources refer to different installations. Refresh before exporting.');
  return { installation, environment };
}
export function diagnosticDocument(installation: NativeInstallationView, environment: NativeEnvironmentView, paths: boolean) {
  return { format: 'nna-diagnostic-summary', version: 1, created_at: new Date().toISOString(),
    product: installation.product, package_version: installation.version, node_major: installation.node_major,
    environment: environment.observed.map(entry => ({ name: entry.name, present: entry.present })),
    ...(paths ? { paths: { application: installation.install_root, data: installation.data_root, node: installation.node } } : {}),
    scope: 'Installation metadata and environment presence only; no transcript, configuration, credentials or execution evidence.' };
}

export function DiagnosticSummary() {
  const state = useNativeObservation(readSummary);
  const [paths, setPaths] = useState(false);
  const [exported, setExported] = useState(false);
  const installation = state.data?.installation;
  return <div className="space-y-4 text-xs">
    <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Diagnostic summary</h3>
      <button type="button" disabled={state.busy || !state.ready} onClick={() => { setExported(false); void state.reload(); }}>Refresh summary</button></div>
    <p>Export a bounded local summary for troubleshooting. Environment values, credentials, prompts, and conversation content are excluded.
      This is not a backup or a full evidence bundle. The download stays on your device.</p>
    {state.error ? <p role="alert">Could not refresh diagnostics: {state.error}</p> : null}
    {state.busy ? <p role="status">Reading native diagnostics…</p> : null}
    {installation ? <dl className="grid grid-cols-[auto_1fr] gap-2" data-testid="diagnostic-summary">
      <dt>Product</dt><dd>{installation.product}</dd><dt>Version</dt><dd>{installation.version}</dd>
      <dt>Node major version</dt><dd>{installation.node_major}</dd>
    </dl> : null}
    <label className="flex items-center gap-2"><input type="checkbox" checked={paths} onChange={event => { setPaths(event.target.checked); setExported(false); }} />Include local storage paths in the download</label>
    {paths && installation ? <dl className="grid grid-cols-[auto_1fr] gap-2 break-all"><dt>Application</dt><dd>{installation.install_root}</dd>
      <dt>User data</dt><dd>{installation.data_root}</dd><dt>Node</dt><dd>{installation.node}</dd></dl> : null}
    <button type="button" className="rounded border border-border px-3 py-2" disabled={!state.data || state.busy || Boolean(state.error) || !state.ready}
      onClick={() => { if (state.data) { downloadTextDocument('nna-diagnostic-summary.json', JSON.stringify(diagnosticDocument(state.data.installation, state.data.environment, paths), null, 2), 'application/json'); setExported(true); } }}>Export diagnostic summary</button>
    {exported ? <p role="status">Diagnostic summary prepared for download.</p> : null}
  </div>;
}
