// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { harnessClient } from '../lib/nnd/client.ts';
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { readDraft } from './drafts.ts';
import { toast } from 'sonner';

type Model = { providerID: string; modelID: string };
type Profile = { profile_id: string; display_name?: string; model: string };
export function ConversationSettings({ directory, draftId, model, onModel }: {
  directory: string; draftId: string; model: Model; onModel: (model: Model) => void;
}) {
  const draft = useConversationDraftStore(state => state.drafts.find(row => row.id === draftId));
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const selected = draft?.model ?? model;
  const locked = Boolean(readDraft(directory, draftId).start);
  useEffect(() => {
    let live = true;
    if (typeof harnessClient.listProviderProfiles !== 'function') return;
    void harnessClient.listProviderProfiles().then(response => {
      if (!live) return;
      if (response.error || !Array.isArray(response.data?.profiles)) { setError('Provider profiles unavailable.'); return; }
      setProfiles(response.data.profiles.filter((value): value is Profile => {
        const row = value as Profile | null;
        return !!row && typeof row.profile_id === 'string' && typeof row.model === 'string';
      }).slice(0, 128));
    }).catch(() => { if (live) setError('Provider profiles unavailable.'); });
    return () => { live = false; };
  }, []);
  const change = (value: Model) => {
    try { if (draft) useConversationDraftStore.getState().update(draft.id, { model: value }); onModel(value); }
    catch (failure) { toast.error(String(failure)); }
  };
  return <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-300" data-testid="conversation-settings">
    <span title="NNA's standard agent, with mandatory reviewer governance">Standard mode</span>
    {draft ? <select aria-label="Review policy" disabled={locked} value={draft.reviewMode} className="rounded bg-neutral-800 px-2 py-1.5" onChange={event => {
      try { useConversationDraftStore.getState().update(draft.id, { reviewMode: event.target.value as 'auto-review' | 'unattended' }); } catch (failure) { toast.error(String(failure)); }
    }}><option value="auto-review">Auto-review</option><option value="unattended">Unattended review</option></select> : <span>Auto-review</span>}
    <select aria-label="Provider profile" disabled={locked} value={selected.providerID} className="rounded bg-neutral-800 px-2 py-1.5" onChange={event => {
      const profile = profiles.find(row => row.profile_id === event.target.value); if (profile) { setModels([]); change({ providerID: profile.profile_id, modelID: profile.model }); }
    }}>
      {!profiles.some(row => row.profile_id === selected.providerID) ? <option value={selected.providerID}>{selected.providerID}</option> : null}
      {profiles.map(profile => <option key={profile.profile_id} value={profile.profile_id}>{profile.display_name || profile.profile_id}</option>)}
    </select>
    <input aria-label="Provider model" disabled={locked} list={`models-${draftId}`} maxLength={256} value={selected.modelID} className="min-w-24 max-w-56 rounded bg-neutral-800 px-2 py-1.5" onChange={event => change({ ...selected, modelID: event.target.value })} />
    <datalist id={`models-${draftId}`}>{models.map(name => <option key={name} value={name} />)}</datalist>
    <button type="button" disabled={locked} title="Discover models for the selected profile" onClick={() => {
      void harnessClient.discoverProviderModels(selected.providerID).then(response => {
        if (response.error) { toast.error(response.error); return; }
        setModels((response.data?.models ?? []).map(value => typeof value === 'string' ? value : (value as { id?: string })?.id).filter((value): value is string => !!value).slice(0, 256));
      }).catch(() => toast.error('Could not discover models. You can enter a model name.'));
    }}>Find models</button>
    {error ? <span role="status" className="text-amber-300">{error}</span> : null}
  </div>;
}
