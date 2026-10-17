// SPDX-License-Identifier: Apache-2.0
export interface HostStatus {
  revision: string; target: 'desktop' | 'browser'; enabled: boolean; login_installed: boolean;
  login_supported: boolean; version: string; generation: string;
}
export async function hostAction(action: string, value?: unknown): Promise<unknown> {
  const invoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
  if (!invoke) throw new Error('Use the installed desktop to manage this host.');
  const reply = await invoke('desktop_native_host', { action, ...(value === undefined ? {} : { value }) });
  if (!reply.ok) throw new Error(reply.error === 'launch-preferences-conflict'
    ? 'Launch preferences changed elsewhere. Refresh before saving again.'
    : ['native-continuity-unavailable', 'native-continuity-too-large'].includes(reply.error ?? '')
      ? 'NNA could not preserve unsent text for restart. Copy, send or discard it before retrying. The service was not stopped.'
    : `Host operation was not confirmed (${reply.error ?? 'unknown'}). Refresh to inspect the current state before retrying.`);
  return reply.result;
}
export async function readHost(signal: AbortSignal): Promise<HostStatus> {
  const value = await hostAction('read') as HostStatus;
  if (signal.aborted) throw new Error('Host observation cancelled.');
  if (!value || Object.keys(value).sort().join(',') !== 'enabled,generation,login_installed,login_supported,revision,target,version'
    || !['desktop', 'browser'].includes(value.target) || !/^(absent|[a-f0-9]{64})$/u.test(value.revision)
    || !['enabled', 'login_installed', 'login_supported'].every(key => typeof value[key as keyof HostStatus] === 'boolean')
    || typeof value.version !== 'string' || value.version.length > 64 || typeof value.generation !== 'string'
    || !/^[a-f0-9-]{36}$/iu.test(value.generation)) throw new Error('NNA returned an invalid host observation.');
  return value;
}
