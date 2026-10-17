// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore, type ReactNode } from 'react';
import { nativeObservationScope } from './use-native-observation.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { useHostControls } from './use-host-controls.ts';

export function NativeHostSettings(): ReactNode {
  const scope = useSyncExternalStore(onRuntimeEndpointChanged, nativeObservationScope);
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  return window.__NOTNATIVE_ELECTRON__?.runtime === 'electron' && window.__NOTNATIVE_DESKTOP_INVOKE__
    ? <HostControls key={`${scope}|${auth}|${authority}`} /> : <div data-settings-item="native.host" className="space-y-3 text-sm">
      <h3 className="font-semibold">Desktop and background service</h3>
      <p>This browser is connected to NNA. Launch preferences, login wiring and restart belong to the installed desktop on the NNA host.</p>
      <p>Open the NNA tray’s Open NNA Desktop action to manage them. After a restart changes the address, use Open in browser in that tray to reconnect. Saved drafts remain in NNA.</p>
      <p>Closing a browser tab or desktop window leaves the background service running. Quit NNA in the tray stops it. Gateway and OpenCode are separate services.</p>
    </div>;
}

function HostControls(): ReactNode {
  const { observation, data, target, setTarget, confirm, setConfirm, busy, receipt, error, setError, dirty, run, disabled } = useHostControls();
  return <section data-settings-item="native.host" className="space-y-3 text-sm">
    <div className="flex items-center justify-between"><h3 className="font-semibold">Desktop and background service</h3>
      <button type="button" disabled={busy || observation.busy || dirty || !observation.ready} onClick={() => { setTarget(null); setError(''); void observation.reload(); }}>Refresh host</button></div>
    <p>These controls apply to this installed NNA host. Browser links use the system default browser. Closing a desktop window leaves the service and its tray running; Quit NNA in the tray stops it.</p>
    {observation.error || error ? <p role="alert">{error || observation.error}</p> : null}
    {observation.busy ? <p role="status">Reading host state…</p> : null}
    <label className="flex items-center justify-between gap-4">NNA shortcut opens
      <select aria-label="NNA shortcut opens" disabled={disabled} value={target ?? data?.target ?? 'desktop'} onChange={event => setTarget(event.target.value as 'desktop' | 'browser')}>
        <option value="desktop">Desktop app</option><option value="browser">System default browser</option>
      </select></label>
    <p className="text-xs text-muted-foreground">The tray’s explicit Open NNA Desktop and Open in browser actions keep their named destinations. Sign-in starts only the background service.</p>
    <button type="button" disabled={disabled || !dirty} onClick={() => void run('preferences', { target, revision: data?.revision })}>Save launch preference</button>
    <button type="button" disabled={busy || !dirty} onClick={() => setTarget(null)}>Discard launch change</button>
    <label className="flex items-center justify-between gap-4">Start NNA background service at Windows sign-in
      <input type="checkbox" aria-label="Start NNA background service at Windows sign-in" checked={data?.enabled === true && data.login_installed}
        disabled={disabled || dirty || !data?.login_supported} onChange={event => void run('login', { enabled: event.target.checked })} /></label>
    {data && data.enabled !== data.login_installed ? <p role="alert">The enabled flag and Startup script disagree. Toggle the sign-in setting to reconcile them, then refresh.</p> : null}
    {data && !data.login_supported ? <p>Login wiring is unavailable on this platform.</p> : null}
    <div className="flex gap-3"><button type="button" disabled={disabled || dirty} onClick={() => void run('browser')}>Open in browser</button>
      <button type="button" disabled={disabled || dirty} onClick={() => setConfirm(true)}>Restart NNA</button></div>
    {confirm ? <div role="group" aria-label="Confirm NNA restart" className="space-y-2 rounded border border-border p-3">
      <p>Restart interrupts running turns in this desktop/background runtime and disconnects browser tabs. Saved drafts and durable records remain. Gateway, OpenCode and separate TUI sessions are unchanged.</p>
      <button type="button" disabled={disabled} onClick={() => void run('restart')}>Confirm restart</button>
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel restart</button></div> : null}
    {busy ? <p role="status">{confirm ? 'Stopping NNA, starting a new generation, then reconnecting…' : 'Applying host action…'}</p> : null}
    {receipt ? <p role="status" data-testid="host-receipt">{receipt}</p> : null}
    {data ? <dl className="grid grid-cols-[auto_1fr] gap-2"><dt>NNA version</dt><dd>{data.version}</dd><dt>Service generation</dt><dd className="break-all">{data.generation}</dd></dl> : null}
  </section>;
}
