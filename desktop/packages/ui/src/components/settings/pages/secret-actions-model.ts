// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { readBrokerSecrets, readSecretAudit, readSecretScopes, NativeSecretActionFailure, secretActionErrorText, type PublicSecret } from '../../../lib/nnd/secret-actions.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState } from '../../../sync/authority-sync.ts';
import { useSettingsEdit } from '../edit-boundary.tsx';
import { nativeObservationScope, useNativeObservation } from './use-native-observation.ts';

async function readSecrets(signal: AbortSignal) {
  const [secrets, capabilities] = await Promise.all([readBrokerSecrets(signal), readSecretScopes(signal)]);
  try { return { secrets, audit: await readSecretAudit(signal, 100), auditAvailable: true, ...capabilities }; }
  catch (failure) {
    // Compatibility: secret.read does not imply secret.audit; a read-only roster must remain usable.
    if (failure instanceof NativeSecretActionFailure && failure.code === 'integration_permission_denied')
      return { secrets, audit: [], auditAvailable: false, ...capabilities };
    throw failure;
  }
}
export function confirmSecret(result: PublicSecret, expected: Partial<PublicSecret>): PublicSecret {
  const comparable = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).sort(([a], [b]) => a.localeCompare(b)) : value;
  if (Object.entries(expected).some(([key, value]) => JSON.stringify(comparable(result[key as keyof PublicSecret])) !== JSON.stringify(comparable(value))))
    throw new Error('The broker did not confirm the requested record.');
  return result;
}
export function useSecretActions() {
  const observation = useNativeObservation(readSecrets), scope = nativeObservationScope();
  const [busy, setBusy] = useState(false), [receipt, setReceipt] = useState(''), [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useSettingsEdit('Secret operation', false, busy);
  useEffect(() => {
    setBusy(false); setReceipt(''); setError('');
    return () => { active.current?.abort(); active.current = null; };
  }, [scope, observation.ready]);
  const run = async (description: string, work: (signal: AbortSignal) => Promise<unknown>, confirmed: () => void) => {
    if (active.current || observation.busy || observation.error || !observation.ready || !observation.data?.can_manage) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => active.current === controller && !controller.signal.aborted && scope === nativeObservationScope()
      && useAuthSessionStore.getState().status === 'ok' && authorityState() === 'ready';
    setBusy(true); setError(''); setReceipt('');
    try {
      await work(controller.signal); if (!current()) return;
      setReceipt(description); confirmed();
      // Why: refresh uses a separate observation owner after the mutation has acknowledged its result.
      await observation.reload();
    } catch (failure) { if (current()) setError(`${failure instanceof NativeSecretActionFailure ? secretActionErrorText(failure.code) : 'NNA did not confirm this operation.'} Refresh and inspect the roster and audit before retrying.`); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  };
  return { ...observation, busy: busy || observation.busy, receipt, mutationError: error, run };
}
