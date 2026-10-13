// SPDX-License-Identifier: Apache-2.0
/**
 * Snippets settings page (P9-4e-ii, doc 03 §5.x "Snippets"): manage the
 * text-expansion macros end-to-end over the config-entity family — create
 * (409 keeps the form with the verbatim refusal), inline text edit (the
 * PATCH merge), delete, and an explicit refresh. Every successful change
 * republishes the shared `snippets-source` roster so the composer's `#`
 * picker and the editor's snippet source stay current without a reload.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  createSnippet, deleteSnippet, listSnippets, patchSnippet, snippetRecords, type SnippetRecord,
} from '../../../lib/snippets-api.ts';
import { refreshSnippets } from '../../../lib/snippets-source.ts';
import { SettingsGroupTitle, SettingsSection } from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';

const NAME_PATTERN = /^[\w-]{1,64}$/u;

export function SnippetsPage(): ReactNode {
  const { t } = useI18n();
  const [roster, setRoster] = useState<SnippetRecord[] | null>(null);
  const [error, setError] = useState<{ kind: 'key'; key: I18nKey } | { kind: 'raw'; message: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => { setRevision((value) => value + 1); }, []);

  useEffect(() => {
    let current = true;
    void listSnippets().then((outcome) => {
      if (!current) return;
      if (!outcome.ok || !snippetRecords(outcome.snippets)) {
        // apiJson stamps ok onto ANY 200 body - a malformed payload must not
        // masquerade as an empty roster, so it refuses like a failed request.
        setRoster(null);
        setError(outcome.ok
          ? { kind: 'key', key: 'settings.snippets.error.malformed' }
          : { kind: 'raw', message: outcome.error });
        return;
      }
      setRoster(outcome.snippets);
      setError(null);
    }).catch(() => { if (current) setError({ kind: 'key', key: 'settings.snippets.error.request' }); });
    return () => { current = false; };
  }, [revision]);

  return (
    <SettingsSection item="snippets.roster">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.snippets.title')}</SettingsGroupTitle>
        <button type="button" data-testid="snippets-refresh" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground" onClick={reload}>{t('settings.snippets.refresh')}</button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('settings.snippets.description.start')} <code>#name</code> {t('settings.snippets.description.end')}
      </p>
      {error !== null ? <p role="alert" className="text-xs text-destructive">{error.kind === 'raw' ? error.message : t(error.key)}</p> : null}
      {!error && roster?.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.snippets.empty')}</p> : null}
      {roster?.map((record) => (
        <SnippetRow key={record.name} record={record} onRemoved={reload} />
      ))}
      <NewSnippetForm onCreated={reload} />
    </SettingsSection>
  );
}

function NewSnippetForm({ onCreated }: { onCreated: () => void }): ReactNode {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  const create = async (): Promise<void> => {
    if (!NAME_PATTERN.test(name)) { toast.error(t('settings.snippets.error.invalidName', { pattern: '[\\w-]{1,64}' })); return; }
    const outcome = await createSnippet(name, { text });
    if (!outcome.ok) { toast.error(outcome.error); return; }
    setName(''); setText('');
    toast.success(t('settings.snippets.toast.saved'));
    onCreated();
    void refreshSnippets();
  };

  return (
    <div className="mt-2 rounded border border-border/60 p-2" data-testid="snippets-new">
      <div className="flex items-center gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('settings.snippets.form.name')}
          data-testid="snippets-new-name" data-settings-item="snippets.new-name" aria-label={t('settings.snippets.form.name')}
          className="w-40 rounded bg-transparent px-1 py-0.5 text-xs text-foreground outline-none border border-border/60" />
        <input value={text} onChange={(event) => setText(event.target.value)} placeholder={t('settings.snippets.form.expansion')}
          data-testid="snippets-new-text" aria-label={t('settings.snippets.form.expansion')}
          className="flex-1 rounded bg-transparent px-1 py-0.5 text-xs text-foreground outline-none border border-border/60" />
        <button type="button" data-testid="snippets-create" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground" onClick={() => { void create(); }}>{t('settings.snippets.action.save')}</button>
      </div>
    </div>
  );
}

function SnippetRow({ record, onRemoved }: { record: SnippetRecord; onRemoved: () => void }): ReactNode {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.text);

  const save = async (): Promise<void> => {
    const outcome = await patchSnippet(record.name, { text: draft });
    if (!outcome.ok) { toast.error(outcome.error); return; }
    setEditing(false);
    toast.success(t('settings.snippets.toast.saved'));
    onRemoved();
    void refreshSnippets();
  };

  const remove = async (): Promise<void> => {
    const outcome = await deleteSnippet(record.name);
    if (!outcome.ok) { toast.error(outcome.error); return; }
    toast.success(t('settings.snippets.toast.deleted'));
    onRemoved();
    void refreshSnippets();
  };

  return (
    <div className="mt-1 flex items-center gap-2 rounded border border-border/40 px-2 py-1" data-testid="snippets-row">
      {editing ? (
        <>
          <input value={draft} onChange={(event) => setDraft(event.target.value)} data-testid="snippets-edit-text" aria-label={t('settings.snippets.form.text')}
            className="flex-1 rounded bg-transparent px-1 py-0.5 text-xs text-foreground outline-none border border-border/60" />
          <button type="button" data-testid="snippets-save" className="rounded border border-border/60 px-2 py-0.5 text-xs text-foreground" onClick={() => { void save(); }}>{t('settings.snippets.action.save')}</button>
          <button type="button" className="rounded px-1 text-xs text-muted-foreground" onClick={() => { setDraft(record.text); setEditing(false); }}>{t('settings.snippets.action.cancel')}</button>
        </>
      ) : (
        <>
          <span className="w-40 truncate font-mono text-xs text-primary" data-testid="snippets-name">#{record.name}</span>
          <span className="flex-1 truncate text-xs text-muted-foreground" data-testid="snippets-text">{record.text}</span>
          <button type="button" data-testid="snippets-edit" className="rounded border border-border/60 px-2 py-0.5 text-xs text-foreground" onClick={() => setEditing(true)}>{t('settings.snippets.action.edit')}</button>
          <button type="button" data-testid="snippets-delete" aria-label={t('settings.snippets.action.deleteNamed', { name: record.name })} className="rounded px-1 text-xs text-destructive" onClick={() => { void remove(); }}>{t('settings.snippets.action.delete')}</button>
        </>
      )}
    </div>
  );
}
