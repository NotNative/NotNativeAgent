// SPDX-License-Identifier: Apache-2.0
/**
 * MCP settings configuration (P10-46) over the P10-44/45 stores, followed by
 * the read-only NNA inventory. Destinations stay visible only in config drafts;
 * the NNA inventory intentionally exposes no commands or endpoints.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
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
  SettingsSection,
} from '../primitives.tsx';
import { useI18n } from '../../I18nProvider.tsx';
import type { I18nKey } from '../../../lib/i18n/messages/en.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';

interface McpServer {
  id: string;
  transport: 'stdio' | 'streamable_http';
  enabled: boolean;
  trusted: boolean;
}

function validServer(value: unknown): value is McpServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string' && ['stdio', 'streamable_http'].includes(String(item.transport))
    && typeof item.enabled === 'boolean' && typeof item.trusted === 'boolean';
}

export function McpPage(): ReactNode {
  return (
    <SettingsSection item="mcp">
      <WorkspaceMcpConfig />
      <NnaMcpInventory />
    </SettingsSection>
  );
}

function WorkspaceMcpConfig(): ReactNode {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
      const message = error instanceof Error ? error.message : 'MCP action failed';
      if (epoch === actionEpoch.current) setActionError(message);
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
      setNotice(`${candidate.isNew ? 'Created' : 'Updated'} "${candidate.name}". Restart OpenCode to apply.`);
      setRevision((value) => value + 1);
    } else setActionError(outcome.error);
  }, [activeDirectory, closeDraft, startAction]);


  const confirmDelete = useCallback(async (name: string) => {
    if (!McpName.isName(name)) return;
    const { result: outcome, stale } = await startAction(name, () =>
      useMcpConfigStore.getState().deleteEntry(name, activeDirectory));
    if (stale || outcome === null || !outcome.ok) return;
    setDeleteCandidate(null);
    setNotice(`Deleted "${name}". Restart OpenCode to apply.`);
    setRevision((value) => value + 1);
  }, [activeDirectory, startAction]);

  const connectAction = useCallback(async (name: string, work: () => Promise<unknown>) => {
    const { result, stale } = await startAction(name, () => work());
    if (stale || result === null) return;
    const actionError = typeof result === 'string'
      ? result
      : result instanceof Object && 'error' in result ? (result as { error?: string }).error : undefined;
    if (actionError !== undefined) setActionError(actionError);
    setRevision((value) => value + 1);
  }, [startAction]);

  const startOAuth = useCallback(async (name: string) => {
    const { result, stale } = await startAction(name, () =>
      useMcpStore.getState().startAuth(name, activeDirectory));
    if (stale || result === null) return;
    if (result.error) setActionError(result.error);
    else if (result.authorizationUrl !== undefined) {
      setAuthUrlByName((state) => ({ ...state, [name]: result.authorizationUrl }));
      setNotice(`Started authorization for "${name}". Complete the browser flow, then paste the code.`);
    } else {
      setAuthUrlByName((state) => ({ ...state, [name]: undefined }));
      setActionError('authorization URL missing');
    }
  }, [activeDirectory, startAction]);

  const completeOAuth = useCallback(async (name: string) => {
    const code = (authCodeByName[name] ?? '').trim();
    if (code === '') { setActionError('authorization code required'); return; }
    const { result, stale } = await startAction(name, () =>
      useMcpStore.getState().completeAuth(name, code, activeDirectory));
    if (stale || result === null) return;
    if (result !== undefined) setActionError(result);
    else {
      setAuthUrlByName((state) => ({ ...state, [name]: undefined }));
      setAuthCodeByName((state) => ({ ...state, [name]: '' }));
      setNotice(`Completed authorization for "${name}".`);
      setRevision((value) => value + 1);
    }
  }, [activeDirectory, authCodeByName, startAction]);

  const importShare = useCallback(async (file: File) => {
    let text: string;
    try { text = await file.text(); }
    catch { setActionError('MCP share file could not be read'); return; }
    const { result, stale } = await startAction('share', () =>
      useMcpConfigStore.getState().importEntries(text, activeDirectory));
    if (stale || result === null) return;
    if (!('created' in result && 'updated' in result)) {
      setActionError('error' in result ? result.error : 'MCP share import failed');
      return;
    }
    const failures = result.skipped.map(({ name, error }) => `${name}: ${error}`);
    if (failures.length > 0) setActionError(failures.join('; '));
    else setActionError(null);
    const summary = [
      result.created > 0 ? `created ${result.created}` : null,
      result.updated > 0 ? `updated ${result.updated}` : null,
    ].filter(Boolean).join(', ') || 'no changes';
    setNotice(`MCP share import: ${summary}. Restart OpenCode to apply.`);
    setRevision((value) => value + 1);
  }, [activeDirectory, startAction]);

  const records = configs ? Object.values(configs).sort((left, right) => left.name.localeCompare(right.name)) : undefined;
  const candidateName = typeof draft?.name === 'string' ? draft.name : '';
  const canSaveDraft = draft !== null && McpName.isName(candidateName);

  return (
    <section className="mb-4 rounded-lg border border-border/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>Workspace MCP configuration</SettingsGroupTitle>
        <div className="flex items-center gap-2 text-xs">
          <button type="button" className={ACTION_BUTTON_CLASS + ' min-w-11'} disabled={configLoading || statusLoading}
            onClick={() => setRevision((value) => value + 1)}>Refresh</button>
          <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary'} disabled={draft !== null}
            onClick={() => openDraft(newDraft())}>New</button>
          <input type="file" ref={importFileRef} accept=".json,application/json" className="hidden" data-testid="mcp-import-input"
            disabled={configLoading || statusLoading || draft !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (importFileRef.current) importFileRef.current.value = '';
              if (file) void importShare(file);
            }} />
          <button type="button" className={ACTION_BUTTON_CLASS} disabled={configLoading || statusLoading || draft !== null || pendingName !== null}
            onClick={() => importFileRef.current?.click()}>Import JSON</button>
        </div>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">
        OpenCode config changes defer until restart. Connection status is the mock/NNA runtime view, not a guarantee.
      </p>

      {configLoading || statusLoading ? <p role="status" className="text-xs text-muted-foreground">Loading MCP…</p> : null}
      {!configLoading && configError !== undefined ? <p role="alert" className="text-xs text-destructive">{configError}</p> : null}
      {!statusLoading && statusError !== undefined ? <p role="alert" className="text-xs text-destructive">{statusError}</p> : null}
      {actionError !== null ? <p role="alert" className="text-xs text-destructive">{actionError}</p> : null}
      {notice !== null ? <p role="status" className="text-xs text-primary">{notice}</p> : null}

      {!configLoading && !configError && records?.length === 0
        ? <p className="text-xs text-muted-foreground">No workspace MCP records. Choose New to add one.</p> : null}

      {!configLoading && !configError && records?.map((record) => {
        const status = statuses?.[record.name];
        const statusLabel = status?.status ?? 'unverified';
        const needsAuth = status?.status === 'needs_auth' || status?.status === 'needs_client_registration';
        const busy = pendingName === record.name;
        return (
          <div key={record.name} className="mt-2 rounded-md border border-border/45 p-3" data-testid="mcp-config">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-medium text-foreground">{record.name}</div>
              <span className={STATUS_BADGE_CLASS[statusLabel] ?? STATUS_BADGE_CLASS.unknown}>{statusLabel.replace('_', ' ')}</span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {record.scope} scope · {record.type === 'local' ? 'local process' : 'remote'} ·
              {' '}{record.enabled ? 'enabled' : 'disabled'}
            </div>
            {status?.status === 'failed' || status?.status === 'needs_client_registration' ? (
              <div role="alert" className="mt-1 text-xs text-destructive">{{ failed: status.error, needs_client_registration: status.error }[status.status]}</div>
            ) : null}

            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              <button type="button" className={ACTION_BUTTON_CLASS} disabled={draft !== null || busy}
                onClick={() => openDraft(draftFromRecord(record))}>Edit</button>

              {deleteCandidate === record.name ? (
                <button type="button" className={ACTION_BUTTON_CLASS + ' border-destructive/50 text-destructive'} disabled={busy}
                  onClick={() => { void confirmDelete(record.name); }}>Confirm delete</button>
              ) : (
                <button type="button" className={ACTION_BUTTON_CLASS} disabled={draft !== null || busy}
                  onClick={() => setDeleteCandidate(record.name)}>Delete</button>
              )}

              {record.enabled ? (
                <>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                    onClick={() => { void connectAction(record.name, () => useMcpStore.getState().connect(record.name, activeDirectory)); }}>
                    Connect
                  </button>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                  onClick={() => {
                    void connectAction(record.name, () =>
                      useMcpStore.getState().testConnection(record.name, activeDirectory)
                        .then((result) => {
                          if (result.error === undefined && result.warning !== undefined) {
                            const warning = result.warning;
                            void Promise.resolve().then(() => setNotice(warning));
                          }
                          return result;
                        }));
                  }}
                  >
                    Test
                  </button>
                  <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                    onClick={() => { void connectAction(record.name, () => useMcpStore.getState().disconnect(record.name, activeDirectory)); }}>
                    Disconnect
                  </button>
                  {record.type === 'remote' && needsAuth ? (
                    <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary'} disabled={busy}
                      onClick={() => { void startOAuth(record.name); }}>Authorize</button>
                  ) : null}
                  {record.type === 'remote' && needsAuth ? (
                    <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                      <input type="text" className={TEXT_INPUT_CLASS} placeholder="authorization code"
                        value={authCodeByName[record.name] ?? ''} disabled={busy}
                        onChange={(event) => setAuthCodeByName((state) => ({ ...state, [record.name]: event.target.value }))} />
                      <button type="button" className={ACTION_BUTTON_CLASS} disabled={busy}
                        onClick={() => void completeOAuth(record.name)}>Complete auth</button>
                      {authUrlByName[record.name] !== undefined ? (
                        <a className={ACTION_LINK_CLASS} href={authUrlByName[record.name]} target="_blank" rel="noreferrer"
                          onClick={(event) => {
                            let safe = false;
                            try { safe = ['https:', 'http:'].includes(new URL(authUrlByName[record.name]!).protocol); }
                            catch { safe = false; }
                            if (!safe) { event.preventDefault(); setActionError('authorization URL is not HTTP or HTTPS'); }
                          }}>Open browser auth</a>
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
            {draft.isNew ? 'New MCP server' : `Edit ${draft.name}`}
          </div>
          <SettingsChipGroup item="mcp.draft.scope" value={draft.scope}
            options={[{ value: 'user', label: 'User scope' }, { value: 'project', label: 'Project scope' }]}
            onChange={(value) => patchDraft({ scope: value as 'user' | 'project' })} />
          {draft.scope === 'project' && activeDirectory === ''
            ? <p className="mt-1 text-xs text-destructive">A project workspace is required for project scope.</p> : null}
          <SettingsFieldRow label="Server name" item="mcp.draft.name" helper={draft.isNew ? 'lowercase letters, digits, hyphen, underscore' : 'locked'}>
            <input type="text" data-testid="mcp-draft-name" className={TEXT_INPUT_CLASS} value={draft.name} disabled={!draft.isNew}
              onChange={(event) => patchDraft({ name: event.target.value.toLowerCase() })} />
          </SettingsFieldRow>
          <SettingsChipGroup item="mcp.draft.transport" value={draft.type}
            options={[{ value: 'local', label: 'Local' }, { value: 'remote', label: 'Remote' }]}
            onChange={(value) => patchDraft({ type: value as 'local' | 'remote' })} />
          {draft.type === 'local' ? (
            <SettingsFieldRow label="Command" item="mcp.draft.command" helper="quoted words are preserved">
              <input type="text" data-testid="mcp-draft-command" className={TEXT_INPUT_CLASS} value={draft.command}
                onChange={(event) => patchDraft({ command: event.target.value })} />
            </SettingsFieldRow>
          ) : (
            <SettingsFieldRow label="URL" item="mcp.draft.url" helper="HTTP or HTTPS">
              <input type="text" className={TEXT_INPUT_CLASS} value={draft.url}
                onChange={(event) => patchDraft({ url: event.target.value })} />
            </SettingsFieldRow>
          )}

          <SettingsFieldRow label="Environment rows" item="mcp.draft.environment" helper="key, value; one per line">
            <DraftRows value={draft.environment} onChange={(rows) => patchDraft({ environment: rows })} />
          </SettingsFieldRow>
          {draft.type === 'remote' ? (
            <SettingsFieldRow label="Request headers" item="mcp.draft.headers" helper="cleared rows are dropped">
              <DraftRows value={draft.headers} onChange={(rows) => patchDraft({ headers: rows })} />
            </SettingsFieldRow>
          ) : null}

          {draft.type === 'remote' ? (
            <>
              <SettingsCheckboxRow label="OAuth client" item="mcp.draft.oauth" checked={draft.oauthEnabled}
                onChange={(checked) => patchDraft({ oauthEnabled: checked })} />
              {draft.oauthEnabled ? (
                ['clientId', 'clientSecret', 'scope', 'redirectUri'].map((field) => (
                  <SettingsFieldRow key={field} label={field.replace(/[A-Z]/u, (c) => ' ' + c)} item={`mcp.draft.oauth.${field}`}>
                    <input type={field === 'clientSecret' ? 'password' : 'text'} className={TEXT_INPUT_CLASS}
                      value={draft.oauth[field] ?? ''}
                      onChange={(event) => patchDraft({ oauth: { ...draft.oauth, [field]: event.target.value } })} />
                  </SettingsFieldRow>
                ))
              ) : null}
              <SettingsFieldRow label="Timeout" item="mcp.draft.timeout" helper="milliseconds; empty uses default">
                <input type="text" className={TEXT_INPUT_CLASS} value={draft.timeout}
                  onChange={(event) => patchDraft({ timeout: event.target.value })} />
              </SettingsFieldRow>
            </>
          ) : null}
          <SettingsCheckboxRow label="Enabled" item="mcp.draft.enabled" checked={draft.enabled}
            onChange={(checked) => patchDraft({ enabled: checked })} />

          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <button type="button" className={ACTION_BUTTON_CLASS + ' bg-primary/15 text-primary disabled:opacity-50'}
              disabled={configLoading || statusLoading || pendingName !== null || !canSaveDraft
                || (draft.scope === 'project' && activeDirectory === '')}
              onClick={() => void saveDraft(draft)}>Save</button>
            <button type="button" className={ACTION_BUTTON_CLASS} disabled={pendingName !== null}
              onClick={() => { closeDraft(); setActionError(null); }}>Cancel</button>
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

const McpName = {
  isName(name: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/u.test(name);
  },
};

type InventoryError = { kind: 'localized'; key: I18nKey } | { kind: 'raw'; message: string };

function DraftRows({ value, onChange }: {
  value: Array<{ key: string; value: string }>; onChange: (rows: Array<{ key: string; value: string }>) => void;
}): ReactNode {
  return (
    <div className="w-full max-w-64 space-y-1">
      {value.map((row, index) => (
        <div key={`${index}:${row.key}`} className="flex gap-1">
          <input type="text" className={TEXT_INPUT_CLASS} value={row.key} placeholder="key"
            onChange={(event) => onChange(value.map((current, currentIndex) => currentIndex === index
              ? { ...current, key: event.target.value } : current))} />
          <input type="text" className={TEXT_INPUT_CLASS} value={row.value} placeholder="value"
            onChange={(event) => onChange(value.map((current, currentIndex) => currentIndex === index
              ? { ...current, value: event.target.value } : current))} />
          <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => onChange(value.filter((_, filteredIndex) => filteredIndex !== index))}>−</button>
        </div>
      ))}
      <button type="button" className={ACTION_BUTTON_CLASS} onClick={() => onChange([...value, { key: '', value: '' }])}>Add row</button>
    </div>
  );
}

function NnaMcpInventory(): ReactNode {
  const { t } = useI18n();
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<InventoryError | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestEpoch = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const epoch = ++requestEpoch.current;
    let current = true;
    setLoading(true);
    void harnessClient.getNnaMcpInventory().then((result) => {
      if (!current || epoch !== requestEpoch.current) return;
      const inventory = result.data;
      if (result.error || inventory?.version !== 1 || inventory.state !== 'configured'
        || !Array.isArray(inventory.servers) || !inventory.servers.every(validServer)) {
        setServers(null);
        setError(result.error
          ? { kind: 'raw', message: result.error }
          : { kind: 'localized', key: 'settings.mcp.inventory.invalid' });
      } else {
        setServers(inventory.servers);
        setError(null);
      }
    }).catch(() => {
      if (current && epoch === requestEpoch.current) {
        setServers(null);
        setError({ kind: 'localized', key: 'settings.mcp.inventory.unavailable' });
      }
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [revision]);

  useEffect(() => {
    const off = onRuntimeEndpointChanged(() => {
      requestEpoch.current += 1;
      setServers(null);
      setError(null);
      setRevision((value) => value + 1);
    });
    return () => { off(); requestEpoch.current += 1; };
  }, []);

  return (
    <section className="rounded-lg border border-border/35 p-3">
      <div className="flex items-center justify-between gap-3">
        <SettingsGroupTitle>{t('settings.mcp.inventory.title')}</SettingsGroupTitle>
        <button data-testid="mcp-inventory-refresh" type="button" className="rounded border border-border/60 px-2 py-1 text-xs text-foreground disabled:opacity-50" onClick={refresh} disabled={loading}>{t('settings.mcp.inventory.refresh')}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.mcp.inventory.description')}</p>
      {loading ? <p role="status" className="text-xs text-muted-foreground">{t('settings.mcp.inventory.loading')}</p> : null}
      {!loading && error && error.kind === 'raw' ? (
        <p role="alert" className="text-xs text-destructive">{t('settings.mcp.inventory.rawErrorAction')} <code>{error.message}</code></p>
      ) : !loading && error ? (
        <p role="alert" className="text-xs text-destructive">{t(error.kind === 'raw' ? 'settings.mcp.inventory.rawErrorAction' : error.key)}</p>
      ) : null}
      {!loading && servers?.length === 0 ? <p className="text-xs text-muted-foreground">{t('settings.mcp.inventory.empty')}</p> : null}
      {!loading && servers?.map((server) => (
        <div key={server.id} className="rounded-md border border-border/40 p-3 text-xs" data-testid="mcp-server">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <span>{server.id}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${server.enabled ? 'bg-primary/15 text-primary' : 'bg-interactive-hover/40 text-muted-foreground'}`}>
              {server.enabled ? t('settings.mcp.inventory.enabled') : t('settings.mcp.inventory.disabled')}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground">{server.transport === 'stdio' ? t('settings.mcp.inventory.localProcess') : t('settings.mcp.inventory.httpTransport')} · {server.trusted ? t('settings.mcp.inventory.trusted') : t('settings.mcp.inventory.untrusted')} · {t('settings.mcp.inventory.unverified')}</div>
        </div>
      ))}
    </section>
  );
}
