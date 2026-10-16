// SPDX-License-Identifier: Apache-2.0
import { useSettingsEdit } from '../edit-boundary.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuntimeKey, onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { newNativeOperationId } from '../../../lib/nnd/configuration-mutation.ts';
import { clearNativeMcpOperation, pendingNativeMcpOperation, reserveNativeMcpOperation,
  type PendingNativeMcpOperation } from '../../../lib/nnd/native-mcp-pending.ts';
import { inspectNativeMcpOperation, nativeMcpRequest, previewNativeMcp, readNativeMcp, saveNativeMcp,
  NativeMcpFailure, type NativeMcpChange, type NativeMcpRequest, type NativeMcpReceipt,
  type NativeMcpView } from '../../../lib/nnd/native-mcp.ts';
import { authorityState } from '../../../sync/authority-sync.ts';

export interface NativeMcpDraft { op: 'create' | 'patch' | 'delete'; id: string; transport: 'stdio' | 'streamable_http';
  command: string; args: string; endpoint: string; enabled: boolean; deadline: '' | 'timeout_ms' | 'connect_timeout_ms'
    | 'list_timeout_ms' | 'call_timeout_ms' | 'shutdown_timeout_ms'; deadlineValue: string }
export const emptyDraft = (): NativeMcpDraft => ({ op: 'create', id: '', transport: 'stdio', command: '', args: '',
  endpoint: '', enabled: false, deadline: '', deadlineValue: '' });
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const safeError = (error: unknown) => error instanceof NativeMcpFailure ? error.code : 'nnd_mcp_unavailable';
const safePrecommit = new Set(['nnd_mcp_request_invalid', 'nnd_mcp_conflict', 'manifest_revision_conflict',
  'nnd_configuration_resolution_conflict', 'configuration_source_shadowed', 'integration_permission_denied']);
type NativeMcpAuth = 'ok' | 'expired' | 'reauthenticating';
type Task = (signal: AbortSignal, current: () => boolean) => Promise<void>;
function ownsMcpTask(active: { current: AbortController | null }, controller: AbortController, runtime: string, origin: string): boolean {
  return active.current === controller && !controller.signal.aborted && runtime === getRuntimeKey() && origin === getApiBaseUrl();
}
async function runNativeMcpTask(active: { current: AbortController | null }, auth: NativeMcpAuth,
  setBusy: (value: boolean) => void, setError: (value: string | null) => void, work: Task): Promise<void> {
  if (active.current || auth !== 'ok' || authorityState() !== 'ready') return;
  const controller = new AbortController(); active.current = controller;
  const runtime = getRuntimeKey(), origin = getApiBaseUrl();
  const current = () => ownsMcpTask(active, controller, runtime, origin);
  setBusy(true); setError(null);
  try { await work(controller.signal, current); }
  catch (failure) { if (current()) setError(safeError(failure)); }
  finally { if (current()) { setBusy(false); active.current = null; } }
}

export function nativeMcpChange(draft: NativeMcpDraft, view: NativeMcpView): NativeMcpChange {
  if (!ID.test(draft.id) || view.project_shadowed) throw new NativeMcpFailure('nnd_mcp_request_invalid');
  const exists = view.servers.find(server => server.id === draft.id);
  if (draft.op === 'delete') { if (!exists) throw new NativeMcpFailure('nnd_mcp_conflict'); return { op: 'delete', id: draft.id }; }
  if (draft.op === 'patch') {
    if (!exists) throw new NativeMcpFailure('nnd_mcp_conflict');
    const fields: { enabled: boolean; [key: string]: number | boolean } = { enabled: draft.enabled };
    if (draft.deadline) {
      if (!/^(?:0|[1-9]\d{0,15})$/u.test(draft.deadlineValue)
        || !Number.isSafeInteger(Number(draft.deadlineValue))) throw new NativeMcpFailure('nnd_mcp_request_invalid');
      fields[draft.deadline] = Number(draft.deadlineValue);
    }
    return { op: 'patch', id: draft.id, fields };
  }
  if (exists || view.servers.length >= 16) throw new NativeMcpFailure('nnd_mcp_conflict');
  if (draft.transport === 'stdio') {
    const args = draft.args === '' ? [] : draft.args.split('\n');
    if (!draft.command.trim() || draft.command.length > 4096 || /[\u0000-\u001f\u007f]/u.test(draft.command)
      || args.length > 64 || args.some(arg => arg.length > 256)) throw new NativeMcpFailure('nnd_mcp_request_invalid');
    return { op: 'create', id: draft.id, fields: { transport: 'stdio', command: draft.command, args } };
  }
  let url: URL;
  try { url = new URL(draft.endpoint); } catch { throw new NativeMcpFailure('nnd_mcp_request_invalid'); }
  if (draft.endpoint.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new NativeMcpFailure('nnd_mcp_request_invalid');
  }
  return { op: 'create', id: draft.id, fields: { transport: 'streamable_http', endpoint: draft.endpoint } };
}

export function useNativeMcpModel() {
  const auth = useAuthSessionStore(state => state.status);
  const [view, setView] = useState<NativeMcpView | null>(null);
  const [draft, setDraft] = useState<NativeMcpDraft>(emptyDraft);
  const [preview, setPreview] = useState<{ request: NativeMcpRequest; view: NativeMcpView } | null>(null);
  const [receipt, setReceipt] = useState<NativeMcpReceipt | null>(null);
  const [pending, setPending] = useState<PendingNativeMcpOperation | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null), pendingRef = useRef<PendingNativeMcpOperation | null>(null);
  useSettingsEdit('MCP server definition', JSON.stringify(draft) !== JSON.stringify(emptyDraft()) && receipt?.persistence !== 'saved', Boolean(pending && (!receipt || receipt.persistence === 'unknown')));
  const load = useCallback(async () => {
    if (active.current || auth !== 'ok') return;
    const controller = new AbortController(); active.current = controller;
    const runtime = getRuntimeKey(), origin = getApiBaseUrl();
    const current = () => ownsMcpTask(active, controller, runtime, origin);
    setBusy(true); setError(null); setPreview(null); setReceipt(null);
    try { const result = await readNativeMcp(controller.signal);
      if (current()) { setView(result); setDraft(emptyDraft()); pendingRef.current = pendingNativeMcpOperation(result); setPending(pendingRef.current); } }
    catch (failure) { if (current()) { setView(null); setError(safeError(failure)); } }
    finally { if (current()) { setBusy(false); active.current = null; } }
  }, [auth]);
  useEffect(() => {
    const reset = () => { active.current?.abort(); active.current = null; pendingRef.current = null;
      setView(null); setPreview(null); setReceipt(null); setPending(null); setError(null); setBusy(false); setDraft(emptyDraft()); };
    reset(); void load();
    const off = onRuntimeEndpointChanged(() => { reset(); void load(); });
    return () => { off(); active.current?.abort(); active.current = null; };
  }, [load]);
  const run = (work: Task) => runNativeMcpTask(active, auth, setBusy, setError, work);
  const previewDraft = () => { if (!view || pendingRef.current) return;
    void run(async (signal, current) => { const request = nativeMcpRequest(view, nativeMcpChange(draft, view));
      const result = await previewNativeMcp(request, signal); if (current()) setPreview({ request, view: result }); }); };
  const save = () => { if (!preview || pendingRef.current || !view || active.current
    || auth !== 'ok' || authorityState() !== 'ready') return;
    let operationId: string;
    try { operationId = newNativeOperationId(); }
    catch (failure) { setError(safeError(failure)); return; }
    const entry = reserveNativeMcpOperation(view, operationId, preview.request.expected_revision);
    if (!entry) { setError('nnd_mcp_unavailable'); return; }
    pendingRef.current = entry; setPending(entry);
    void run(async (signal, current) => { try {
      const result = await saveNativeMcp(preview.request, operationId, signal);
      if (!current()) return;
      if (result.persistence === 'saved') { clearNativeMcpOperation(entry); pendingRef.current = null; setPending(null); }
      setReceipt(result); setPreview(null); setView(null);
    } catch (failure) {
      if (current() && safePrecommit.has(safeError(failure))) {
        clearNativeMcpOperation(entry); pendingRef.current = null; setPending(null); setPreview(null);
      }
      throw failure;
    } }); };
  const inspect = () => { const entry = pendingRef.current; if (!entry) return;
    void run(async (signal, current) => { const result = await inspectNativeMcpOperation(entry, entry.operation_id, signal);
      if (!current()) return;
      if (result && result.before_revision !== entry.expected_revision) throw new NativeMcpFailure('nnd_mcp_view_invalid');
      if (result?.persistence === 'saved') { clearNativeMcpOperation(entry); pendingRef.current = null; setPending(null); setView(null); }
      if (result) setReceipt(result); else setError('operation_not_found'); }); };
  const changeDraft = (next: NativeMcpDraft) => { setDraft(next); setPreview(null); setReceipt(null); setError(null); };
  return { auth, view, draft, changeDraft, preview, receipt, pending, error, busy, load, previewDraft, save, inspect };
}
