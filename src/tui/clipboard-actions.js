// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { clearSelection, selectedText } from './selection.js';
import { recordClipboard } from './telemetry.js';
import { queueClipboardContent, queueClipboardImage, queuePastedImagePaths } from '../experience/attachments.js';

export async function clipboardPasteAction(workspace) {
  const read = workspace.options.clipboardRead;
  if (typeof read !== 'function') throw new ContractError('clipboard_unavailable', 'clipboard paste is unavailable');
  if (!workspace.projection?.overlay && typeof workspace.options.clipboardContentRead === 'function') {
    return normalizeClipboardAction(await queueClipboardContent(workspace));
  }
  if (!workspace.projection?.overlay && typeof workspace.options.clipboardImageRead === 'function') {
    try {
      const attachment = await queueClipboardImage(workspace);
      return { action: 'attachment', attachment };
    } catch (error) {
      if (!imageFallbackError(error)) throw error;
    }
  }
  let text = '';
  try { text = await read(); } catch { /* an image clipboard commonly has no text representation */ }
  if (!text) {
    if (typeof workspace.options.clipboardImageRead !== 'function') {
      throw new ContractError('clipboard_empty', 'The clipboard does not contain text or a supported image.');
    }
    const attachment = await queueClipboardImage(workspace);
    return { action: 'attachment', attachment };
  }
  return { action: 'paste', text: normalizeClipboardText(text) };
}

function imageFallbackError(error) {
  return ['clipboard_image_unavailable', 'attachments_disabled'].includes(error?.code);
}

export async function pasteClipboard(workspace, handleOverlayAction, handleEditorAction, source = 'keyboard') {
  const started = performance.now();
  recordClipboard(workspace, 'started', { type: 'paste', source });
  try {
    const action = await clipboardPasteAction(workspace);
    const target = workspace.projection.overlay?.kind ?? 'conversation';
    let dropped = [];
    if (action.action === 'paste' && !workspace.projection.overlay) dropped = await queuePastedImagePaths(workspace, action.text);
    if (action.action === 'attachment') {
      workspace.projection.showNotice('attachment', `Queued ${action.attachment.path} for the next message.`);
    } else if (dropped.length > 0) {
      workspace.projection.showNotice('attachment', `Queued ${dropped.length} dropped image${dropped.length === 1 ? '' : 's'} for the next message.`);
    } else if (workspace.projection.overlay) await handleOverlayAction(action, workspace);
    else handleEditorAction(action, workspace.projection.active().editor);
    recordClipboard(workspace, 'succeeded', {
      type: action.action === 'attachment' || dropped.length > 0 ? 'image' : 'paste', source, target,
      bytes: action.action === 'attachment' ? action.attachment.size : Buffer.byteLength(action.text),
      characters: action.action === 'attachment' || dropped.length > 0 ? 0 : action.text.length,
      lines: action.action === 'attachment' || dropped.length > 0 ? 0 : action.text.split('\n').length,
    }, performance.now() - started);
  } catch (error) {
    recordClipboard(workspace, 'failed', { type: 'paste', source, code: error.code ?? 'clipboard_failed' }, performance.now() - started);
    throw error;
  }
}

export async function copyTerminalSelection(workspace) {
  const text = selectedText(workspace.projection);
  if (!text) return false;
  const result = await workspace.options.clipboard(text);
  clearSelection(workspace.projection);
  workspace.projection.showNotice('clipboard', `Copied selection (${result?.bytes ?? Buffer.byteLength(text, 'utf8')} bytes).`);
  return true;
}

export async function rightClickClipboard(workspace, paste) {
  if (await copyTerminalSelection(workspace)) return;
  await paste();
}

export async function attachDroppedPaths(workspace, text) {
  const items = await queuePastedImagePaths(workspace, text);
  if (items.length === 0) return false;
  workspace.projection.showNotice('attachment', `Queued ${items.length} dropped image${items.length === 1 ? '' : 's'} for the next message.`);
  return true;
}

export function clearTerminalSelection(workspace) {
  clearSelection(workspace.projection);
}

function normalizeClipboardText(value) {
  return String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function normalizeClipboardAction(action) {
  return action.action === 'paste' ? { ...action, text: normalizeClipboardText(action.text) } : action;
}
