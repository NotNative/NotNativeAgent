// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeInvocation, invocationMessages,
  type InvocationReceipt } from '../../../lib/nnd/invocation.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => invocationMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => (isNativeFailure(value)
  ? messageFor(value.code) : messageFor('nnd_configuration_unavailable'));
const modesSentence = (modes: string[] | '*') => modes === '*'
  ? 'every mode' : modes.join(', ');
const optionSentence = (option: string | null) => option === null
  ? 'a mode selector (no option field)' : `the option field ${option}`;

/** Live native invocation-vocabulary panel: the operator flag grammar behind
 * the invocation:* census rows, one entry per row, rendered as read-only
 * language facts (aliases, argument grammar, allowed modes, host/headless
 * refusal, effect). The flags stay terminal-owned; the panel describes them
 * and never invents behavior. */
export function InvocationVocabularyPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [view, setView] = useState<InvocationReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const runRead = useCallback(async () => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy(true); setError(null);
    try {
      const next = await readNativeInvocation(controller.signal);
      if (current()) setView(next);
    } catch (failure) {
      if (current()) setError(toSentence(failure));
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null;
      setView(null); setBusy(false); setError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void runRead(); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [ready, runRead]);
  const disabled = !ready;
  return <SettingsSection item="native-invocation-vocabulary.observation">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Invocation vocabulary</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="invocation-refresh"
        disabled={disabled || busy} onClick={() => { void runRead(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">The operator flag language the native CLI accepts,
      one entry per census row. These flags stay terminal commands — the vocabulary documents them;
      it does not run them.</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the invocation vocabulary.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="invocation-error">{error}</p> : null}
    {view ? <div data-testid="invocation-receipt">
      <p className="text-xs text-muted-foreground">{view.flags.length} flags across
        {' '}{view.modes.length} modes.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        {view.flags.map((entry) => <Item key={entry.flag} entry={entry} />)}
      </dl>
    </div> : <p>{busy ? 'Reading…' : 'The vocabulary has not been read yet.'}</p>}
  </SettingsSection>;
}

function Item({ entry }: { entry: InvocationReceipt['flags'][number] }): ReactNode {
  return <>
    <dt className="font-medium">{entry.flag}</dt>
    <dd className="break-words">
      {entry.effect}
      <span className="text-muted-foreground">
        {' '}(argument: {entry.argument}; modes: {modesSentence(entry.modes)};
        {' '}{entry.headless ? 'allowed in host/headless'
          : 'refused in host/headless (the manifest is their authority)'}
        {entry.aliases.length > 0 ? `; also written ${entry.aliases.join(', ')}` : ''}
        ; parsed as {optionSentence(entry.option)})
      </span>
    </dd>
  </>;
}
