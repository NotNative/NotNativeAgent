// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { NativeHostSettings } from './native-host-settings.tsx';
import { InstallationObservationPanel } from './installation-observation.tsx';
import { useNativeObservation } from './use-native-observation.ts';
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';

async function readHealth(signal: AbortSignal): Promise<{ version: string; runtime: string }> {
  const response = await runtimeFetch('/health', { signal });
  if (!response.ok) throw new Error('Could not read service version. Use Refresh version to retry.');
  const value = await response.json();
  if (typeof value?.version !== 'string' || value.version.length > 64 || !value.version.length) throw new Error('Service version reply was invalid.');
  return { version: value.version, runtime: value.runtime === 'service' ? 'NNA background service' : 'Web' };
}

export function NativeGeneralPage(): ReactNode {
  const health = useNativeObservation(readHealth);
  return <div data-settings-item="native.general" className="space-y-5 text-sm">
    <div><h3 className="font-semibold">NotNativeAgent</h3><p>NNA runs locally. Desktop and browser connect to the same background runtime.</p></div>
    <NativeHostSettings />
    <section className="space-y-3" data-settings-item="native.about">
      <div className="flex items-center justify-between"><h3 className="font-semibold">About this connection</h3>
        <button type="button" disabled={health.busy || !health.ready} onClick={() => void health.reload()}>Refresh version</button></div>
      {health.error ? <p role="alert">{health.error}</p> : null}
      {health.busy ? <p role="status">Reading service version…</p> : null}
      {health.data ? <dl className="grid grid-cols-[auto_1fr] gap-3"><dt>Desktop/web version</dt><dd>{health.data.version}</dd><dt>Runtime</dt><dd>{health.data.runtime}</dd></dl> : null}
      <InstallationObservationPanel />
    </section>
  </div>;
}
