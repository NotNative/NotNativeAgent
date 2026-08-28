// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const MAX_PROFILES = 256;
const FAILURE_GUIDANCE_THRESHOLD = 2;
const MAX_FAILURE_COUNT = 10_000;
const MAX_TOOL_CONTRACT_CANDIDATES = 64;
export const TOOL_CONTRACT_LEARNING_EPOCH = 3;
export const TOOL_CONTRACT_LEARNING_MODE = 'shadow';
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
        if (validProfile(item)) this.profiles.set(item.key, normalizeProfile(item));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.telemetry?.record('model.dialect', 'failed', { code: 'dialect_store_invalid' });
    }
  }

  instructions(route) {
    const profile = this.#profile(route, false);
    const failures = profile.failures ?? {};
    const guidance = [
      'Follow tool JSON schemas exactly. Use native tool calls only; do not print tool-call JSON, XML, or markdown as assistant text.',
      'Emit needed tool calls promptly. Batch independent read-only calls only; emit exactly one mutating tool call per response, then wait for its result before the next mutation or completion claim.',
    ];
    if (profile.family === 'qwen') guidance.push('Keep tool arguments literal and complete; never abbreviate hashes, paths, or line ranges.');
    if (profile.family === 'gemma') guidance.push('When a tool is required, emit its call before explanatory prose.');
    if ((failures.provider_event_invalid ?? 0) >= FAILURE_GUIDANCE_THRESHOLD) {
      guidance.push('Recent local provider-event failures were observed: emit native calls with complete arguments and no surrounding serialization.');
    }
    if ((failures.provider_missing_terminal ?? 0) + (failures.provider_conflicting_terminal ?? 0) >= FAILURE_GUIDANCE_THRESHOLD) {
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
      profile.failures[code] = Math.min(MAX_FAILURE_COUNT, (profile.failures[code] ?? 0) + 1);
    }
    this.dirty = true;
    this.telemetry?.record('model.dialect', outcome.status, {
      profile_key: profile.key, family: profile.family, observation: outcome,
      learned_guidance_active: learnedGuidanceActive(profile.failures),
    }, { reasonCode: outcome.code });
    // Observation persistence is non-blocking; unexpected rejection is recorded.
    void this.flush().catch((error) => {
      this.dirty = true;
      this.telemetry?.record('model.dialect', 'failed', {
        code: 'dialect_store_flush_failed',
      }, { reasonCode: error?.code ?? 'dialect_store_flush_failed' });
    });
  }

  observeToolContract(route, observation) {
    if (!observation || !['failed', 'repaired'].includes(observation.status)
      || typeof observation.tool !== 'string' || !Number.isSafeInteger(observation.version)) return false;
    const profile = this.#profile(route);
    const state = currentToolLearning(profile.tool_contract_learning);
    profile.tool_contract_learning = state;
    const reason = boundedKey(observation.reason_code ?? 'tool_schema_invalid', 128);
    const key = boundedKey(`${observation.tool}@${observation.version}/${reason}`, 512);
    const existing = state.candidates[key] ?? {
      tool: observation.tool, version: observation.version, reason_code: reason,
      failures: 0, validated_repairs: 0, last_seen_at: new Date().toISOString(),
    };
    if (observation.status === 'failed') existing.failures = Math.min(MAX_FAILURE_COUNT, existing.failures + 1);
    else existing.validated_repairs = Math.min(MAX_FAILURE_COUNT, existing.validated_repairs + 1);
    existing.last_seen_at = new Date().toISOString();
    delete state.candidates[key];
    state.candidates[key] = existing;
    while (Object.keys(state.candidates).length > MAX_TOOL_CONTRACT_CANDIDATES) delete state.candidates[Object.keys(state.candidates)[0]];
    this.dirty = true;
    this.telemetry?.record('model.tool_contract_learning', 'observed', {
      profile_key: profile.key, mode: state.mode, epoch: state.epoch,
      observation: { ...observation, reason_code: reason }, promoted: false,
    });
    void this.flush().catch((error) => {
      this.dirty = true;
      this.telemetry?.record('model.tool_contract_learning', 'failed', {
        code: 'dialect_store_flush_failed',
      }, { reasonCode: error?.code ?? 'dialect_store_flush_failed' });
    });
    return true;
  }

  snapshot(route) { return structuredClone(this.#profile(route, false)); }

  async flush() {
    while (true) {
      if (this.flushing) await this.flushing;
      if (!this.path || !this.dirty) return;
      this.dirty = false;
      const operation = this.#write();
      this.flushing = operation;
      let succeeded;
      try { succeeded = await operation; } finally { if (this.flushing === operation) this.flushing = null; }
      if (!succeeded) return;
    }
  }

  async close() { await this.flush(); }

  async #write() {
    const profiles = [...this.profiles.values()]
      .sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at))).slice(0, MAX_PROFILES);
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ format: 2, profiles }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
      return true;
    } catch (error) {
      this.dirty = true;
      this.telemetry?.record('model.dialect', 'failed', { code: 'dialect_store_write_failed' }, { reasonCode: error?.code });
      return false;
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  #profile(route, create = true) {
    const provider = route?.profile?.id ?? route?.providerId ?? 'unknown-provider';
    const model = route?.model ?? route?.profile?.model ?? 'unknown-model';
    const key = `${provider}/${model}`.slice(0, 512);
    if (!this.profiles.has(key)) {
      const profile = newProfile(key, provider, model);
      if (!create) return profile;
      if (this.profiles.size >= MAX_PROFILES) this.profiles.delete(oldestProfileKey(this.profiles));
      this.profiles.set(key, profile);
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
    && typeof value.provider_id === 'string' && typeof value.model === 'string' && typeof value.family === 'string'
    && nonNegativeInteger(value.observations) && nonNegativeInteger(value.successes) && value.successes <= value.observations
    && validTimestamp(value.first_seen_at) && validTimestamp(value.last_seen_at)
    && validFailures(value.failures);
}

function newProfile(key, provider, model) {
  const now = new Date().toISOString();
  return { key, provider_id: provider, model, family: modelFamily(model), observations: 0,
    successes: 0, failures: {}, tool_contract_learning: newToolLearning(), first_seen_at: now, last_seen_at: now };
}

function normalizeProfile(profile) {
  return { ...profile, tool_contract_learning: currentToolLearning(profile.tool_contract_learning) };
}

function newToolLearning() {
  return { mode: TOOL_CONTRACT_LEARNING_MODE, epoch: TOOL_CONTRACT_LEARNING_EPOCH, candidates: {} };
}

function currentToolLearning(value) {
  if (!value || value.mode !== TOOL_CONTRACT_LEARNING_MODE || value.epoch !== TOOL_CONTRACT_LEARNING_EPOCH
    || !value.candidates || typeof value.candidates !== 'object' || Array.isArray(value.candidates)) return newToolLearning();
  return value;
}

function learnedGuidanceActive(failures) {
  return (failures.provider_event_invalid ?? 0) >= FAILURE_GUIDANCE_THRESHOLD
    || (failures.provider_missing_terminal ?? 0) + (failures.provider_conflicting_terminal ?? 0) >= FAILURE_GUIDANCE_THRESHOLD;
}

function boundedKey(value, maximum) { return String(value).slice(0, maximum); }

function oldestProfileKey(profiles) {
  return [...profiles.values()].reduce((oldest, profile) => (
    !oldest || String(profile.last_seen_at).localeCompare(String(oldest.last_seen_at)) < 0 ? profile : oldest
  ), null)?.key;
}

function validFailures(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([code, count]) => (KNOWN_FAILURES.has(code) || code === 'other_failure')
      && nonNegativeInteger(count) && count <= MAX_FAILURE_COUNT);
}

function nonNegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function validTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
