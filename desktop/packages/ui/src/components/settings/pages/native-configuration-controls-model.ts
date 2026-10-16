// SPDX-License-Identifier: Apache-2.0
import { useSettingsEdit, useSettingsLeave } from '../edit-boundary.tsx';
import { useEffect, useRef, useState } from 'react';
import { getRuntimeKey } from '../../../lib/runtime-switch.ts';
import { getApiBaseUrl } from '../../../lib/runtime-url.ts';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { pendingNativeConfigurationOperation, type PendingNativeConfigurationOperation } from '../../../lib/nnd/configuration-pending.ts';
import { requestNativeConfigurationCatalog, type NativeChangeRequest, type NativeConfigurationCatalog,
  type NativePreview, type NativeReceipt } from '../../../lib/nnd/configuration-mutation.ts';

export const repairStarter = JSON.stringify({ workspace_root: '', provider: { id: 'local', endpoint: 'http://127.0.0.1:8080/v1',
  model: '', trust_zone: 'loopback' } }, null, 2);
export type PendingPreview = { request: NativeChangeRequest; result: NativePreview };
export const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
  ? error.code : 'nnd_configuration_unavailable';

function useNativeConfigurationCatalog() {
  const [catalog, setCatalog] = useState<NativeConfigurationCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const runtime = useRef({ key: getRuntimeKey(), origin: getApiBaseUrl() });
  const isSameRuntime = () => runtime.current.key === getRuntimeKey() && runtime.current.origin === getApiBaseUrl();
  useEffect(() => {
    const controller = new AbortController();
    void requestNativeConfigurationCatalog(controller.signal).then(result => {
      if (!controller.signal.aborted && isSameRuntime()) setCatalog(result);
    }, () => { if (!controller.signal.aborted && isSameRuntime()) setCatalogError(true); });
    return () => controller.abort();
  }, []);
  return { catalog, catalogError, isSameRuntime };
}

export function useNativeConfigurationControlsModel(view: NativeConfigurationView) {
  const leave = useSettingsLeave();
  const recovered = useRef(pendingNativeConfigurationOperation(view));
  const { catalog, catalogError, isSameRuntime } = useNativeConfigurationCatalog();
  const [fieldPath, setFieldPath] = useState('');
  const [mode, setMode] = useState<'set' | 'reset'>('set');
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<PendingPreview | null>(null);
  const [repairDraft, setRepairDraft] = useState(repairStarter);
  const [repairConfirmed, setRepairConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<NativeReceipt | null>(null);
  const [pendingOperation, setPendingOperation] = useState<string | null>(recovered.current?.operation_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentWork = useRef<AbortController | null>(null);
  const pendingOperationRef = useRef<PendingNativeConfigurationOperation | null>(recovered.current);
  const isCurrent = (controller: AbortController) => !controller.signal.aborted && currentWork.current === controller && isSameRuntime();
  useEffect(() => () => { currentWork.current?.abort(); currentWork.current = null; }, []);
  const fields = catalog?.fields.filter(field => view.fields.some(row => row.path === field.path)) ?? [];
  const selected = fields.find(field => field.path === fieldPath) ?? null;
  const selectedRow = view.fields.find(field => field.path === fieldPath);
  const value = selectedRow?.explicit.present && 'value' in selectedRow.explicit ? selectedRow.explicit.value
    : selectedRow?.effective.present && 'value' in selectedRow.effective ? selectedRow.effective.value : '';
  useSettingsEdit('Native configuration', receipt?.persistence !== 'saved' && Boolean(preview ||
    selectedRow && (mode === 'reset' || draft !== JSON.stringify(value)) || repairDraft !== repairStarter),
    Boolean(pendingOperation && (!receipt || receipt.persistence === 'unknown')));
  return { leave, catalog, catalogError, fieldPath, setFieldPath, mode, setMode, draft, setDraft, preview, setPreview,
    repairDraft, setRepairDraft, repairConfirmed, setRepairConfirmed, receipt, setReceipt, pendingOperation,
    setPendingOperation, error, setError, busy, setBusy, currentWork, pendingOperationRef, isCurrent,
    fields, selected, selectedRow };
}
export type ControlsModel = ReturnType<typeof useNativeConfigurationControlsModel>;

export async function runNativeConfigurationWork(model: ControlsModel, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (model.busy || model.currentWork.current) return;
  const controller = new AbortController(); model.currentWork.current = controller;
  model.setBusy(true); model.setError(null);
  try { await work(controller.signal); }
  catch (failure) { if (model.isCurrent(controller)) model.setError(errorCode(failure)); }
  finally { if (model.isCurrent(controller)) model.setBusy(false);
    if (model.currentWork.current === controller) model.currentWork.current = null; }
}

export function invalidateNativePreview(model: ControlsModel): void {
  model.currentWork.current?.abort(); model.currentWork.current = null; model.setBusy(false); model.setPreview(null);
}
