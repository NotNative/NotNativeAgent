// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { clearSelection, selectedText } from './selection.js';
import { recordClipboard } from './telemetry.js';
import { queueClipboardContent, queueClipboardImage, queuePastedImagePaths } from '../experience/attachments.js';

const ACTION = Object.freeze({ attachment: 'attachment', paste: 'paste' });
const OUTCOME = Object.freeze({ started: 'started', succeeded: 'succeeded', failed: 'failed' });

export async function clipboardPasteAction(workspace) {
  const read = workspace.options.clipboardRead;
  if (typeof read !== 'function') throw new ContractError('clipboard_unavailable', 'clipboard paste is unavailable');
  if (!workspace.projection?.overlay && typeof workspace.options.clipboardContentRead === 'function') {
    return normalizeClipboardAction(await queueClipboardContent(workspace));
  }
  if (!workspace.projection?.overlay && typeof workspace.options.clipboardImageRead === 'function') {
    try {
      const attachment = await queueClipboardImage(workspace);
      return normalizeClipboardAction({ action: ACTION.attachment, attachment });
    } catch (error) {
      if (!imageFallbackError(error)) throw error;
    }
  }
  let text = '';
  let textReadError = null;
  try { text = await read(); }
  catch (error) { textReadError = error; }
  if (!text) {
    if (typeof workspace.options.clipboardImageRead !== 'function') {
      if (textReadError) throw textReadError;
      throw new ContractError('clipboard_empty', 'The clipboard does not contain text or a supported image.');
    }
    const attachment = await queueClipboardImage(workspace);
    return normalizeClipboardAction({ action: ACTION.attachment, attachment });
  }
  return normalizeClipboardAction({ action: ACTION.paste, text });
}

function imageFallbackError(error) {
  return ['clipboard_image_unavailable', 'attachments_disabled'].includes(error?.code);
}

export async function pasteClipboard(workspace, handleOverlayAction, handleEditorAction, source = 'keyboard') {
  const started = performance.now();
  recordClipboard(workspace, OUTCOME.started, { type: ACTION.paste, source });
  try {
    const action = await clipboardPasteAction(workspace);
    const projection = workspace?.projection;
    if (!projection) throw new ContractError('clipboard_target_unavailable', 'clipboard paste has no active projection');
    const target = projection.overlay?.kind ?? 'conversation';
    let dropped = [];
    if (action.action === ACTION.paste && !projection.overlay) {
      dropped = await queuePastedImagePaths(workspace, action.text);
    }
    if (action.action === ACTION.attachment) {
      projection.showNotice(ACTION.attachment, `Queued ${action.attachment.path} for the next message.`);
    } else if (dropped.length > 0) {
      projection.showNotice(ACTION.attachment, `Queued ${dropped.length} dropped image${dropped.length === 1 ? '' : 's'} for the next message.`);
    } else if (projection.overlay) {
      await handleOverlayAction(action, workspace);
    } else {
      const editor = projection.active?.()?.editor;
      if (!editor) throw new ContractError('clipboard_target_unavailable', 'clipboard paste has no active editor');
      await handleEditorAction(action, editor);
    }
    recordClipboard(workspace, OUTCOME.succeeded, {
      type: action.action === ACTION.attachment || dropped.length > 0 ? 'image' : ACTION.paste, source, target,
      bytes: action.action === ACTION.attachment ? action.attachment.size : Buffer.byteLength(action.text),
      characters: action.action === ACTION.attachment || dropped.length > 0 ? 0 : action.text.length,
      lines: action.action === ACTION.attachment || dropped.length > 0 ? 0 : action.text.split('\n').length,
    }, performance.now() - started);
  } catch (error) {
    recordClipboard(workspace, OUTCOME.failed, {
      type: ACTION.paste, source, code: error.code ?? 'clipboard_failed',
    }, performance.now() - started);
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
  if (!action || typeof action !== 'object') {
    throw new ContractError('clipboard_content_invalid', 'clipboard reader returned an invalid result');
  }
  if (action.action === ACTION.paste) {
    if (typeof action.text !== 'string') {
      throw new ContractError('clipboard_content_invalid', 'clipboard text is invalid');
    }
    return { ...action, text: normalizeClipboardText(action.text) };
  }
  if (action.action === ACTION.attachment) {
    if (typeof action.attachment?.path !== 'string'
      || !Number.isSafeInteger(action.attachment.size) || action.attachment.size < 0) {
      throw new ContractError('clipboard_content_invalid', 'clipboard attachment is invalid');
    }
    return action;
  }
  throw new ContractError('clipboard_content_invalid', 'clipboard action is unsupported');
}
