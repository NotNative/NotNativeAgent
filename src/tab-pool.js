// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

const SCHEMA_VERSION = 2;
const MAX_TABS = 8;

export async function loadTabPool(path) {
  if (!path) return null;
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new ContractError('tab_pool_invalid', 'saved Console tabs are not valid JSON');
    throw error;
  }
  if (value?.schema_version === 1) value = migrateV1(value);
  validate(value);
  return value;
}

export async function saveTabPool(path, tabs, activeSessionId = null) {
  if (!path) return;
  const value = {
    schema_version: SCHEMA_VERSION,
    saved_at: new Date().toISOString(),
    active_session_id: activeSessionId,
    tabs: tabs.slice(0, MAX_TABS).map((tab) => ({
      session_id: tab.sessionId,
      name: tab.name,
      role: tab.role,
      meaningful: tab.meaningful === true,
      manifest: tab.manifest,
      presentation: tab.presentation ?? defaultPresentation(),
    })),
  };
  validate(value);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function validate(value) {
  if (!value || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.tabs) || value.tabs.length > MAX_TABS) {
    throw new ContractError('tab_pool_invalid', 'saved Console tab pool has an unsupported shape');
  }
  let primary = 0;
  const ids = new Set();
  for (const tab of value.tabs) {
    if (!tab || !/^[A-Za-z0-9_-]{1,128}$/u.test(tab.session_id ?? '') || ids.has(tab.session_id)
      || !['primary', 'standard'].includes(tab.role) || typeof tab.name !== 'string'
      || tab.name.length === 0 || tab.name.length > 128 || !tab.manifest || typeof tab.manifest !== 'object') {
      throw new ContractError('tab_pool_invalid', 'saved Console tab record is invalid');
    }
    ids.add(tab.session_id);
    if (tab.role === 'primary') primary += 1;
    validatePresentation(tab.presentation);
  }
  if (value.tabs.length > 0 && primary !== 1) {
    throw new ContractError('tab_pool_invalid', 'saved Console tab pool must contain one Main authority record');
  }
  if (value.active_session_id !== null && value.active_session_id !== undefined && !ids.has(value.active_session_id)) {
    throw new ContractError('tab_pool_invalid', 'saved active Console tab does not exist');
  }
}

function validatePresentation(value) {
  if (!value || typeof value.draft !== 'string' || Buffer.byteLength(value.draft) > 131_072
    || (value.viewport_end !== null && (!Number.isSafeInteger(value.viewport_end) || value.viewport_end < 0))
    || !Array.isArray(value.expanded_turn_ids) || value.expanded_turn_ids.length > 128
    || value.expanded_turn_ids.some((id) => typeof id !== 'string' || id.length > 128)
    || !['prompt', 'auto-review', 'unattended'].includes(value.review_posture)
    || !Array.isArray(value.pending_attachments) || value.pending_attachments.length > 16
    || value.pending_attachments.some(invalidAttachment)) {
    throw new ContractError('tab_pool_invalid', 'saved Console presentation state is invalid');
  }
}

function invalidAttachment(item) {
  return !item || typeof item.path !== 'string' || item.path.length > 4096
    || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(item.mime_type)
    || !Number.isSafeInteger(item.size) || item.size < 0;
}

function migrateV1(value) {
  return {
    schema_version: SCHEMA_VERSION, saved_at: value.saved_at,
    active_session_id: value.tabs.find((tab) => tab.role === 'primary')?.session_id ?? null,
    tabs: value.tabs.map((tab) => ({ ...tab, presentation: defaultPresentation() })),
  };
}

function defaultPresentation() {
  return { draft: '', viewport_end: null, expanded_turn_ids: [], review_posture: 'auto-review', pending_attachments: [] };
}
