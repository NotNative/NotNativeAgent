// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_PROFILES = 256;
const KNOWN_FAILURES = new Set([
  'provider_event_invalid', 'provider_missing_terminal', 'provider_empty_stream',
  'provider_conflicting_terminal', 'provider_usage_invalid', 'tool_arguments_invalid',
  'reviewer_output_malformed',
]);

export class ModelDialectRegistry {
  constructor(options = {}) {
    this.path = options.path;
    this.telemetry = options.telemetry;
    this.profiles = new Map();
    this.dirty = false;
    this.flushing = null;
  }

  async initialize() {
    if (!this.path) return;
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      for (const item of Array.isArray(value?.profiles) ? value.profiles.slice(0, MAX_PROFILES) : []) {
        if (validProfile(item)) this.profiles.set(item.key, item);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.telemetry?.record('model.dialect', 'failed', { code: 'dialect_store_invalid' });
    }
  }

  instructions(route) {
    const profile = this.#profile(route);
    const failures = profile.failures ?? {};
    const guidance = [
      'Follow tool JSON schemas exactly. Use native tool calls only; do not print tool-call JSON, XML, or markdown as assistant text.',
      'Call only tools needed for this step, then wait for their results before claiming completion.',
    ];
    if (profile.family === 'qwen') guidance.push('Keep tool arguments literal and complete; never abbreviate hashes, paths, or line ranges.');
    if (profile.family === 'gemma') guidance.push('When a tool is required, emit its call before explanatory prose.');
    if ((failures.provider_event_invalid ?? 0) + (failures.tool_arguments_invalid ?? 0) >= 2) {
      guidance.push('Recent local schema failures were observed: verify every required property and emit one tool call at a time.');
    }
    if ((failures.provider_missing_terminal ?? 0) + (failures.provider_conflicting_terminal ?? 0) >= 2) {
      guidance.push('End each response exactly once and never emit content after termination.');
    }
    return guidance.join(' ');
  }

  observe(route, outcome) {
    const profile = this.#profile(route);
    profile.observations += 1;
    profile.last_seen_at = new Date().toISOString();
    if (outcome.status === 'succeeded') profile.successes += 1;
    else {
      const code = KNOWN_FAILURES.has(outcome.code) ? outcome.code : 'other_failure';
      profile.failures[code] = Math.min(10_000, (profile.failures[code] ?? 0) + 1);
    }
    this.dirty = true;
    this.telemetry?.record('model.dialect', outcome.status, {
      profile_key: profile.key, family: profile.family, observation: outcome,
      learned_guidance_active: Object.values(profile.failures).some((count) => count >= 2),
    }, { reasonCode: outcome.code });
    void this.flush();
  }

  snapshot(route) { return structuredClone(this.#profile(route)); }

  async flush() {
    if (this.flushing) {
      await this.flushing;
      return this.dirty ? this.flush() : undefined;
    }
    if (!this.path || !this.dirty) return;
    this.dirty = false;
    this.flushing = this.#write().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async close() { await this.flush(); }

  async #write() {
    const profiles = [...this.profiles.values()]
      .sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at))).slice(0, MAX_PROFILES);
    const temporary = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ format: 1, profiles }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      this.dirty = true;
      this.telemetry?.record('model.dialect', 'failed', { code: 'dialect_store_write_failed' }, { reasonCode: error?.code });
    }
  }

  #profile(route) {
    const provider = route?.profile?.id ?? route?.providerId ?? 'unknown-provider';
    const model = route?.model ?? route?.profile?.model ?? 'unknown-model';
    const key = `${provider}/${model}`.slice(0, 512);
    if (!this.profiles.has(key)) {
      if (this.profiles.size >= MAX_PROFILES) this.profiles.delete(this.profiles.keys().next().value);
      this.profiles.set(key, {
        key, provider_id: provider, model, family: modelFamily(model), observations: 0,
        successes: 0, failures: {}, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
      });
      this.dirty = true;
    }
    return this.profiles.get(key);
  }
}

function modelFamily(model) {
  const value = String(model).toLowerCase();
  if (value.includes('qwen')) return 'qwen';
  if (value.includes('gemma')) return 'gemma';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('mistral') || value.includes('mixtral')) return 'mistral';
  if (value.includes('llama')) return 'llama';
  return 'unknown';
}

function validProfile(value) {
  return value && typeof value === 'object' && typeof value.key === 'string' && value.key.length <= 512
    && typeof value.model === 'string' && typeof value.family === 'string'
    && Number.isSafeInteger(value.observations) && Number.isSafeInteger(value.successes)
    && value.failures && typeof value.failures === 'object' && !Array.isArray(value.failures);
}
