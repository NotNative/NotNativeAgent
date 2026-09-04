// SPDX-License-Identifier: Apache-2.0
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  monotonic_ns TEXT,
  event_name TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT,
  outcome TEXT,
  reason_code TEXT,
  effect_certainty TEXT,
  duration_ms REAL,
  sequence INTEGER,
  runtime_id TEXT,
  session_id TEXT,
  conversation_id TEXT,
  turn_id TEXT,
  step_id TEXT,
  attempt_id TEXT,
  agent_run_id TEXT,
  parent_agent_run_id TEXT,
  provider_request_id TEXT,
  tool_request_id TEXT,
  hook_invocation_id TEXT,
  span_id TEXT,
  parent_span_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_name_timestamp ON events(event_name, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_turn_sequence ON events(turn_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_span ON events(span_id, status);
CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_request_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_run_id, sequence);
`;
const DEFAULT_MAX_BYTES = 1_073_741_824;
const TRIM_BATCH_ROWS = 5_000;
const MAX_TRIM_PASSES = 8;

let db = null;
let insert = null;
let writes = 0;
let lastWriteAt = null;
let lastCleanupAt = 0;

try {
  mkdirSync(dirname(workerData.dbPath), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(workerData.dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
  db.exec(SCHEMA);
  insert = db.prepare(`INSERT INTO events (
    timestamp, monotonic_ns, event_name, source, status, outcome, reason_code, effect_certainty,
    duration_ms, sequence, runtime_id, session_id, conversation_id, turn_id, step_id, attempt_id,
    agent_run_id, parent_agent_run_id, provider_request_id, tool_request_id, hook_invocation_id,
    span_id, parent_span_id, payload
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  cleanup();
  parentPort.postMessage({ type: 'ready', dbPath: workerData.dbPath });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', code: 'telemetry_open_failed', message: safeMessage(error) });
}

parentPort.on('message', (message) => {
  if (!db) return respondFailure(message, 'telemetry_unavailable');
  try {
    if (message.type === 'record') write(message.row);
    else if (message.type === 'query') respond(message.id, query(message.options));
    else if (message.type === 'open_spans') respond(message.id, openSpans(message.limit));
    else if (message.type === 'health') respond(message.id, health());
    else if (message.type === 'flush') { checkpoint(); respond(message.id, health()); }
    else if (message.type === 'close') { checkpoint(); db.close(); db = null; respond(message.id, { closed: true }); }
  } catch (error) {
    respondFailure(message, safeMessage(error));
  }
});

function write(row) {
  insert.run(
    row.timestamp, row.monotonic_ns, row.event_name, row.source, row.status, row.outcome,
    row.reason_code, row.effect_certainty, row.duration_ms, row.sequence, row.runtime_id,
    row.session_id, row.conversation_id, row.turn_id, row.step_id, row.attempt_id,
    row.agent_run_id, row.parent_agent_run_id, row.provider_request_id, row.tool_request_id,
    row.hook_invocation_id, row.span_id, row.parent_span_id, JSON.stringify(row.payload ?? null),
  );
  writes += 1;
  lastWriteAt = row.timestamp;
  if (writes % 512 === 0) cleanup();
}

function query(options = {}) {
  const limit = bounded(options.limit, 500, 1, 10_000);
  const clauses = [];
  const parameters = [];
  for (const [column, value] of [['session_id', options.sessionId], ['turn_id', options.turnId], ['event_name', options.eventName], ['status', options.status]]) {
    if (typeof value === 'string' && value.length > 0) { clauses.push(`${column} = ?`); parameters.push(value); }
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...parameters, limit);
  return rows.reverse().map(decode);
}

function openSpans(limitValue) {
  const limit = bounded(limitValue, 200, 1, 2000);
  const rows = db.prepare(`
    SELECT started.* FROM events AS started
    WHERE started.status = 'started' AND started.span_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM events AS terminal
        WHERE terminal.span_id = started.span_id
          AND terminal.status IN ('succeeded','failed','cancelled','timed_out','denied','skipped','superseded','unknown_effect')
      )
    ORDER BY started.id DESC LIMIT ?
  `).all(limit);
  return rows.reverse().map(decode);
}

function decode(row) {
  try { return { ...row, payload: JSON.parse(row.payload) }; }
  catch { return { ...row, payload: { _nna_telemetry: 'payload_decode_failed' } }; }
}

function cleanup() {
  const now = Date.now();
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  const cutoff = new Date(now - workerData.maxAgeMs).toISOString();
  const volatileCutoff = new Date(now - (workerData.volatileMaxAgeMs ?? 3 * 86_400_000)).toISOString();
  db.prepare("DELETE FROM events WHERE event_name LIKE 'tui.%' AND timestamp < ?").run(volatileCutoff);
  db.prepare('DELETE FROM events WHERE timestamp < ? AND session_id <> ?').run(cutoff, workerData.activeSessionId);
  const maxBytes = Number.isSafeInteger(workerData.maxBytes) && workerData.maxBytes > 0
    ? workerData.maxBytes : DEFAULT_MAX_BYTES;
  let size = databaseBytes();
  for (let pass = 0; size > maxBytes && pass < MAX_TRIM_PASSES; pass += 1) {
    const result = db.prepare(`DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE session_id IS NULL OR session_id <> ? ORDER BY id ASC LIMIT ?
    )`).run(workerData.activeSessionId, TRIM_BATCH_ROWS);
    if (Number(result.changes) === 0) break;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
    const compactedSize = databaseBytes();
    if (compactedSize >= size) break;
    size = compactedSize;
  }
}

function databaseBytes() {
  let total = 0;
  for (const path of [workerData.dbPath, `${workerData.dbPath}-wal`, `${workerData.dbPath}-shm`]) {
    try { total += statSync(path).size; } catch { /* absent sidecar */ }
  }
  return total;
}

function health() {
  return {
    status: db ? 'ready' : 'closed', dbPath: workerData.dbPath, writes, lastWriteAt,
    bytes: databaseBytes(), retentionDays: workerData.maxAgeMs / 86_400_000,
    volatileRetentionDays: (workerData.volatileMaxAgeMs ?? 3 * 86_400_000) / 86_400_000,
    maxBytes: workerData.maxBytes,
  };
}

function checkpoint() {
  if (db) db.exec('PRAGMA wal_checkpoint(PASSIVE)');
}

function respond(id, value) {
  if (id) parentPort.postMessage({ type: 'response', id, value });
}

function respondFailure(message, detail) {
  if (message?.id) parentPort.postMessage({ type: 'response', id: message.id, error: detail });
  else parentPort.postMessage({ type: 'degraded', code: 'telemetry_write_failed', message: detail });
}

function bounded(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function safeMessage(error) {
  return typeof error?.code === 'string' ? error.code : 'telemetry_operation_failed';
}
