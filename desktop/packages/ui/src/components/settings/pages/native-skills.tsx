// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { readNativeSkillsCatalog, skillsMessages, type NativeSkillsCatalogReceipt } from '../../../lib/nnd/skills.ts';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';

const messageFor = (code: string) => skillsMessages[code] ?? code;
const isNativeFailure = (value: unknown): value is { code: string } =>
  value instanceof Object && 'code' in value && typeof (value as { code?: unknown }).code === 'string';
const toSentence = (value: unknown) => (isNativeFailure(value) ? messageFor(value.code)
  : messageFor('nnd_skills_unavailable'));

/** Native skills_action observation: the served workspace's SkillRegistry
 * catalog read through GET /v1/nnd/configuration/skills/catalog. Distinct
 * from the opencode skill-source browser (SkillsCatalogPage). */
export function NativeSkillsPanel(): ReactNode {
  const auth = useAuthSessionStore(state => state.status);
  const subscribe = useCallback((listener: () => void) => subscribeAuthority(listener), []);
  const authority = useSyncExternalStore(subscribe, authorityState);
  const [receipt, setReceipt] = useState<NativeSkillsCatalogReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const ready = auth === 'ok' && authority === 'ready';
  const run = useCallback(async () => {
    if (pending.current || authorityState() !== 'ready'
      || useAuthSessionStore.getState().status !== 'ok') return;
    const controller = new AbortController();
    pending.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => !controller.signal.aborted && pending.current === controller
      && runtime === getRuntimeKey() && origin === getApiBaseUrl();
    setBusy(true); setError(null);
    try {
      const next = await readNativeSkillsCatalog(controller.signal);
      if (current()) setReceipt(next);
    } catch (failure) {
      if (current()) setError(toSentence(failure));
    } finally {
      if (current()) { pending.current = null; setBusy(false); }
    }
  }, []);
  const started = useRef(false);
  useEffect(() => {
    const reset = () => { pending.current?.abort(); pending.current = null; setReceipt(null); setBusy(false); setError(null); };
    reset();
    const unsubscribe = onRuntimeEndpointChanged(() => { started.current = false; reset(); });
    if (ready && !started.current) { started.current = true; void run(); }
    if (!ready) started.current = false;
    return () => { unsubscribe(); pending.current?.abort(); pending.current = null; };
  }, [ready, run]);
  const disabled = busy || !ready;
  return <SettingsSection item="native-skills.catalog">
    <div className="flex items-center justify-between gap-3">
      <SettingsGroupTitle>Native skills catalog</SettingsGroupTitle>
      <button type="button" className="btn-secondary" data-testid="native-skills-refresh"
        disabled={disabled} onClick={() => { void run(); }}>Refresh</button>
    </div>
    <p className="text-xs text-muted-foreground">The skill files the served workspace can invoke
      (bundled, user, and — when the workspace is trusted — its project skills), read through the
      native registry authority; bodies are never rendered, only their digests.</p>
    {!ready ? <p role="status">{auth !== 'ok'
      ? 'Sign in to read the native skills catalog observation.'
      : 'Native authority is resynchronizing; reading is paused.'}</p> : null}
    {error ? <p role="alert" data-testid="native-skills-error">{error}</p> : null}
    {receipt ? <Receipt receipt={receipt} />
      : <p>{busy ? 'Reading…' : 'The catalog has not been read yet.'}</p>}
  </SettingsSection>;
}

function Receipt({ receipt }: { receipt: NativeSkillsCatalogReceipt }): ReactNode {
  return <div data-testid="native-skills-receipt" className="text-xs">
    <p>{receipt.catalog.length} skill{receipt.catalog.length === 1 ? '' : 's'} registered —
      workspace {String(receipt.scope_root)} is {receipt.trusted ? 'trusted'
        : 'untrusted (project skills excluded)'}.</p>
    <ul className="list-disc pl-5">
      {receipt.catalog.map((entry) => <li key={entry.id}>
        <span className="font-mono">{entry.id}</span> ({entry.version}, {entry.invocation},
        from {entry.source}{entry.requires_tools.length > 0
          ? `, requires ${entry.requires_tools.join(', ')}` : ''},
        sha256:{entry.body_sha256.slice(0, 12)}…)
        {entry.description ? ` — ${entry.description}` : ''}
      </li>)}
    </ul>
    {receipt.diagnostics.length > 0 ? <p data-testid="native-skills-diagnostics">
      {receipt.diagnostics.length} entr{receipt.diagnostics.length === 1 ? 'y' : 'ies'} skipped:
      {' '}{receipt.diagnostics.map((item) => `[${item.scope}] ${item.message}`).join('; ')}
    </p> : null}
  </div>;
}
