// SPDX-License-Identifier: Apache-2.0
/** NNA persists profiles; this form never accepts or displays credential values. */
import { useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';

interface EditableProfile { profile_id: string; display_name?: string; model: string }

export function ProviderProfileEditor({ profile, onSaved }: {
  profile?: EditableProfile; onSaved: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [name, setName] = useState(profile?.display_name ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState(profile?.model ?? '');
  const [credentialEnv, setCredentialEnv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(profile);
  const save = async (): Promise<void> => {
    const trimmedId = id.trim();
    const trimmedEndpoint = endpoint.trim();
    const trimmedModel = model.trim();
    if ((!editing && (!trimmedId || !trimmedEndpoint)) || !trimmedModel) return;
    setBusy(true);
    setError(null);
    try {
      const fields = {
        display_name: name.trim() || (profile?.display_name ?? trimmedId),
        ...(trimmedEndpoint ? { endpoint: trimmedEndpoint } : {}),
        model: trimmedModel,
        ...(credentialEnv.trim() ? { credential_env: credentialEnv.trim() } : {}),
      };
      const result = profile
        ? await harnessClient.updateProviderProfile(profile.profile_id, fields)
        : await harnessClient.createProviderProfile({ profile_id: trimmedId, ...fields, endpoint: trimmedEndpoint });
      if (result.error || !result.data?.profile) setError(result.error ?? 'NNA did not confirm the profile change.');
      else {
        setOpen(false);
        if (!profile) { setId(''); setName(''); setEndpoint(''); setModel(''); setCredentialEnv(''); }
        onSaved();
      }
    } catch { setError('NNA profile change is unavailable.'); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 text-xs">
    <button type="button" disabled={busy} onClick={() => { setOpen(!open); setError(null); }}
      className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
      {open ? 'Cancel profile edit' : editing ? 'Edit profile' : 'Add provider profile'}
    </button>
    {open ? <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border/40 p-2">
      {!editing ? <Field label="Profile ID" value={id} onChange={setId} maxLength={64} /> : null}
      <Field label="Display name" value={name} onChange={setName} maxLength={4096} />
      <Field label={editing ? 'New endpoint (blank keeps current)' : 'Endpoint URL'} value={endpoint} onChange={setEndpoint} maxLength={4096} />
      <Field label="Default model" value={model} onChange={setModel} maxLength={4096} />
      <Field label="Credential environment variable (optional; blank keeps current)" value={credentialEnv} onChange={setCredentialEnv} maxLength={4096} />
      <p className="w-full text-muted-foreground">Enter a variable name, not a secret value. NNA validates the endpoint and stores the reference. Saved changes affect new sessions only after provider routing is applied.</p>
      <button type="button" disabled={busy || !model.trim() || (!editing && (!id.trim() || !endpoint.trim()))}
        onClick={() => { void save(); }} className="rounded border border-border/60 px-2 py-1 text-foreground disabled:opacity-50">
        {busy ? 'Saving profile…' : editing ? 'Save profile changes' : 'Create profile'}
      </button>
      {error ? <p role="alert" className="w-full text-destructive">{error}</p> : null}
    </div> : null}
  </div>;
}

function Field({ label, value, onChange, maxLength }: {
  label: string; value: string; onChange: (value: string) => void; maxLength: number;
}): ReactNode {
  return <label className="flex flex-col gap-1 text-muted-foreground">{label}
    <input value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)}
      className="w-52 rounded border border-border/60 bg-background px-2 py-1 text-foreground" />
  </label>;
}
