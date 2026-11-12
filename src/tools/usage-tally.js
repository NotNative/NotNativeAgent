// SPDX-License-Identifier: Apache-2.0
/**
 * Per-tool usage counts, for curation over time.
 *
 * Why counts instead of a one-off analysis: the tool list is a policy (which schemas
 * load every step, which wait behind `tool_search`), and a policy worth changing
 * should be changed by evidence, not by memory. Every terminal tool settlement
 * increments its tool's counter in one small durable file; a future dreaming pass
 * can read the tally and propose a list adjustment for operator approval.
 *
 * Why not engine/dream state directly: the tool loop has no dream dependency, and a
 * tally must survive crashes at the same durability as the tool journal it mirrors.
 * One bounded JSON file with atomic replace is enough for counts that are advisory.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from '../ids.js';

const MAX_TOOLS = 512;
const SCHEMA = 'nna.tool-usage-tally.v1';

/** One durable counter file. `path` is the product's tool-tally location. */
export class ToolUsageTally {
  #path;
  #counts = null;
  #writes = null;

  constructor({ path, readText = readFile, writeText = writeFile, replace = rename, makeDir = mkdir, countConsumer = null }) {
    if (typeof path !== 'string' || !path) throw new ContractError('tool_tally_path_required', 'tool usage tally requires a path');
    this.#path = path;
    this.#readText = readText;
    this.#writeText = writeText;
    this.#replace = replace;
    this.#makeDir = makeDir;
    // Why a consumer hook: the count itself is decided here, but what *does* something
    // with it lives elsewhere (a dream pass, a support report). The consumer sees every
    // settled tool name as a stream, without owning persistence.
    this.#countConsumer = countConsumer;
  }

  #readText;
  #writeText;
  #replace;
  #makeDir;
  #countConsumer;

  /**
   * Record one settlement of a tool.
   *
   * @param {string} toolName the settled tool's name
   * @param {{status?: string|null}} [detail] terminal status, for per-outcome counts
   */
  async record(toolName, detail = {}) {
    if (typeof toolName !== 'string' || !toolName.trim()) return;
    const name = toolName.trim();
    if (this.#counts === null) await this.#load();
    const entry = this.#counts.get(name) ?? { total: 0, succeeded: 0, failed: 0 };
    entry.total += 1;
    if (detail.status === 'succeeded') entry.succeeded += 1;
    else if (detail.status && detail.status !== 'succeeded') entry.failed += 1;
    this.#counts.set(name, entry);
    try { this.#countConsumer?.(name, detail); } catch { /* a consumer cannot break settlement */ }
    await this.#flush();
  }

  /** Current counts, most-used first. A snapshot, not a live view. */
  async snapshot() {
    if (this.#counts === null) await this.#load();
    return [...this.#counts.entries()]
      .map(([name, counts]) => ({ name, ...counts }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }

  async #load() {
    let parsed = null;
    try { parsed = JSON.parse(await this.#readText(this.#path)); } catch { /* first use or corrupt: start at zero */ }
    this.#counts = new Map();
    if (parsed && parsed.schema === SCHEMA && typeof parsed.counts === 'object' && parsed.counts !== null) {
      for (const [name, entry] of Object.entries(parsed.counts).slice(0, MAX_TOOLS)) {
        if (entry && Number.isSafeInteger(entry.total) && entry.total > 0) {
          this.#counts.set(name, { total: entry.total, succeeded: entry.succeeded ?? 0, failed: entry.failed ?? 0 });
        }
      }
    }
    this.#writes = 0;
  }

  async #flush() {
    // Why coalesce: a tool-heavy turn settles many calls; rewriting on each one
    // turns the tally into an IO hotspot. Every write replaces atomically, so a
    // crash loses at most the coalesce window — counts are advisory.
    this.#writes += 1;
    if (this.#writes % 8 !== 0) return;
    await this.#write();
  }

  async #write() {
    const counts = Object.fromEntries([...this.#counts.entries()].slice(0, MAX_TOOLS));
    const body = `${JSON.stringify({ schema: SCHEMA, updated_at: new Date().toISOString(), counts }, null, 1)}\n`;
    const temp = `${this.#path}.tmp`;
    await this.#makeDir(dirname(this.#path), { recursive: true });
    await this.#writeText(temp, body);
    await this.#replace(temp, this.#path);
  }

  /** Force a write; used at turn end so the coalesce window does not outlive the process. */
  async flushNow() { if (this.#counts !== null) await this.#write(); }
}
