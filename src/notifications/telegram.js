// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, requireExternalId } from '../ids.js';
import { TURN_OUTCOMES } from '../contracts.js';
import { persistAtomicJsonIfAbsent } from '../persistence/atomic-json.js';
import { readVerifiedTurnOutcomes } from '../persistence/notification-journal.js';

const NOTIFICATION_TIMEOUT_MS = 2_000;
const MAX_NOTIFICATION_LENGTH = 1_000;
export const MAX_OUTBOX_BATCH = 128;
const MAX_OUTBOX_FILE_BYTES = 16_384;
const MAX_PENDING_INTENTS = 1_024;

export class TelegramNotificationQueue {
  constructor(root, sessionId, options = {}) {
    this.root = root; this.sessionId = requireExternalId(sessionId, 'session_id');
    this.pending = new Map();
    this.durable = options.durable !== false;
    this.recoveryAvailable = options.recoveryAvailable !== false;
  }
  async schedule(turnId, message) {
    requireExternalId(turnId, 'turn_id');
    if (typeof message !== 'string' || !message.trim()) throw new ContractError('notification_invalid', 'Telegram notification requires a message');
    if (!this.durable || !this.recoveryAvailable) {
      throw new ContractError('notification_recovery_unavailable', 'Telegram notification requires a durable session visible to the gateway');
    }
    const normalized = message.trim();
    if (normalized.length > MAX_NOTIFICATION_LENGTH) throw new ContractError('notification_invalid', 'Telegram notification message is too long');
    const id = notificationId(this.sessionId, turnId);
    const path = pendingPath(this.root, id);
    await mkdir(join(this.root, 'pending'), { recursive: true, mode: 0o700 });
    await assertNotificationDirectory(this.root);
    await assertNotificationDirectory(join(this.root, 'pending'));
    const names = await readdir(join(this.root, 'pending'));
    const intents = names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
    const ready = (await readdir(this.root)).filter((name) => /^[a-f0-9-]+\.json$/iu.test(name));
    if (ready.includes(`${id}.json`)) {
      throw new ContractError('notification_duplicate', 'a Telegram notification was already published for this turn');
    }
    if (intents.length + ready.length >= MAX_PENDING_INTENTS && !intents.includes(`${id}.json`)) {
      throw new ContractError('notification_backlog_full', 'Telegram notification backlog is full');
    }
    try {
      await persistAtomicJsonIfAbsent(path, {
        version: 2, id, session_id: this.sessionId, turn_id: turnId,
        message: normalized, created_at: new Date().toISOString(),
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readNotificationFile(path);
      if (existing?.message !== normalized || existing?.session_id !== this.sessionId || existing?.turn_id !== turnId) {
        throw new ContractError('notification_duplicate', 'a different Telegram notification is already scheduled for this turn');
      }
    }
    this.pending.set(turnId, id);
  }
  async terminal(record) {
    const id = this.pending.get(record.turn_id);
    if (!id) return false;
    const source = pendingPath(this.root, id);
    const destination = join(this.root, `${id}.json`);
    await assertNotificationDirectory(this.root);
    await assertNotificationDirectory(join(this.root, 'pending'));
    try {
      await rename(source, destination);
      await syncPromotion(this.root);
      this.pending.delete(record.turn_id);
    } catch (error) {
      if (error?.code === 'ENOENT' && await exists(destination)) {
        this.pending.delete(record.turn_id);
        return true;
      }
      throw error;
    }
    return true;
  }
}

export function telegramNotificationDefinition(control, activeTurnId) {
  return {
    name: 'notification_telegram', version: 1,
    purpose: 'Ask the NNA gateway to notify the operator on Telegram after the current turn reaches a terminal outcome.',
    sideEffect: 'external_communication', scope: 'operator_notification', cancellation: true, timeoutMs: NOTIFICATION_TIMEOUT_MS,
    inputSchema: {
      type: 'object', properties: {
        message: { type: 'string', minLength: 1, maxLength: MAX_NOTIFICATION_LENGTH, description: 'Required message to send to the configured operator after this turn finishes.' },
      },
      required: ['message'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args.message !== 'string' || !args.message.trim() || args.message.length > MAX_NOTIFICATION_LENGTH
        || Object.keys(args).some((key) => key !== 'message')) {
        throw new ContractError('notification_invalid', 'Telegram notification requires one bounded message');
      }
      return { args: { message: args.message.trim() }, resolved: { destination: 'configured_telegram_operator' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'Telegram notification was cancelled');
      await control.schedule(activeTurnId(), request.args.message);
      return { content: 'Telegram notification scheduled for turn completion', metadata: { delivery: 'turn_terminal' } };
    },
  };
}

export async function readTelegramOutbox(root, sessionsRoot, options = {}) {
  let names;
  try { await assertNotificationDirectory(root); names = await readdir(root); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const candidates = names.filter((item) => /^[a-f0-9-]+\.json$/iu.test(item)).sort();
  // Why: an undeliverable older file must not permanently hide later ready notifications.
  const start = candidates.length ? (options.offset ?? 0) % candidates.length : 0;
  const selected = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, MAX_OUTBOX_BATCH);
  const settled = [];
  for (const name of selected) {
    try { settled.push(await readReadyNotification(root, name)); }
    catch (error) {
      if (!isolatableNotificationFailure(error, options.signal) || !options.onFileError) throw error;
      options.onFileError(name, error.code);
    }
  }
  const outcomes = sessionsRoot ? await notificationOutcomesFor(sessionsRoot, settled.filter((item) => item?.version === 2), options)
    : new Map();
  return settled.filter(Boolean).map((item) => item.version === 2
    ? { ...item, outcome: outcomes.get(item.session_id)?.get(item.turn_id) ?? null } : item)
    .filter((item) => item.outcome);
}

async function readReadyNotification(root, name) {
  const path = join(root, name);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > MAX_OUTBOX_FILE_BYTES) { await unlink(path); return null; }
    const bytes = await readPinnedNotification(path, metadata);
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { await unlink(path); return null; }
    if (bytes.length <= MAX_OUTBOX_FILE_BYTES && validNotification(value, name)) {
      return { ...value, path };
    }
    await unlink(path); return null;
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function reconcileTelegramNotifications(root, sessionsRoot, options = {}) {
  const directory = join(root, 'pending');
  let names;
  try { await assertNotificationDirectory(root); await assertNotificationDirectory(directory); names = await readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  const candidates = names.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  if (candidates.length > MAX_PENDING_INTENTS) {
    throw new ContractError('notification_backlog_full', 'Telegram notification backlog exceeds its supported bound');
  }
  const ordered = candidates.sort();
  // Why: bounded reconciliation must eventually visit later intents when earlier turns remain active.
  const start = ordered.length ? (options.offset ?? 0) % ordered.length : 0;
  const selected = [...ordered.slice(start), ...ordered.slice(0, start)].slice(0, MAX_OUTBOX_BATCH);
  const valid = [];
  for (const name of selected) {
    const source = join(directory, name);
    let value;
    try {
      value = await readNotificationFile(source);
      if (!validNotification(value, name) || value.version !== 2) {
        throw new ContractError('notification_intent_invalid', 'Telegram notification intent is invalid');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      if (!isolatableNotificationFailure(error, options.signal)) throw error;
      // Invariant: preserve failed or malformed evidence, but let independent intents proceed.
      if (error?.code === 'notification_intent_invalid') {
        if (!options.onInvalid) throw error;
        options.onInvalid(name);
      } else {
        if (!options.onFileError) throw error;
        options.onFileError(name, error.code);
      }
      continue;
    }
    valid.push({ ...value, name, source });
  }
  const outcomes = await notificationOutcomesFor(sessionsRoot, valid, options);
  let promoted = 0;
  for (const item of valid) {
    if (!outcomes.get(item.session_id)?.get(item.turn_id)) continue;
    const { name, source } = item;
    try { await rename(source, join(root, name)); await syncPromotion(root); promoted += 1; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return promoted;
}

function notificationId(sessionId, turnId) {
  return createHash('sha256').update(`${sessionId}\0${turnId}`).digest('hex');
}
function pendingPath(root, id) { return join(root, 'pending', `${id}.json`); }
async function assertNotificationDirectory(path) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContractError('notification_path_unsafe', 'Telegram notification directory is not a trusted directory');
  }
}
async function syncPromotion(root) {
  if (process.platform === 'win32') return;
  for (const directory of [join(root, 'pending'), root]) {
    const handle = await open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function readNotificationFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > MAX_OUTBOX_FILE_BYTES) throw new ContractError('notification_intent_invalid', 'Telegram notification intent is not a bounded regular file');
  try { return JSON.parse((await readPinnedNotification(path, metadata)).toString('utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ContractError('notification_intent_invalid', 'Telegram notification intent is malformed');
    throw error;
  }
}
async function readPinnedNotification(path, expected) {
  const invalid = () => new ContractError('notification_intent_invalid', 'Telegram notification file changed or exceeded its byte limit');
  let handle;
  // Security: on POSIX, fail symlink swaps and avoid blocking if a regular file becomes a FIFO.
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (error?.code === 'ELOOP') throw invalid(); throw error; }
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino
      || actual.size > MAX_OUTBOX_FILE_BYTES) throw invalid();
    // Invariant: pin one file and read at most one byte beyond the accepted bound.
    const bytes = Buffer.alloc(MAX_OUTBOX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_OUTBOX_FILE_BYTES) throw invalid();
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function validNotification(value, name) {
  if (typeof value?.message !== 'string' || !value.message.trim() || value.message.length > MAX_NOTIFICATION_LENGTH
    || !validNotificationId(value.session_id)) return false;
  if (value.version === 1) return value.id === name.slice(0, -5)
    && TURN_OUTCOMES.includes(value.outcome);
  return value.version === 2 && /^[a-f0-9]{64}\.json$/u.test(name)
    && value.id === name.slice(0, -5) && validNotificationId(value.turn_id)
    && notificationId(value.session_id, value.turn_id) === value.id;
}
function validNotificationId(value) {
  try { requireExternalId(value); return true; }
  catch (error) { if (error?.code === 'invalid_id') return false; throw error; }
}
async function notificationOutcomesFor(sessionsRoot, notifications, options) {
  const grouped = new Map();
  for (const item of notifications) {
    requireExternalId(item.session_id, 'session_id');
    requireExternalId(item.turn_id, 'turn_id');
    const ids = grouped.get(item.session_id) ?? new Set();
    ids.add(item.turn_id);
    grouped.set(item.session_id, ids);
  }
  const result = new Map();
  if (grouped.size === 0) return result;
  try { await assertNotificationDirectory(sessionsRoot); }
  catch (error) { if (error?.code === 'ENOENT') return result; throw error; }
  for (const [sessionId, ids] of grouped) {
    const path = join(sessionsRoot, `${sessionId}.journal.ndjson`);
    const prior = options.journalCache?.get(path);
    if (prior?.failed) { result.set(sessionId, new Map()); continue; }
    const turnIds = new Set([...(prior?.turnIds ?? []), ...ids]);
    const promise = prior && turnIds.size === prior.turnIds.size ? prior.promise
      : readVerifiedTurnOutcomes(path, { turnIds, signal: options.signal });
    options.journalCache?.set(path, { turnIds, promise });
    try { result.set(sessionId, await promise); }
    catch (error) {
      if (!isolatableNotificationFailure(error, options.signal) || !options.onSourceError) throw error;
      options.onSourceError(sessionId, error.code);
      const empty = new Map();
      // Why: retry a failed source on the next drain, not twice in the same drain.
      options.journalCache?.set(path, { turnIds, promise: Promise.resolve(empty), failed: true });
      result.set(sessionId, empty);
    }
  }
  return result;
}

function isolatableNotificationFailure(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return false;
  return ['EIO', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EISDIR',
    'notification_intent_invalid', 'notification_journal_invalid', 'notification_journal_path_unsafe',
    'notification_journal_path_changed', 'notification_journal_record_too_large', 'notification_journal_changed',
    'journal_version_future'].includes(error?.code);
}

export async function acknowledgeTelegramNotification(item) {
  try { await unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
