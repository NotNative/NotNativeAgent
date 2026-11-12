// SPDX-License-Identifier: Apache-2.0
/**
 * Rank installed tools by durable use evidence, for session-start loading.
 *
 * Why the reviewer ledger is the source: every tool request passes mandatory
 * review, so the ledger holds a complete record of what each session actually
 * called - `proposal` carries the tool name and classification, `execution_terminal`
 * carries how the call ended, joined by request id. Hash-chained and already
 * durable, it is the tally without building a second one.
 *
 * Why rank at session start only: a session's loaded surface must be static -
 * schemas loaded by `tool_search` stay until the session ends - so the ranking is
 * computed once, and within a session nothing moves. Evidence accumulates across
 * sessions, so each new session can start from what prior work actually used.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PROPOSAL = 'proposal';
const TERMINAL = 'execution_terminal';
/** How much recent evidence outweighs old evidence, per halving of age in days. */
const HALF_LIFE_DAYS = 30;
const MAX_JOURNALS = 256;
const MAX_RECORDS_PER_JOURNAL = 20_000;
/** How many ranked specialists a session auto-loads beyond the foundational baseline. */
export const MAX_RANKED_SESSION_TOOLS = 12;

/**
 * Rank tools by weighted use across the ledger.
 *
 * @param {{ root: string, listFiles?: (root: string) => string[], readText?: (path: string, encoding: string) => string,
 *           now?: number }} options ledger root and injectable IO for tests
 * @returns {Array<{ name: string, score: number, total: number,
 *           succeeded: number, failed: number }>} most-used first
 */
export function rankToolsFromLedger({ root, listFiles = readdirSync, readText = (path) => readFileSync(path, 'utf8'), now = Date.now() }) {
  let names;
  try { names = listFiles(root); } catch { return []; }
  const journals = names.filter((name) => name.endsWith('.review.journal.ndjson')).slice(0, MAX_JOURNALS);
  const terminals = new Map();
  const tools = new Map();

  for (const file of journals) {
    let text;
    try { text = readText(join(root, file), 'utf8'); } catch { continue; }
    let index = 0;
    for (const line of text.split('\n')) {
      if (index >= MAX_RECORDS_PER_JOURNAL) break;
      index += 1;
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (record.type === PROPOSAL && typeof payload.toolName === 'string' && payload.toolName) {
        tools.set(payload.requestId, { name: payload.toolName, at: record.recorded_at ?? record.time ?? null });
      } else if (record.type === TERMINAL && typeof payload.requestId === 'string') {
        terminals.set(payload.requestId, payload.terminal?.status ?? null);
      }
    }
  }

  // Join: a tool's call counts once, weighted by recency and split by outcome.
  const scores = new Map();
  for (const [requestId, call] of tools) {
    const status = terminals.get(requestId);
    const entry = scores.get(call.name) ?? { name: call.name, score: 0, total: 0, succeeded: 0, failed: 0 };
    entry.total += 1;
    // Why an unsettled call counts as failed: it still cost the model a step, and a
    // tool the model reaches for without getting results is exactly what ranking
    // should notice. Only a terminal 'succeeded' earns the succeeded column.
    if (status === 'succeeded') entry.succeeded += 1; else entry.failed += 1;
    entry.score += recencyWeight(call.at, now);
    scores.set(call.name, entry);
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * The names a session auto-loads beyond the foundational baseline.
 *
 * Why a cap: the loaded surface has a byte budget shared with the baseline and any
 * committed leases. The most-used tools are taken until the cap is reached; the
 * rest remain reachable through `tool_search`, which is always loaded.
 *
 * @param {{ root: string|null, now?: number, max?: number, exclude?: string[] }} options
 * @returns {string[]} ranked names, foundational and excluded names removed
 */
export function sessionRankedToolNames({ root, now = Date.now(), max = MAX_RANKED_SESSION_TOOLS, exclude = [] }) {
  if (!root) return [];
  const skip = new Set(exclude);
  const ranked = rankToolsFromLedger({ root, now });
  const names = [];
  for (const entry of ranked) {
    if (names.length >= max) break;
    if (skip.has(entry.name)) continue;
    // Legacy dotted names (fs.read_text) are older builds' spellings of names the
    // registry no longer installs; the caller's exclude set carries current names,
    // and a name with no definition is dropped at the planner anyway.
    names.push(entry.name);
  }
  return names;
}

/** A time weight in (0, 1]: halves per HALF_LIFE_DAYS before `now`. Unstamped calls count full. */
function recencyWeight(at, now) {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return 1;
  const ageDays = Math.max(0, (now - at) / 86_400_000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}
