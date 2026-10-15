// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from 'react';
import { useConfiguredModels } from './configured-models.ts';

export type ConversationModel = { providerID: string; modelID: string };
export function ConfiguredModelPicker({ selected, disabled, onPick }: {
  selected: ConversationModel; disabled: boolean; onPick: (value: ConversationModel) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const { profiles, models, error, loading, retry } = useConfiguredModels(open);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const groups = profiles.map(profile => ({ profile, names: (models[profile.profile_id] ?? [profile.model])
    .filter(name => `${profile.display_name || profile.profile_id} ${name}`.toLowerCase().includes(query.toLowerCase())) }));
  return <div className="relative ml-auto min-w-0" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  }} onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button ref={trigger} type="button" aria-label="Choose model" aria-expanded={open} disabled={disabled}
      title={`${selected.providerID} · ${selected.modelID}`} className="max-w-64 truncate rounded-md px-2 py-1.5 hover:bg-white/5 disabled:opacity-50"
      onClick={() => setOpen(value => !value)}>{selected.modelID} <span aria-hidden>⌄</span></button>
    {open ? <div role="dialog" aria-label="Choose model" className="absolute bottom-full right-0 z-30 mb-2 max-h-80 w-80 overflow-auto rounded-xl border border-white/10 bg-neutral-800 p-2 shadow-xl">
      <input autoFocus aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.target.value)} className="mb-2 w-full rounded-md bg-neutral-900 p-2 outline-none" />
      {groups.map(({ profile, names }) => names.length ? <div key={profile.profile_id}>
        <div className="px-2 py-1 text-neutral-400">{profile.display_name || profile.profile_id}</div>
        {names.map(name => <button key={name} type="button" aria-label={`Use ${name} from ${profile.display_name || profile.profile_id}`}
          className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-white/10"
          onClick={() => { onPick({ providerID: profile.profile_id, modelID: name }); close(); }}>{name}
          {selected.providerID === profile.profile_id && selected.modelID === name ? <span aria-label="Selected">✓</span> : null}</button>)}
      </div> : null)}
      {!groups.some(group => group.names.length) && !loading ? <p className="p-2 text-neutral-400">{profiles.length ? 'No matching models' : 'No configured providers'}</p> : null}
      {loading ? <p role="status" className="p-2 text-neutral-400">Loading available models…</p> : null}
      {error ? <div role="status" className="p-2 text-amber-300">{error} <button type="button" className="underline" onClick={retry}>Retry</button></div> : null}
    </div> : null}
  </div>;
}
