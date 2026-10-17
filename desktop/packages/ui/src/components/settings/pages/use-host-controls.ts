// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'react';
import { useNativeObservation } from './use-native-observation.ts';
import { hostAction, readHost } from './native-host-model.ts';
import { useSettingsEdit } from '../edit-boundary.tsx';
import { flushDraftsForLifecycle } from '../../../chat/drafts.ts';
import { flushConversationDraftPersistence } from '../../../chat/conversation-draft-persistence.ts';

export function useHostControls() {
  const observation = useNativeObservation(readHost), { data } = observation;
  const [target, setTarget] = useState<'desktop' | 'browser' | null>(null);
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(''), [error, setError] = useState('');
  const active = useRef(false), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const dirty = target !== null && target !== data?.target;
  useSettingsEdit('Desktop launch and lifecycle', dirty || confirm, busy);
  const run = async (action: 'preferences' | 'login' | 'browser' | 'restart', value?: unknown) => {
    if (active.current || !data || !observation.ready) return;
    active.current = true; setBusy(true); setError(''); setReceipt('');
    try {
      if (action === 'restart') { flushDraftsForLifecycle(); await flushConversationDraftPersistence(); }
      const result = await hostAction(action, value) as Record<string, unknown>;
      if (!live.current) return;
      const valid = action === 'preferences' ? result?.target === target && typeof result.revision === 'string' && /^[a-f0-9]{64}$/u.test(result.revision)
        : action === 'login' ? result?.enabled === (value as { enabled: boolean }).enabled && result.login_installed === result.enabled
          : action === 'browser' ? result?.opened === true : result?.restarted === true && typeof result.generation === 'string' && result.generation !== data.generation;
      if (!valid) throw new Error('The host reply did not confirm this action. Refresh to inspect the outcome.');
      setTarget(null); setConfirm(false);
      setReceipt(action === 'preferences' ? 'Launch preference saved · applies to the next NNA shortcut launch.'
        : action === 'login' ? 'Login wiring updated · applies at the next Windows sign-in; this runtime is unchanged.'
          : action === 'browser' ? 'Opened NNA in the system default browser.' : 'New NNA service generation is ready. Reconnecting this desktop…');
      if (action !== 'restart') await observation.reload();
    } catch (failure) { if (live.current) setError(failure instanceof Error ? failure.message : 'Host action failed. Refresh before retrying.'); }
    finally { active.current = false; if (live.current) setBusy(false); }
  };
  const disabled = !data || !observation.ready || observation.busy || busy || !!observation.error;
  return { observation, data, target, setTarget, confirm, setConfirm, busy, receipt, error, setError, dirty, run, disabled };
}
