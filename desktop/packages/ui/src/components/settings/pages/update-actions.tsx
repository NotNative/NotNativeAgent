// SPDX-License-Identifier: Apache-2.0
import { runUpdateCheck } from '../../../lib/nnd/update-actions.ts';
import { useNativeObservation } from './use-native-observation.ts';
import { SettingsSection } from '../primitives.tsx';

export function UpdateActionsPanel() {
  const state = useNativeObservation(runUpdateCheck, false);
  const availability = state.data?.availability;
  return <SettingsSection item="native-update-actions.settings">
    <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">Check for updates</h3>
      <button type="button" disabled={state.busy || !state.ready} onClick={() => { void state.reload(); }}>Check now</button></div>
    <p className="text-xs">Check now asks the native updater to probe its configured release source. Opening this page does not run a network check.
      Install the platform from a terminal with <code>nna update</code>; the installer manages NNA and its registered desktop package.</p>
    {!state.ready ? <p role="alert">Reconnect and wait for native authority before checking.</p> : null}
    {state.busy ? <p role="status">Checking the release source…</p> : null}
    {state.error ? <p role="alert">Update check failed: {state.error}</p> : null}
    {availability ? <dl className="grid grid-cols-[auto_1fr] gap-2 text-xs" data-testid="update-check-view">
      <dt>Status</dt><dd>{availability.status}</dd><dt>Current version</dt><dd>{availability.currentVersion}</dd>
      <dt>Latest version</dt><dd>{availability.latestVersion ?? 'Unknown'}</dd>
      <dt>Update available</dt><dd>{availability.available ? 'Yes' : 'No'}</dd>
      <dt>Checked at</dt><dd>{availability.checkedAt}</dd>
      {availability.errorCode ? <><dt>Reason</dt><dd>{availability.errorCode}</dd></> : null}
    </dl> : null}
  </SettingsSection>;
}
