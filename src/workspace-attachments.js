// SPDX-License-Identifier: Apache-2.0
import { mkdir, rm, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';

const TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });

export async function queueConsoleAttachment(workspace, input) {
  const session = workspace.projection.active();
  const config = workspace.activeConfig();
  if (!config.attachments.enabled) throw new ContractError('attachments_disabled', 'enable attachments in /config first');
  if (session.pendingAttachments.length >= 16) throw new ContractError('attachment_limit', 'a turn accepts at most sixteen attachments');
  const supplied = unquote(input.trim());
  if (!supplied) throw new ContractError('attachment_path_missing', 'use /attach PATH');
  const path = isAbsolute(supplied) ? resolve(supplied) : resolve(config.workspaceRoot, supplied);
  const mimeType = TYPES[extname(path).toLowerCase()];
  if (!mimeType) throw new ContractError('attachment_type_unsupported', 'supported image types are PNG, JPEG, GIF, and WebP');
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > config.attachments.maxBytes) {
    throw new ContractError('attachment_size_invalid', 'attachment is not a bounded regular file');
  }
  const descriptor = Object.freeze({ path, mime_type: mimeType, size: metadata.size });
  session.pendingAttachments.push(descriptor);
  workspace.onChange();
  return descriptor;
}

export async function queueClipboardImage(workspace) {
  const config = workspace.activeConfig();
  const session = workspace.projection.active();
  requireAttachmentCapacity(config, session);
  const reader = workspace.options.clipboardImageRead;
  if (typeof reader !== 'function') throw new ContractError('clipboard_image_unavailable', 'clipboard image paste is unavailable');
  const managedRoot = workspace.activeEngine?.().attachments?.root;
  if (!managedRoot) throw new ContractError('clipboard_image_unavailable', 'the active session has no managed attachment store');
  const root = join(managedRoot, 'clipboard-ingress');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `clipboard-${Date.now()}-${randomUUID()}.png`);
  try {
    await reader(path, config.attachments.maxBytes);
    return await queueConsoleAttachment(workspace, path);
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function queueClipboardContent(workspace) {
  const reader = workspace.options.clipboardContentRead;
  if (typeof reader !== 'function') throw new ContractError('clipboard_unavailable', 'clipboard paste is unavailable');
  const config = workspace.activeConfig();
  const managedRoot = workspace.activeEngine?.().attachments?.root;
  const root = managedRoot ? join(managedRoot, 'clipboard-ingress') : null;
  if (root) await mkdir(root, { recursive: true, mode: 0o700 });
  const path = root ? join(root, `clipboard-${Date.now()}-${randomUUID()}.png`) : null;
  try {
    const content = await reader(config.attachments.enabled ? path : null, config.attachments.maxBytes);
    if (content.kind !== 'image') return { action: 'paste', text: content.text };
    requireAttachmentCapacity(config, workspace.projection.active());
    return { action: 'attachment', attachment: await queueConsoleAttachment(workspace, path) };
  } finally {
    if (path && !workspace.projection.active().pendingAttachments.some((item) => item.path === path)) {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

export async function queuePastedImagePaths(workspace, text) {
  const paths = pastedPaths(text);
  if (paths.length === 0) return [];
  const start = workspace.projection.active().pendingAttachments.length;
  const queued = [];
  for (const path of paths) {
    try { queued.push(await queueConsoleAttachment(workspace, path)); }
    catch (error) {
      workspace.projection.active().pendingAttachments.splice(start);
      if (error.code === 'ENOENT' || error.code === 'attachment_type_unsupported') return [];
      throw error;
    }
  }
  return queued;
}

export function detachConsoleAttachment(workspace, selector) {
  const session = workspace.projection.active();
  if (selector === 'all') return session.pendingAttachments.splice(0).length;
  const index = Number(selector) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= session.pendingAttachments.length) {
    throw new ContractError('attachment_selection_invalid', 'use /detach INDEX or /detach all');
  }
  session.pendingAttachments.splice(index, 1);
  workspace.onChange();
  return 1;
}

function unquote(value) {
  return (/^".*"$/u.test(value) || /^'.*'$/u.test(value)) ? value.slice(1, -1) : value;
}

function requireAttachmentCapacity(config, session) {
  if (!config.attachments.enabled) throw new ContractError('attachments_disabled', 'enable attachments in /config first');
  if (session.pendingAttachments.length >= 16) throw new ContractError('attachment_limit', 'a turn accepts at most sixteen attachments');
}

function pastedPaths(value) {
  const text = String(value).trim();
  if (!text || text.includes('\0')) return [];
  const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/gu)];
  const remainder = quoted.reduce((current, item) => current.replace(item[0], ''), text).trim();
  if (quoted.length > 0 && remainder) return [];
  const matches = quoted.length > 0
    ? quoted.map((item) => (item[1] ?? item[2]).trim())
    : text.split(/\r?\n|\t/gu).map((item) => item.trim()).filter(Boolean);
  if (matches.length === 0 || matches.length > 16) return [];
  return matches.every((item) => TYPES[extname(item).toLowerCase()]) ? matches : [];
}
