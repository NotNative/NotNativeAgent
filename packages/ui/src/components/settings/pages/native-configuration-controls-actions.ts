// SPDX-License-Identifier: Apache-2.0
import { getRuntimeKey } from '../../../lib/runtime-switch.ts';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { clearNativeConfigurationOperation, reserveNativeConfigurationOperation,
  type PendingNativeConfigurationOperation } from '../../../lib/nnd/configuration-pending.ts';
import { lookupNativeConfigurationOperation, nativeChange, nativeRepairDocument, newNativeOperationId,
  previewNativeConfiguration, repairNativeConfiguration, saveNativeConfiguration, NativeConfigurationFailure } from '../../../lib/nnd/configuration-mutation.ts';
import { errorCode, invalidateNativePreview, runNativeConfigurationWork, type ControlsModel } from './native-configuration-controls-model.ts';

export function chooseNativeField(model: ControlsModel, view: NativeConfigurationView, path: string): void {
  if (model.pendingOperationRef.current) return;
  invalidateNativePreview(model); model.setFieldPath(path); model.setReceipt(null); model.setPendingOperation(null);
  model.setError(null); model.setMode('set');
  const row = view.fields.find(item => item.path === path);
  const value = row?.explicit.present && 'value' in row.explicit ? row.explicit.value
    : row?.effective.present && 'value' in row.effective ? row.effective.value : '';
  model.setDraft(JSON.stringify(value));
}

export function previewNativeField(model: ControlsModel, view: NativeConfigurationView): void {
  if (!model.selected) return;
  void runNativeConfigurationWork(model, async signal => {
    const request = nativeChange(view, model.selected!, model.mode, model.draft);
    const result = await previewNativeConfiguration(request, signal);
    if (model.currentWork.current?.signal === signal && model.isCurrent(model.currentWork.current)) model.setPreview({ request, result });
  });
}

function reserveOperation(model: ControlsModel, view: NativeConfigurationView, revision: string): PendingNativeConfigurationOperation | null {
  let operationId: string;
  try { operationId = newNativeOperationId(); } catch (failure) { model.setError(errorCode(failure)); return null; }
  if (!reserveNativeConfigurationOperation(view, operationId, revision)) {
    model.setError('nnd_configuration_unavailable'); return null;
  }
  const entry = { runtime_key: getRuntimeKey(), installation_id: view.installation_id,
    data_id: view.data_id, operation_id: operationId, expected_revision: revision };
  model.pendingOperationRef.current = entry; model.setPendingOperation(operationId);
  return entry;
}

export function publishNativeField(model: ControlsModel, view: NativeConfigurationView): void {
  if (!model.preview || model.pendingOperationRef.current || model.currentWork.current || model.busy) return;
  const preview = model.preview, entry = reserveOperation(model, view, preview.request.expected_revision);
  if (!entry) return;
  void runNativeConfigurationWork(model, async signal => {
    const result = await saveNativeConfiguration(preview.request, entry.operation_id, signal);
    if (model.currentWork.current?.signal === signal && model.isCurrent(model.currentWork.current)) {
      if (result.persistence === 'saved') clearNativeConfigurationOperation(entry);
      model.setReceipt(result); model.setPreview(null);
    }
  });
}

export function repairNativeSource(model: ControlsModel, view: NativeConfigurationView): void {
  if (!model.repairConfirmed || model.pendingOperationRef.current || model.currentWork.current || model.busy) return;
  let document: Record<string, unknown>;
  try { document = nativeRepairDocument(JSON.parse(model.repairDraft)); }
  catch (failure) { model.setError(errorCode(failure)); return; }
  const entry = reserveOperation(model, view, view.source_revision ?? '');
  if (!entry) return;
  void runNativeConfigurationWork(model, async signal => {
    const result = await repairNativeConfiguration(view, document, entry.operation_id, signal);
    if (model.currentWork.current?.signal === signal && model.isCurrent(model.currentWork.current)) {
      if (result.persistence === 'saved') clearNativeConfigurationOperation(entry);
      model.setReceipt(result);
    }
  });
}

export function inspectNativeOperation(model: ControlsModel, view: NativeConfigurationView): void {
  const entry = model.pendingOperationRef.current;
  if (!entry) return;
  void runNativeConfigurationWork(model, async signal => {
    const result = await lookupNativeConfigurationOperation(view, entry.operation_id, signal);
    if (model.currentWork.current?.signal === signal && model.isCurrent(model.currentWork.current)) {
      if (result && result.before_revision !== entry.expected_revision) throw new NativeConfigurationFailure('nnd_configuration_view_invalid');
      if (result?.persistence === 'saved') clearNativeConfigurationOperation(entry);
      if (result) model.setReceipt(result); else model.setError('operation_not_found');
    }
  });
}
