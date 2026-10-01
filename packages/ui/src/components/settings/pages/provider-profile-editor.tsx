// SPDX-License-Identifier: Apache-2.0
/** NNA persists profiles; this form never accepts or displays credential values. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

interface EditableProfile { profile_id: string; display_name?: string; endpoint?: string; model: string }

interface ProfileFieldsPayload { display_name?: string; endpoint?: string; model: string; credential_env?: string }

type Feedback = { kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null;

function ProfileFields({ editing, id, name, endpoint, model, credentialEnv, onId, onName, onEndpoint, onModel, onCredentialEnv }: {
  editing: boolean; id: string; name: string; endpoint: string; model: string; credentialEnv: string;
  onId: (value: string) => void; onName: (value: string) => void; onEndpoint: (value: string) => void;
  onModel: (value: string) => void; onCredentialEnv: (value: string) => void;
}): ReactNode {
  const { t } = useI18n();
  return <>
    {!editing ? <Field label={t('settings.providers.profile.id')} value={id} onChange={onId} maxLength={64} testId="provider-profile-id" /> : null}
    <Field label={t('settings.providers.profile.name')} value={name} onChange={onName} maxLength={4096} testId="provider-profile-name" />
    <Field label={editing ? t('settings.providers.profile.editEndpoint') : t('settings.providers.profile.endpoint')}
      value={endpoint} onChange={onEndpoint} maxLength={4096} testId="provider-profile-endpoint" />
    <Field label={t('settings.providers.profile.model')} value={model} onChange={onModel} maxLength={4096} testId="provider-profile-model" />
    <Field label={t('settings.providers.profile.credential')} value={credentialEnv} onChange={onCredentialEnv} maxLength={4096} />
    <p className="w-full text-muted-foreground">{t('settings.providers.profile.credentialHint')}</p>
  </>;
}

function profileEcho(value: unknown, expected: Record<string, unknown>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return Object.entries(expected).every(([key, expectedValue]) => profile[key] === expectedValue);
}

function profileRequest({ profile, id, name, endpoint, model, credentialEnv }: {
  profile?: EditableProfile; id: string; name: string; endpoint: string; model: string; credentialEnv: string;
}): { fields: ProfileFieldsPayload; expected: Record<string, unknown> } {
  const profileId = profile?.profile_id ?? id;
  const displayName = name.trim() || (profile ? profile.display_name : id);
  const effectiveEndpoint = profile ? endpoint || profile.endpoint || '' : endpoint;
  const credential = credentialEnv.trim();
  const fields: ProfileFieldsPayload = {
    ...(displayName ? { display_name: displayName } : {}),
    ...(effectiveEndpoint ? { endpoint: effectiveEndpoint } : {}),
    model,
    ...(credential ? { credential_env: credential } : {}),
  };
  const expected = {
    profile_id: profileId,
    model,
    ...(fields.display_name !== undefined ? { display_name: fields.display_name } : {}),
    ...(fields.endpoint !== undefined ? { endpoint: fields.endpoint } : {}),
    ...(credential ? { credential_env: credential } : {}),
  };
  return { fields, expected };
}

export function ProviderProfileEditor({ profile, onSaved }: {
  profile?: EditableProfile; onSaved: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState(profile?.display_name ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState(profile?.model ?? '');
  const [credentialEnv, setCredentialEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const editing = Boolean(profile);
  const save = async (): Promise<void> => {
    const trimmedId = id.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedModel = model.trim();
    if ((!editing && (!trimmedId || !trimmedEndpoint)) || !trimmedModel) return;
    setBusy(true);
    setFeedback(null);
    try {
      const { fields, expected } = profileRequest({
        profile, id: trimmedId, name, endpoint: trimmedEndpoint, model: trimmedModel, credentialEnv,
      });
      const result = profile
        ? await harnessClient.updateProviderProfile(profile.profile_id, fields)
        : await harnessClient.createProviderProfile({ profile_id: trimmedId, ...fields, endpoint: trimmedEndpoint });
      if (result.error || !profileEcho(result.data?.profile, expected)) setFeedback(result.error
        ? { kind: 'raw', message: result.error }
        : { kind: 'key', key: 'settings.providers.profile.notConfirmed' });
      else { setOpen(false); if (!profile) { setId(''); setName(''); setEndpoint(''); setModel(''); setCredentialEnv(''); } onSaved(); }
    } catch { setFeedback({ kind: 'key', key: 'settings.providers.profile.unavailable' }); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 text-xs">
    <button type="button" data-testid="provider-profile-toggle" disabled={busy} onClick={() => { setOpen(!open); setFeedback(null); }}
      className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
      {open ? t('settings.providers.profile.cancel') : editing ? t('settings.providers.profile.edit') : t('settings.providers.profile.add')}
    </button>
    {open ? <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border/40 p-2">
      <ProfileFields editing={editing} id={id} name={name} endpoint={endpoint} model={model} credentialEnv={credentialEnv}
        onId={setId} onName={setName} onEndpoint={setEndpoint} onModel={setModel} onCredentialEnv={setCredentialEnv} />
      <button type="button" data-testid="provider-profile-save" disabled={busy || !model.trim() || (!editing && (!id.trim() || !endpoint.trim()))}
        onClick={() => { void save(); }} className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
        {busy ? t('settings.providers.profile.saving') : editing ? t('settings.providers.profile.save') : t('settings.providers.profile.create')}
      </button>
      {feedback ? <p role="alert" className="w-full text-destructive">{feedback.kind === 'raw' ? feedback.message : t(feedback.key)}</p> : null}
    </div> : null}
  </div>;
}

function Field({ label, value, onChange, maxLength, testId }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number; testId?: string;
}): ReactNode {
  return <label className="flex flex-col gap-1 text-muted-foreground">{label}
    <input data-testid={testId} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)}
      className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
  </label>;
}
