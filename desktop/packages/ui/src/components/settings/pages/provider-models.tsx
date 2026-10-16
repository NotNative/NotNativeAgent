// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react';
import { modelReference, rememberedModels, useModelCatalog } from '../../../chat/configured-model-catalog.ts';
import { setSettingsField, useSettingsStore } from '../../../lib/settings/store.ts';
import { useNativePreferenceState } from '../../../lib/settings/native-preferences.ts';
import { ProviderDiagnostics } from './provider-diagnostics.tsx';
import { ProviderRouteAction } from './provider-route-action.tsx';

type Profile = { profile_id: string; display_name?: string; model: string };
function profileNames(profile: Profile, configuredModel: string | null, catalog: Record<string, string[]>, doc: Record<string, unknown>) {
  return rememberedModels(profile.profile_id, profile.model, [...(catalog[profile.profile_id] ?? []), ...(configuredModel ? [configuredModel] : [])],
    (doc.favoriteModels as string[] | undefined) ?? [], (doc.hiddenModels as string[] | undefined) ?? []);
}
export function ProviderModels({ profiles, configured, onSaved }: {
  profiles: Profile[]; configured: { providerID: string; modelID: string } | null; onSaved: () => void;
}) {
  const [query, setQuery] = useState('');
  const catalog = useModelCatalog(state => state.models), doc = useSettingsStore(state => state.doc);
  const visible = profiles.filter(profile => profileNames(profile, configured?.providerID === profile.profile_id ? configured.modelID : null, catalog, doc)
    .some(name => `${profile.display_name || profile.profile_id} ${name}`.toLowerCase().includes(query.toLowerCase())));
  return <div className="space-y-4" data-settings-item="providers.models">
    <p className="text-xs text-muted-foreground">Favorites appear first in the conversation model picker. Hiding a model only changes the picker; existing conversations keep their selected model.</p>
    <input aria-label="Search configured models" placeholder="Search models or providers…" value={query} maxLength={256}
      onChange={event => setQuery(event.target.value)} className="w-full rounded border border-border/60 bg-background p-2 text-sm" />
    {visible.map(profile => <ProviderModelGroup key={profile.profile_id} profile={profile} query={query}
      configuredModel={configured?.providerID === profile.profile_id ? configured.modelID : null} onSaved={onSaved} />)}
    {!profiles.length ? <p>No configured providers. Add a connection first.</p> : null}
    {profiles.length > 0 && !visible.length ? <p>No matching models.</p> : null}
  </div>;
}

function ProviderModelGroup({ profile, query, configuredModel, onSaved }: {
  profile: Profile; query: string; configuredModel: string | null; onSaved: () => void;
}) {
  const catalog = useModelCatalog(state => state.models), doc = useSettingsStore(state => state.doc);
  const preferenceState = useNativePreferenceState(state => state.status);
  const [limit, setLimit] = useState(30), [chosen, setChosen] = useState<string | null>(null);
  const favorites = (doc.favoriteModels as string[] | undefined) ?? [], hidden = (doc.hiddenModels as string[] | undefined) ?? [];
  const names = profileNames(profile, configuredModel, catalog, doc);
  const matching = names.filter(name => `${profile.display_name ?? profile.profile_id} ${name}`.toLowerCase().includes(query.toLowerCase()));
  const disabled = preferenceState === 'loading' || preferenceState === 'conflict';
  const toggle = (key: string, rows: string[], ref: string) => setSettingsField(key, rows.includes(ref) ? rows.filter(row => row !== ref) : [...rows, ref]);
  return <section className="rounded-lg border border-border/50 p-3 text-xs" aria-label={`Models from ${profile.display_name || profile.profile_id}`}>
    <h3 className="mb-2 text-sm font-medium">{profile.display_name || profile.profile_id}</h3>
    <ProviderDiagnostics profileId={profile.profile_id} showCatalog={false} />
    <ul className="my-3 divide-y divide-border/30">
      {matching.slice(0, limit).map(name => { const ref = modelReference(profile.profile_id, name); return <li key={name} className="flex flex-wrap items-center gap-3 py-2">
        <button type="button" title="Use as primary model (requires Save primary route)" aria-label={`Choose primary ${name} from ${profile.profile_id}`} className="min-w-0 flex-1 break-all text-left hover:underline" onClick={() => setChosen(name)}>{name}</button>
        <label className="flex items-center gap-1"><input type="checkbox" aria-label={`Favorite ${name} from ${profile.profile_id}`} checked={favorites.includes(ref)}
          disabled={disabled || (!favorites.includes(ref) && favorites.length >= 64)} onChange={() => toggle('favoriteModels', favorites, ref)} /> Favorite</label>
        <label className="flex items-center gap-1"><input type="checkbox" aria-label={`Show ${name} from ${profile.profile_id} in picker`} checked={!hidden.includes(ref)}
          disabled={disabled || (!hidden.includes(ref) && hidden.length >= 1024)} onChange={() => toggle('hiddenModels', hidden, ref)} /> Show in picker</label>
      </li>; })}
    </ul>
    {!matching.length ? <p>No matching models.</p> : null}
    {matching.length > limit ? <button type="button" onClick={() => setLimit(value => value + 30)}>Show more models ({matching.length - limit})</button> : null}
    <ProviderRouteAction key={chosen ?? 'default'} profileId={profile.profile_id} defaultModel={profile.model} proposedModel={chosen ?? undefined}
      configuredModel={configuredModel} onApplied={onSaved} />
  </section>;
}
