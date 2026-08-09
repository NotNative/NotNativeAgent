// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';
import { SessionLock } from './session-lock.js';

const SCHEMA_VERSION = 3;
const MAX_TABS = 64;

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
  if (value?.schema_version === 2) value = migrateV2(value);
  validate(value);
  return value;
}

export async function saveTabPool(path, tabs, activeSessionId = null, options = {}) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = new SessionLock(dirname(path), 'console-pool-write');
  await acquirePoolLock(lock);
  try {
    const incoming = tabs.map((tab) => poolRecord(tab, options.consoleId ?? null));
    const incomingIds = new Set(incoming.map((tab) => tab.session_id));
    const existing = options.consoleId ? await loadTabPool(path) : null;
    const retained = (existing?.tabs ?? []).filter((tab) => tab.meaningful
      && tab.console_id !== options.consoleId && !incomingIds.has(tab.session_id));
    const value = {
      schema_version: SCHEMA_VERSION, saved_at: new Date().toISOString(),
      active_session_id: activeSessionId, tabs: [...incoming, ...retained].slice(0, MAX_TABS),
    };
    validate(value);
    const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await lock.release(); }
}

async function acquirePoolLock(lock) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await lock.acquire(); return; }
    catch (error) {
      if (error?.code !== 'session_locked') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new ContractError('tab_pool_busy', 'another Console kept the shared tab pool busy');
}

function poolRecord(tab, consoleId) {
  return {
    session_id: tab.sessionId, name: tab.name, role: tab.role,
    main: tab.main === true,
    meaningful: tab.meaningful === true, manifest: tab.manifest,
    presentation: tab.presentation ?? defaultPresentation(), console_id: consoleId,
  };
}

function validate(value) {
  if (!value || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.tabs) || value.tabs.length > MAX_TABS) {
    throw new ContractError('tab_pool_invalid', 'saved Console tab pool has an unsupported shape');
  }
  const ids = new Set();
  for (const tab of value.tabs) {
    if (!tab || !/^[A-Za-z0-9_-]{1,128}$/u.test(tab.session_id ?? '') || ids.has(tab.session_id)
      || !['primary', 'standard'].includes(tab.role) || typeof tab.name !== 'string'
      || tab.name.length === 0 || tab.name.length > 128 || typeof tab.main !== 'boolean'
      || !tab.manifest || typeof tab.manifest !== 'object'
      || (tab.console_id !== null && tab.console_id !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(tab.console_id))) {
      throw new ContractError('tab_pool_invalid', 'saved Console tab record is invalid');
    }
    ids.add(tab.session_id);
    validatePresentation(tab.presentation);
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
  return migrateV2({
    schema_version: 2, saved_at: value.saved_at,
    active_session_id: value.tabs.find((tab) => tab.role === 'primary')?.session_id ?? null,
    tabs: value.tabs.map((tab) => ({ ...tab, presentation: defaultPresentation() })),
  });
}

function migrateV2(value) {
  return { ...value, schema_version: SCHEMA_VERSION, tabs: value.tabs.map((tab) => ({
    ...tab, main: tab.role === 'primary', console_id: null,
  })) };
}

function defaultPresentation() {
  return { draft: '', viewport_end: null, expanded_turn_ids: [], review_posture: 'auto-review', pending_attachments: [] };
}
