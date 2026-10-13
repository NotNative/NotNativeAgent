// SPDX-License-Identifier: Apache-2.0
/** NNA persists profiles; this form never accepts or displays credential values. */
import { useEffect, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { readBrokerSecrets, type PublicSecret } from '../../../lib/nnd/secret-actions.ts';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

interface EditableProfile {
  profile_id: string; display_name?: string; endpoint?: string; model: string;
  credential?: { source: 'secret'; secret_id: string; field: string } | null;
  credential_env?: string | null;
  context_limit_bytes?: number | null; output_limit_tokens?: number | null;
  tool_call_mode?: 'single' | 'batch';
}

type CredentialChoice = '' | 'environment' | 'secret' | 'clear';

interface ProfileFieldsPayload {
  display_name?: string; endpoint?: string; model?: string; credential_env?: string;
  credential?: { source: 'secret'; secret_id: string; field: string } | null;
  context_limit_bytes?: number; output_limit_tokens?: number; tool_call_mode?: 'single' | 'batch';
}

type Feedback = { kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null;

// Mirrors NNA src/credential-bindings.js and src/configuration-rules.js exactly.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SECRET_ID = /^sec_[A-Za-z0-9-]{1,128}$/u;
const SECRET_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const CONTEXT_LIMIT = { min: 65_536, max: 16_777_216 };
const OUTPUT_LIMIT = { min: 1, max: 1_048_576 };

type LimitDraft = { ok: true; value: number | null } | { ok: false };

function boundedInteger(value: string, bounds: { min: number; max: number }): LimitDraft {
  const trimmed = value.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^[1-9]\d*$/u.test(trimmed)) return { ok: false };
  const parsed = Number(trimmed);
  return parsed >= bounds.min && parsed <= bounds.max ? { ok: true, value: parsed } : { ok: false };
}

// Reference KIND only. Names, secret ids, and fields stay in state and on the
// wire; the rendered page never echoes credential material of any kind
// (window.test.tsx pins credential_env inventories against DOM leakage).
function bindingKind(profile: EditableProfile): 'secret' | 'environment' | null {
  if (profile.credential) return 'secret';
  if (typeof profile.credential_env === 'string' && profile.credential_env) return 'environment';
  return null;
}

function credentialPayload(choice: CredentialChoice, envName: string, secretId: string, field: string):
  { payload?: Pick<ProfileFieldsPayload, 'credential' | 'credential_env'>; problem?: I18nKey } {
  if (choice === 'clear') return { payload: { credential: null } };
  if (choice === 'secret') {
    if (!SECRET_ID.test(secretId) || !SECRET_FIELD.test(field)) return { problem: 'settings.providers.profile.secretIncomplete' };
    return { payload: { credential: { source: 'secret', secret_id: secretId, field } } };
  }
  if (choice === 'environment') {
    if (!envName.trim()) return { problem: 'settings.providers.profile.envMissing' };
    if (!ENV_NAME.test(envName.trim())) return { problem: 'settings.providers.profile.envInvalid' };
    return { payload: { credential_env: envName.trim() } };
  }
  return {};
}

function profileRequest({ profile, id, name, endpoint, model, credentialEnv, choice, secretId, secretField, contextLimit, outputLimit, toolCallMode }: {
  profile?: EditableProfile; id: string; name: string; endpoint: string; model: string; credentialEnv: string;
  choice: CredentialChoice; secretId: string; secretField: string; contextLimit: string; outputLimit: string; toolCallMode: string;
}): { fields: ProfileFieldsPayload; expected: Record<string, unknown>; problem?: I18nKey } {
  const profileId = profile?.profile_id ?? id;
  const displayName = name.trim() || (profile ? profile.display_name : id);
  const effectiveEndpoint = profile ? endpoint || profile.endpoint || '' : endpoint;
  const context = boundedInteger(contextLimit, CONTEXT_LIMIT);
  const output = boundedInteger(outputLimit, OUTPUT_LIMIT);
  if (!context.ok || !output.ok) return { fields: {}, expected: {}, problem: 'settings.providers.profile.limitInvalid' };
  const credential = profile
    ? credentialPayload(choice, credentialEnv, secretId, secretField)
    : credentialPayload(credentialEnv.trim() ? 'environment' : '', credentialEnv, '', '');
  if (credential.problem) return { fields: {}, expected: {}, problem: credential.problem };
  const fields: ProfileFieldsPayload = {
    ...(displayName ? { display_name: displayName } : {}),
    ...(effectiveEndpoint ? { endpoint: effectiveEndpoint } : {}),
    model,
    ...credential.payload,
    ...(context.value !== null ? { context_limit_bytes: context.value } : {}),
    ...(output.value !== null ? { output_limit_tokens: output.value } : {}),
    ...(toolCallMode === 'single' || toolCallMode === 'batch' ? { tool_call_mode: toolCallMode } : {}),
  };
  const expected: Record<string, unknown> = {
    profile_id: profileId,
    model,
    ...(fields.display_name !== undefined ? { display_name: fields.display_name } : {}),
    ...(fields.endpoint !== undefined ? { endpoint: fields.endpoint } : {}),
    ...(fields.context_limit_bytes !== undefined ? { context_limit_bytes: fields.context_limit_bytes } : {}),
    ...(fields.output_limit_tokens !== undefined ? { output_limit_tokens: fields.output_limit_tokens } : {}),
    ...(fields.tool_call_mode !== undefined ? { tool_call_mode: fields.tool_call_mode } : {}),
    ...(fields.credential_env !== undefined ? { credential_env: fields.credential_env } : {}),
    // A secret binding echo is an object; profileEcho compares scalars only,
    // and NNA rejects malformed bindings at its own contract boundary.
    // Clearing must land BOTH reference channels null.
    ...(fields.credential === null ? { credential: null, credential_env: null } : {}),
  };
  return { fields, expected };
}

function ProfileFields({ editing, id, name, endpoint, model, credentialEnv, choice, secretIndex, secretField, roster, rosterError, onChoice, onSecretIndex, onSecretField, onId, onName, onEndpoint, onModel, onCredentialEnv }: {
  editing: boolean; id: string; name: string; endpoint: string; model: string; credentialEnv: string;
  choice: CredentialChoice; secretIndex: string; secretField: string; roster: readonly PublicSecret[] | null; rosterError: boolean;
  onChoice: (choice: CredentialChoice) => void; onSecretIndex: (index: string) => void; onSecretField: (field: string) => void;
  onId: (value: string) => void; onName: (value: string) => void; onEndpoint: (value: string) => void;
  onModel: (value: string) => void; onCredentialEnv: (value: string) => void;
}): ReactNode {
  const { t } = useI18n();
  const selected = secretIndex === '' ? null : (roster ?? [])[Number(secretIndex) - 1] ?? null;
  return <>
    {!editing ? <Field label={t('settings.providers.profile.id')} value={id} onChange={onId} maxLength={64} testId="provider-profile-id" /> : null}
    <Field label={t('settings.providers.profile.name')} value={name} onChange={onName} maxLength={4096} testId="provider-profile-name" />
    <Field label={editing ? t('settings.providers.profile.editEndpoint') : t('settings.providers.profile.endpoint')}
      value={endpoint} onChange={onEndpoint} maxLength={4096} testId="provider-profile-endpoint" />
    <Field label={t('settings.providers.profile.model')} value={model} onChange={onModel} maxLength={4096} testId="provider-profile-model" />
    {editing ? <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.credentialSource')}
      <select data-testid="provider-profile-credential-source" value={choice} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground"
        onChange={(event) => onChoice(event.target.value as CredentialChoice)}>
        <option value="">{t('settings.providers.profile.credentialKeep')}</option>
        <option value="environment">{t('settings.providers.profile.credentialEnvironment')}</option>
        <option value="secret">{t('settings.providers.profile.credentialSecret')}</option>
        <option value="clear">{t('settings.providers.profile.credentialClear')}</option>
      </select></label> : null}
    {choice === 'secret' ? <div className="flex w-full flex-wrap gap-2">
      <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.secretRoster')}
        <select data-testid="provider-profile-secret-select" value={secretIndex} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground"
          onChange={(event) => { onSecretIndex(event.target.value); onSecretField(''); }}>
          <option value=""></option>
          {(roster ?? []).map((secret, index) => <option key={secret.id} value={String(index + 1)}
            data-testid="provider-profile-secret-option">{index + 1}</option>)}
        </select></label>
      {selected ? <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.secretField')}
        <select data-testid="provider-profile-secret-field" value={secretField} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground"
          onChange={(event) => onSecretField(event.target.value)}>
          <option value=""></option>
          {selected.fields.map((field) => <option key={field} value={field}>{field}</option>)}
        </select></label> : null}
      {rosterError ? <p className="w-full text-muted-foreground">{t('settings.providers.profile.brokerUnavailable')}</p> : null}
    </div> : null}
    {choice !== 'secret' && choice !== 'clear' ? <>
      <Field label={editing ? t('settings.providers.profile.credentialEdit') : t('settings.providers.profile.credential')}
        value={credentialEnv} onChange={onCredentialEnv} maxLength={4096} testId="provider-profile-credential-env" />
      <p className="w-full text-muted-foreground">{t('settings.providers.profile.credentialHint')}</p>
    </> : null}
  </>;
}

function useDrafts(profile?: EditableProfile) {
  const [id, setId] = useState('');
  const [name, setName] = useState(profile?.display_name ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState(profile?.model ?? '');
  const [credentialEnv, setCredentialEnv] = useState('');
  const [choice, setChoice] = useState<CredentialChoice>('');
  const [secretIndex, setSecretIndex] = useState('');
  const [secretField, setSecretField] = useState('');
  const [contextLimit, setContextLimit] = useState(profile?.context_limit_bytes != null ? String(profile.context_limit_bytes) : '');
  const [outputLimit, setOutputLimit] = useState(profile?.output_limit_tokens != null ? String(profile.output_limit_tokens) : '');
  const [toolCallMode, setToolCallMode] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  return { id, setId, name, setName, endpoint, setEndpoint, model, setModel, credentialEnv, setCredentialEnv,
    choice, setChoice, secretIndex, setSecretIndex, secretField, setSecretField, contextLimit, setContextLimit,
    outputLimit, setOutputLimit, toolCallMode, setToolCallMode, busy, setBusy, feedback, setFeedback };
}

function useRoster(open: boolean, choice: CredentialChoice): { roster: readonly PublicSecret[] | null; rosterError: boolean } {
  const [roster, setRoster] = useState<readonly PublicSecret[] | null>(null);
  const [rosterError, setRosterError] = useState(false);
  useEffect(() => {
    if (!open || choice !== 'secret') {
      // Broker failures are not sticky: leaving the secret choice re-arms the picker.
      if (choice !== 'secret') setRosterError(false);
      return;
    }
    if (roster !== null || rosterError) return;
    const controller = new AbortController();
    readBrokerSecrets(controller.signal).then(
      (secrets) => { if (!controller.signal.aborted) setRoster(secrets); },
      () => { if (!controller.signal.aborted) setRosterError(true); });
    return () => { controller.abort(); };
  }, [open, choice, roster, rosterError]);
  return { roster, rosterError };
}

function LimitFields({ contextLimit, outputLimit, toolCallMode, onContext, onOutput, onToolCall }: {
  contextLimit: string; outputLimit: string; toolCallMode: string;
  onContext: (value: string) => void; onOutput: (value: string) => void; onToolCall: (value: string) => void;
}): ReactNode {
  const { t } = useI18n();
  return <>
    <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.contextLimit')}
      <input data-testid="provider-profile-context-limit" type="number" min={CONTEXT_LIMIT.min} max={CONTEXT_LIMIT.max} value={contextLimit}
        onChange={(event) => onContext(event.target.value)} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground" /></label>
    <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.outputLimit')}
      <input data-testid="provider-profile-output-limit" type="number" min={OUTPUT_LIMIT.min} max={OUTPUT_LIMIT.max} value={outputLimit}
        onChange={(event) => onOutput(event.target.value)} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground" /></label>
    <label className="flex flex-col gap-1 text-muted-foreground">{t('settings.providers.profile.toolCallMode')}
      <select data-testid="provider-profile-tool-call-mode" value={toolCallMode} className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground"
        onChange={(event) => onToolCall(event.target.value)}>
        <option value="">{t('settings.providers.profile.toolCallKeep')}</option>
        <option value="single">single</option>
        <option value="batch">batch</option>
      </select></label>
    <p className="w-full text-muted-foreground">{t('settings.providers.profile.limitsHint')}</p>
  </>;
}

async function submitProfile({ profile, editing, draft, secretOptions, setOpen, onSaved }: {
  profile?: EditableProfile; editing: boolean; draft: ReturnType<typeof useDrafts>;
  secretOptions: readonly PublicSecret[]; setOpen: (open: boolean) => void; onSaved: () => void;
}): Promise<void> {
  const trimmedId = draft.id.trim();
  const trimmedEndpoint = draft.endpoint.trim();
  const trimmedModel = draft.model.trim();
  if ((!editing && (!trimmedId || !trimmedEndpoint)) || !trimmedModel) return;
  draft.setBusy(true);
  draft.setFeedback(null);
  try {
    const secret = draft.choice === 'secret' && draft.secretIndex !== ''
      ? secretOptions[Number(draft.secretIndex) - 1]?.id ?? '' : '';
    const { fields, expected, problem } = profileRequest({
      profile, id: trimmedId, name: draft.name, endpoint: trimmedEndpoint, model: trimmedModel,
      credentialEnv: draft.credentialEnv, choice: draft.choice, secretId: secret,
      secretField: draft.secretField, contextLimit: draft.contextLimit, outputLimit: draft.outputLimit,
      toolCallMode: draft.toolCallMode,
    });
    if (problem) { draft.setFeedback({ kind: 'key', key: problem }); return; }
    const result = profile
      ? await harnessClient.updateProviderProfile(profile.profile_id, fields)
      : await harnessClient.createProviderProfile({ profile_id: trimmedId, ...fields, endpoint: trimmedEndpoint });
    if (result.error || !profileEcho(result.data?.profile, expected)) draft.setFeedback(result.error
      ? { kind: 'raw', message: result.error }
      : { kind: 'key', key: 'settings.providers.profile.notConfirmed' });
    else {
      setOpen(false);
      if (!profile) {
        draft.setId(''); draft.setName(''); draft.setEndpoint(''); draft.setModel(''); draft.setCredentialEnv('');
        draft.setContextLimit(''); draft.setOutputLimit(''); draft.setToolCallMode('');
        draft.setChoice(''); draft.setSecretIndex(''); draft.setSecretField('');
      }
      onSaved();
    }
  } catch { draft.setFeedback({ kind: 'key', key: 'settings.providers.profile.unavailable' }); }
  finally { draft.setBusy(false); }
}

export function ProviderProfileEditor({ profile, onSaved }: {
  profile?: EditableProfile; onSaved: () => void;
}): ReactNode {
  const { t } = useI18n();
  const draft = useDrafts(profile);
  const [open, setOpen] = useState(false);
  const { roster, rosterError } = useRoster(open, draft.choice);
  const editing = Boolean(profile);
  const secretOptions = (roster ?? []).filter((secret) => secret.enabled);
  const currentKind = editing ? bindingKind(profile as EditableProfile) : null;
  return <div className="mt-2 text-xs">
    {currentKind ? <p data-testid="provider-profile-current-binding" className="text-muted-foreground">
      {t('settings.providers.profile.currentBinding')} {currentKind === 'secret'
        ? t('settings.providers.profile.credentialSecret') : t('settings.providers.profile.credentialEnvironment')}</p> : null}
    <button type="button" data-testid="provider-profile-toggle" disabled={draft.busy} onClick={() => { setOpen(!open); draft.setFeedback(null); }}
      className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
      {open ? t('settings.providers.profile.cancel') : editing ? t('settings.providers.profile.edit') : t('settings.providers.profile.add')}
    </button>
    {open ? <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border/40 p-2">
      <ProfileFields editing={editing} id={draft.id} name={draft.name} endpoint={draft.endpoint} model={draft.model} credentialEnv={draft.credentialEnv}
        choice={draft.choice} secretIndex={draft.secretIndex} secretField={draft.secretField} roster={secretOptions} rosterError={rosterError}
        onChoice={(next) => { draft.setChoice(next); if (next !== 'secret') { draft.setSecretIndex(''); draft.setSecretField(''); } }}
        onSecretIndex={draft.setSecretIndex} onSecretField={draft.setSecretField}
        onCredentialEnv={(value) => {
          // Typed environment text must never be silently discarded: editing the
          // box while 'Keep the current binding' is selected switches to it.
          draft.setCredentialEnv(value);
          if (editing && value.trim() && draft.choice === '') draft.setChoice('environment');
        }}
        onId={draft.setId} onName={draft.setName} onEndpoint={draft.setEndpoint} onModel={draft.setModel} />
      <LimitFields contextLimit={draft.contextLimit} outputLimit={draft.outputLimit} toolCallMode={draft.toolCallMode}
        onContext={draft.setContextLimit} onOutput={draft.setOutputLimit} onToolCall={draft.setToolCallMode} />
      <button type="button" data-testid="provider-profile-save" disabled={draft.busy || !draft.model.trim() || (!editing && (!draft.id.trim() || !draft.endpoint.trim()))}
        onClick={() => { void submitProfile({ profile, editing, draft, secretOptions, setOpen, onSaved }); }} className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
        {draft.busy ? t('settings.providers.profile.saving') : editing ? t('settings.providers.profile.save') : t('settings.providers.profile.create')}
      </button>
      {draft.feedback ? <p role="alert" className="w-full text-destructive">{draft.feedback.kind === 'raw' ? draft.feedback.message : t(draft.feedback.key)}</p> : null}
    </div> : null}
  </div>;
}

function profileEcho(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, expectedValue]) => profile[key] === expectedValue);
}

function Field({ label, value, onChange, maxLength, testId }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number; testId?: string;
}): ReactNode {
  return <label className="flex flex-col gap-1 text-muted-foreground">{label}
    <input data-testid={testId} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)}
      className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
  </label>;
}
