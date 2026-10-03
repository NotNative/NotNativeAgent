// SPDX-License-Identifier: Apache-2.0
/**
 * MCP settings configuration (P10-46) over the P10-44/45 stores, followed by
 * the read-only NNA inventory. Destinations stay visible only in config drafts;
 * the NNA inventory intentionally exposes no commands or endpoints.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { directoryKey, useMcpStore } from '../../../stores/useMcpStore.ts';
import {
  type McpDraft,
  draftFromRecord,
  newDraft,
  useMcpConfigStore,
} from '../../../stores/useMcpConfigStore.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsFieldRow,
  SettingsGroupTitle,
} from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';

type ActionFeedback = { kind: 'localized'; key: I18nKey; params?: Record<string, unknown> }
  | { kind: 'raw'; message: string }
  | { kind: 'importSummary'; created: number; updated: number };
function formatActionFeedback(feedback: ActionFeedback, t: (key: I18nKey, params?: Record<string, unknown>) => string): string {
  if (feedback.kind === 'raw') return feedback.message;
  if (feedback.kind === 'localized') return t(feedback.key, feedback.params);
  const summary = [
    feedback.created > 0 ? t('settings.mcp.import.created', { count: feedback.created }) : null,
    feedback.updated > 0 ? t('settings.mcp.import.updated', { count: feedback.updated }) : null,
  ].filter(Boolean).join(', ') || t('settings.mcp.import.noChanges');
  return t('settings.mcp.notice.importSummary', { summary });
}

export function WorkspaceMcpConfig(): ReactNode {
  const { t } = useI18n();
  const activeDirectory = useSessionViewStore((state) => state.activeDirectory);
  const source = directoryKey(activeDirectory);
  const configs = useMcpConfigStore((state) => state.configsByDirectory[source]);
  const configLoading = !!useMcpConfigStore((state) => state.loadingKeys[source]);
  const configError = useMcpConfigStore((state) => state.lastErrorKeys[source]);
  const draft = useMcpConfigStore((state) => state.draft);
  const statuses = useMcpStore((state) => state.byDirectory[source]);
  const statusLoading = !!useMcpStore((state) => state.loadingKeys[source]);
  const statusError = useMcpStore((state) => state.lastErrorKeys[source]);
  const loadConfigs = useMcpConfigStore.getState().load;
  const openDraft = useMcpConfigStore.getState().openDraft;
  const patchDraft = useMcpConfigStore.getState().patchDraft;
  const closeDraft = useMcpConfigStore.getState().closeDraft;
  const resetConfig = useMcpConfigStore.getState().resetForRuntimeSwitch;
  const resetRuntime = useMcpStore.getState().resetForRuntimeSwitch;
  const ensureFresh = useMcpStore.getState().ensureFresh;
  const [revision, setRevision] = useState(0);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const lastActiveDirectory = useRef(activeDirectory);
  const [notice, setNotice] = useState<ActionFeedback | null>(null);
  const [actionError, setActionError] = useState<ActionFeedback | null>(null);
  const [authCodeByName, setAuthCodeByName] = useState<Record<string, string>>({});
  const [authUrlByName, setAuthUrlByName] = useState<Record<string, string | undefined>>({});
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const actionEpoch = useRef(0);
  const importFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void loadConfigs({ directory: activeDirectory, force: true }); },
    [activeDirectory, loadConfigs, revision, runtimeRevision]);
  useEffect(() => { void ensureFresh({ maxAgeMs: 15_000, directory: activeDirectory }); },
    [activeDirectory, ensureFresh, revision, runtimeRevision]);
  useEffect(() => {
    const off = onRuntimeEndpointChanged(() => {
      actionEpoch.current += 1;
      setRuntimeRevision((value) => value + 1);
      setNotice(null);
      setActionError(null);
      setAuthCodeByName({});
      setAuthUrlByName({});
      setDeleteCandidate(null);
      setPendingName(null);
      resetConfig();
      resetRuntime();
    });
    return () => { off(); actionEpoch.current += 1; };
  }, [resetConfig, resetRuntime]);

  const startAction = useCallback(async <T,>(name: string | null, work: () => Promise<T>) => {
    const epoch = actionEpoch.current;
    setPendingName(name);
    try {
      const result = await work();
      if (epoch === actionEpoch.current) setActionError(null);
      return { result, stale: epoch !== actionEpoch.current };
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      if (epoch === actionEpoch.current) {
        setActionError(message === undefined
          ? { kind: 'localized', key: 'settings.mcp.action.failed' }
          : { kind: 'raw', message });
      }
      return { result: null, stale: true };
    } finally {
      if (epoch === actionEpoch.current) setPendingName(null);
    }
  }, []);

  useEffect(() => {
    if (lastActiveDirectory.current === activeDirectory) return;
    lastActiveDirectory.current = activeDirectory;
    actionEpoch.current += 1;
    closeDraft();
    setNotice(null);
    setActionError(null);
    setAuthCodeByName({});
    setAuthUrlByName({});
    setDeleteCandidate(null);
    setPendingName(null);
  }, [activeDirectory, closeDraft]);

  const saveDraft = useCallback(async (candidate: McpDraft) => {
    const { result: outcome, stale } = await startAction(candidate.name, candidate.isNew
      ? () => useMcpConfigStore.getState().createEntry(candidate.name, candidate, activeDirectory)
      : () => useMcpConfigStore.getState().patchEntry(candidate.name, candidate, activeDirectory));
    if (stale || outcome === null) return;
    if (outcome.ok) {
      closeDraft();
      setNotice({
        kind: 'localized',
        key: candidate.isNew ? 'settings.mcp.notice.created' : 'settings.mcp.notice.updated',
        params: { name: candidate.name },
      });
      setRevision((value) => value + 1);
    } else setActionError({ kind: 'raw', message: outcome.error });
  }, [activeDirectory, closeDraft, startAction]);


  const confirmDelete = useCallback(async (name: string) => {
    if (!McpName.isName(name)) return;
    const { result: outcome, stale } = await startAction(name, () =>
      useMcpConfigStore.getState().deleteEntry(name, activeDirectory));
    if (stale || outcome === null) return;
    if (!outcome.ok) {
      setActionError({ kind: 'raw', message: outcome.error });
      return;
    }
    setDeleteCandidate(null);
    setNotice({ kind: 'localized', key: 'settings.mcp.notice.deleted', params: { name } });
    setRevision((value) => value + 1);
  }, [activeDirectory, startAction]);

  const connectAction = useCallback(async (name: string, work: () => Promise<unknown>) => {
    const { result, stale } = await startAction(name, () => work());
    if (stale || result === null) return;
    const actionError = typeof result === 'string'
      ? result
      : result instanceof Object && 'error' in result ? (result as { error?: string }).error : undefined;
    if (actionError !== undefined) setActionError({ kind: 'raw', message: actionError });
    setRevision((value) => value + 1);
  }, [startAction]);

  const startOAuth = useCallback(async (name: string) => {
    const { result, stale } = await startAction(name, () =>
      useMcpStore.getState().startAuth(name, activeDirectory));
    if (stale || result === null) return;
    if (result.error) setActionError({ kind: 'raw', message: result.error });
    else if (result.authorizationUrl !== undefined) {
      setAuthUrlByName((state) => ({ ...state, [name]: result.authorizationUrl }));
      setNotice({ kind: 'localized', key: 'settings.mcp.notice.authorizationStarted', params: { name } });
    } else {
      setAuthUrlByName((state) => ({ ...state, [name]: undefined }));
      setActionError({ kind: 'localized', key: 'settings.mcp.error.authorizationUrlMissing' });
    }
  }, [activeDirectory, startAction]);

  const completeOAuth = useCallback(async (name: string) => {
    const code = (authCodeByName[name] ?? '').trim();
    if (code === '') { setActionError({ kind: 'localized', key: 'settings.mcp.error.authorizationCodeRequired' }); return; }
    const { result, stale } = await startAction(name, () =>
      useMcpStore.getState().completeAuth(name, code, activeDirectory));
    if (stale || result === null) return;
    if (result !== undefined) setActionError({ kind: 'raw', message: result });
    else {
      setAuthUrlByName((state) => ({ ...state, [name]: undefined }));
      setAuthCodeByName((state) => ({ ...state, [name]: '' }));
      setNotice({ kind: 'localized', key: 'settings.mcp.notice.authorizationCompleted', params: { name } });
      setRevision((value) => value + 1);
    }
  }, [activeDirectory, authCodeByName, startAction]);

  const importShare = useCallback(async (file: File) => {
    let text: string;
    try { text = await file.text(); }
    catch { setActionError({ kind: 'localized', key: 'settings.mcp.error.shareFileUnreadable' }); return; }
    const { result, stale } = await startAction('share', () =>
      useMcpConfigStore.getState().importEntries(text, activeDirectory));
    if (stale || result === null) return;
    if (!('created' in result && 'updated' in result)) {
      setActionError('error' in result
        ? { kind: 'raw', message: result.error }
        : { kind: 'localized', key: 'settings.mcp.error.shareImportFailed' });
      return;
    }
    const failures = result.skipped.map(({ name, error }) => `${name}: ${error}`);
    if (failures.length > 0) setActionError({ kind: 'raw', message: failures.join('; ') });
    else setActionError(null);
    setNotice({ kind: 'importSummary', created: result.created, updated: result.updated });
    setRevision((value) => value + 1);
  }, [activeDirectory, startAction]);

  const records = configs ? Object.values(configs).sort((left, right) => left.name.localeCompare(right.name)) : undefined;
  const candidateName = typeof draft?.name === 'string' ? draft.name : '';
  const canSaveDraft = draft !== null && McpName.isName(candidateName);

  return (
    <section className="mb-4 rounded-lg border border-border/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.mcp.config.title')}</SettingsGroupTitle>
        <div className="flex items-center gap-2 text-xs">
          <button type="button" className={ACTION_BUTTON_CLASS + ' min-w-11'} disabled={configLoading || statusLoading}
            onClick={() => setRevision((value) => value + 1)}>{t('settings.mcp.config.refresh')}</button>
          <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary'} disabled={draft !== null}
            onClick={() => openDraft(newDraft())}>{t('settings.mcp.config.new')}</button>
          <input type="file" ref={importFileRef} accept=".json,application/json" className="hidden" data-testid="mcp-import-input"
            disabled={configLoading || statusLoading || draft !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (importFileRef.current) importFileRef.current.value = '';
              if (file) void importShare(file);
            }} />
          <button type="button" className={ACTION_BUTTON_CLASS} disabled={configLoading || statusLoading || draft !== null || pendingName !== null}
            onClick={() => importFileRef.current?.click()}>{t('settings.mcp.config.importJson')}</button>
        </div>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t('settings.mcp.config.description')}
      </p>

      {configLoading || statusLoading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.mcp.config.loading')}</p> : null}
      {!configLoading && configError !== undefined ? <p role="alert" className="text-xs text-destructive">{configError}</p> : null}
      {!statusLoading && statusError !== undefined ? <p role="alert" className="text-xs text-destructive">{statusError}</p> : null}
      {actionError !== null ? <p role="alert" className="text-xs text-destructive">{formatActionFeedback(actionError, t)}</p> : null}
      {notice !== null ? <p role="status" className="text-xs text-primary">{formatActionFeedback(notice, t)}</p> : null}

      {!configLoading && !configError && records?.length === 0
        ? <p className="text-xs text-muted-foreground">{t('settings.mcp.config.empty')}</p> : null}

      {!configLoading && !configError && records?.map((record) => {
        const status = statuses?.[record.name];
        const statusLabel = status?.status ?? 'unverified';
        const needsAuth = status?.status === 'needs_auth' || status?.status === 'needs_client_registration';
        const busy = pendingName === record.name;
        return (
          <div key={record.name} className="mt-2 rounded-md border border-border/45 p-3" data-testid="mcp-config">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-foreground">{record.name}</div>
              <span className={STATUS_BADGE_CLASS[statusLabel] ?? STATUS_BADGE_CLASS.unknown}>{t(STATUS_LABEL_KEY[statusLabel] ?? 'settings.mcp.status.unverified')}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {record.scope === 'user' ? t('settings.mcp.config.record.userScope') : t('settings.mcp.config.record.projectScope')} · {record.type === 'local' ? t('settings.mcp.config.record.localProcess') : t('settings.mcp.config.record.remote')} ·
              {' '}{record.enabled ? t('settings.mcp.config.record.enabled') : t('settings.mcp.config.record.disabled')}
            </div>
            {status?.status === 'failed' || status?.status === 'needs_client_registration' ? (
              <div role="alert" className="mt-1 text-xs text-destructive">{{ failed: status.error, needs_client_registration: status.error }[status.status]}</div>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <button type="button" className={ACTION_BUTTON_CLASS} disabled={draft !== null || busy}
                onClick={() => openDraft(draftFromRecord(record))}>{t('settings.mcp.config.action.edit')}</button>

              {deleteCandidate === record.name ? (
                <button type="button" className={ACTION_BUTTON_CLASS + ' border-destructive/50 text-destructive'} disabled={busy}
                  onClick={() => { void confirmDelete(record.name); }}>{t('settings.mcp.config.action.confirmDelete')}</button>
              ) : (
                <button type="button" className={ACTION_BUTTON_CLASS} disabled={draft !== null || busy}
                  onClick={() => setDeleteCandidate(record.name)}>{t('settings.mcp.config.action.delete')}</button>
              )}

              {record.enabled ? (
                <>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                    onClick={() => { void connectAction(record.name, () => useMcpStore.getState().connect(record.name, activeDirectory)); }}>
                    {t('settings.mcp.config.action.connect')}
                  </button>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                  onClick={() => {
                    void connectAction(record.name, () =>
                      useMcpStore.getState().testConnection(record.name, activeDirectory)
                        .then((result) => {
                          if (result.error === undefined && result.warning !== undefined) {
                            const warning = result.warning;
                            void Promise.resolve().then(() => setNotice({ kind: 'raw', message: warning }));
                          }
                          return result;
                        }));
                  }}
                  >
                    {t('settings.mcp.config.action.test')}
                  </button>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                    onClick={() => { void connectAction(record.name, () => useMcpStore.getState().disconnect(record.name, activeDirectory)); }}>
                    {t('settings.mcp.config.action.disconnect')}
                  </button>
                  {record.type === 'remote' && needsAuth ? (
                    <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary'} disabled={busy}
                      onClick={() => { void startOAuth(record.name); }}>{t('settings.mcp.config.action.authorize')}</button>
                  ) : null}
                  {record.type === 'remote' && needsAuth ? (
                    <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                      <input type="text" className={TEXT_INPUT_CLASS} placeholder="authorization code"
                        value={authCodeByName[record.name] ?? ''} disabled={busy}
                        onChange={(event) => setAuthCodeByName((state) => ({ ...state, [record.name]: event.target.value }))} />
                      <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                        onClick={() => void completeOAuth(record.name)}>{t('settings.mcp.config.action.completeAuth')}</button>
                      {authUrlByName[record.name] !== undefined ? (
                        <a className={ACTION_LINK_CLASS} href={authUrlByName[record.name]} target="_blank" rel="noreferrer"
                          onClick={(event) => {
                            let safe = false;
                            try { safe = ['https:', 'http:'].includes(new URL(authUrlByName[record.name]!).protocol); }
                            catch { safe = false; }
                            if (!safe) { event.preventDefault(); setActionError({ kind: 'localized', key: 'settings.mcp.error.authorizationUrlProtocol' }); }
                          }}>{t('settings.mcp.config.action.openBrowserAuth')}</a>
                      ) : null}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        );
      })}

      {draft !== null ? (
        <div className="mt-3 rounded-md border border-primary/40 bg-background/70 p-3" data-testid="mcp-draft">
          <div className="mb-2 text-xs font-medium text-foreground">
            {draft.isNew ? t('settings.mcp.draft.title.new') : t('settings.mcp.draft.title.edit', { name: draft.name })}
          </div>
          <SettingsChipGroup item="mcp.draft.scope" value={draft.scope} disabled={!draft.isNew}
            options={[{ value: 'user', label: t('settings.mcp.config.record.userScope') }, { value: 'project', label: t('settings.mcp.config.record.projectScope') }]}
            onChange={(value) => patchDraft({ scope: value as 'user' | 'project' })} />
          {draft.scope === 'project' && activeDirectory === ''
            ? <p className="mt-1 text-xs text-destructive">{t('settings.mcp.config.projectRequired')}</p> : null}
          <SettingsFieldRow label={t('settings.mcp.draft.name')} item="mcp.draft.name" helper={draft.isNew ? t('settings.mcp.draft.name.helper.new') : t('settings.mcp.draft.name.helper.locked')}>
            <input type="text" data-testid="mcp-draft-name" className={TEXT_INPUT_CLASS} value={draft.name} disabled={!draft.isNew}
              onChange={(event) => patchDraft({ name: event.target.value.toLowerCase() })} />
          </SettingsFieldRow>
          <SettingsChipGroup item="mcp.draft.transport" value={draft.type}
            options={[{ value: 'local', label: t('settings.mcp.draft.transport.local') }, { value: 'remote', label: t('settings.mcp.draft.transport.remote') }]}
            onChange={(value) => patchDraft({ type: value as 'local' | 'remote' })} />
          {draft.type === 'local' ? (
            <SettingsFieldRow label={t('settings.mcp.draft.command')} item="mcp.draft.command" helper={t('settings.mcp.draft.command.helper')}>
              <input type="text" data-testid="mcp-draft-command" className={TEXT_INPUT_CLASS} value={draft.command}
                onChange={(event) => patchDraft({ command: event.target.value })} />
            </SettingsFieldRow>
          ) : (
            <SettingsFieldRow label={t('settings.mcp.draft.url')} item="mcp.draft.url" helper={t('settings.mcp.draft.url.helper')}>
              <input type="text" className={TEXT_INPUT_CLASS} value={draft.url}
                onChange={(event) => patchDraft({ url: event.target.value })} />
            </SettingsFieldRow>
          )}

          <SettingsFieldRow label={t('settings.mcp.draft.environmentRows')} item="mcp.draft.environment" helper={t('settings.mcp.draft.environmentRows.helper')}>
            <DraftRows value={draft.environment} onChange={(rows) => patchDraft({ environment: rows })} />
          </SettingsFieldRow>
          {draft.type === 'remote' ? (
            <SettingsFieldRow label={t('settings.mcp.draft.requestHeaders')} item="mcp.draft.headers" helper={t('settings.mcp.draft.requestHeaders.helper')}>
              <DraftRows value={draft.headers} onChange={(rows) => patchDraft({ headers: rows })} />
            </SettingsFieldRow>
          ) : null}

          {draft.type === 'remote' ? (
            <>
              <SettingsCheckboxRow label={t('settings.mcp.draft.oauthClient')} item="mcp.draft.oauth" checked={draft.oauthEnabled}
                onChange={(checked) => patchDraft({ oauthEnabled: checked })} />
              {draft.oauthEnabled ? (
                ['clientId', 'clientSecret', 'scope', 'redirectUri'].map((field) => (
                  <SettingsFieldRow key={field} label={t(OAUTH_FIELD_LABEL_KEY[field]!)} item={`mcp.draft.oauth.${field}`}>
                    <input type={field === 'clientSecret' ? 'password' : 'text'} className={TEXT_INPUT_CLASS}
                      value={draft.oauth[field] ?? ''}
                      onChange={(event) => patchDraft({ oauth: { ...draft.oauth, [field]: event.target.value } })} />
                  </SettingsFieldRow>
                ))
              ) : null}
              <SettingsFieldRow label={t('settings.mcp.draft.timeout')} item="mcp.draft.timeout" helper={t('settings.mcp.draft.timeout.helper')}>
                <input type="text" className={TEXT_INPUT_CLASS} value={draft.timeout}
                  onChange={(event) => patchDraft({ timeout: event.target.value })} />
              </SettingsFieldRow>
            </>
          ) : null}
          <SettingsCheckboxRow label={t('settings.mcp.draft.enabled')} item="mcp.draft.enabled" checked={draft.enabled}
            onChange={(checked) => patchDraft({ enabled: checked })} />

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary disabled:opacity-50'}
              disabled={configLoading || statusLoading || pendingName !== null || !canSaveDraft
                || (draft.scope === 'project' && activeDirectory === '')}
              onClick={() => void saveDraft(draft)}>{t('settings.mcp.draft.action.save')}</button>
            <button type="button" className={ACTION_BUTTON_CLASS} disabled={pendingName !== null}
              onClick={() => { closeDraft(); setActionError(null); }}>{t('settings.mcp.draft.action.cancel')}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const ACTION_BUTTON_CLASS = 'rounded border border-border/60 px-2 py-1 text-xs text-foreground transition-colors hover:bg-interactive-hover disabled:opacity-50';
const ACTION_LINK_CLASS = 'rounded border border-border/60 px-2 py-1 font-medium text-primary no-underline transition-colors hover:bg-interactive-hover';
const TEXT_INPUT_CLASS = 'max-w-56 flex-1 rounded border border-border/60 bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary';
const STATUS_BADGE_CLASS: Record<string, string> = {
  connected: 'rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary',
  disabled: 'rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground',
  failed: 'rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] text-destructive',
  needs_auth: 'rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary',
  needs_client_registration: 'rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary',
  unknown: 'rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground',
  unverified: 'rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground',
};

const STATUS_LABEL_KEY: Record<string, I18nKey> = {
  connected: 'settings.mcp.status.connected',
  disabled: 'settings.mcp.status.disabled',
  failed: 'settings.mcp.status.failed',
  needs_auth: 'settings.mcp.status.needsAuth',
  needs_client_registration: 'settings.mcp.status.needsClientRegistration',
  unknown: 'settings.mcp.status.unknown',
  unverified: 'settings.mcp.status.unverified',
};

const OAUTH_FIELD_LABEL_KEY: Record<string, I18nKey> = {
  clientId: 'settings.mcp.draft.oauth.clientId',
  clientSecret: 'settings.mcp.draft.oauth.clientSecret',
  scope: 'settings.mcp.draft.oauth.scope',
  redirectUri: 'settings.mcp.draft.oauth.redirectUri',
};

const McpName = {
  isName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/u.test(name);
  },
};

function DraftRows({ value, onChange }: {
  value: Array<{ key: string; value: string }>; onChange: (rows: Array<{ key: string; value: string }>) => void;
}): ReactNode {
  const { t } = useI18n();
  return (
    <div className="w-full max-w-64 space-y-1">
      {value.map((row, index) => (
        <div key={`${index}:${row.key}`} className="flex gap-1">
          <input type="text" className={TEXT_INPUT_CLASS} value={row.key} placeholder={t('settings.mcp.draft.rows.key')}
            onChange={(event) => onChange(value.map((current, currentIndex) => currentIndex === index
              ? { ...current, key: event.target.value } : current))} />
          <input type="text" className={TEXT_INPUT_CLASS} value={row.value} placeholder={t('settings.mcp.draft.rows.value')}
            onChange={(event) => onChange(value.map((current, currentIndex) => currentIndex === index
              ? { ...current, value: event.target.value } : current))} />
          <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => onChange(value.filter((_, filteredIndex) => filteredIndex !== index))}>−</button>
        </div>
      ))}
      <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => onChange([...value, { key: '', value: '' }])}>{t('settings.mcp.draft.rows.add')}</button>
    </div>
  );
}
