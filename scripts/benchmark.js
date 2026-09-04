// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { TuiProjection } from '../src/experience/projection.js';

const HELP_SAMPLES = 30;
const PROJECTION_CAPACITY = 512;
const PROJECTION_EVENTS = 100_000;

try { run(); } catch (error) {
  process.stderr.write(`benchmark failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
}

function run() {
  const startup = [];
  for (let index = 0; index < HELP_SAMPLES; index += 1) {
    const startTime = performance.now();
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--help'], { encoding: 'utf8' });
    if (result.error) throw new Error(`help invocation failed: ${result.error.code ?? ''} ${result.error.message}`, { cause: result.error });
    if (result.signal) throw new Error(`help invocation terminated by ${result.signal}`);
    if (result.status !== 0) throw new Error(`help invocation exited with ${result.status}: ${result.stderr?.trim() || 'no diagnostics'}`);
    startup.push(performance.now() - startTime);
  }

  const projection = new TuiProjection(PROJECTION_CAPACITY);
  projection.addSession('benchmark', 'Benchmark', { model: 'fixture', provider: 'fixture' });
  const projectionStartTime = performance.now();
  for (let eventIndex = 0; eventIndex < PROJECTION_EVENTS; eventIndex += 1) {
    projection.apply('benchmark', { type: 'stream_delta', turn_id: `turn-${eventIndex}`, sequence: eventIndex, text: 'x' });
  }
  const projectionMs = performance.now() - projectionStartTime;
  if (projection.active().records.length !== PROJECTION_CAPACITY) throw new Error('projection retention benchmark did not exercise capacity');

  process.stdout.write(`${JSON.stringify({
    measured_at: new Date().toISOString(), node: process.version,
    platform: process.platform, arch: process.arch,
    cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? 'unknown',
    memory_bytes: os.totalmem(), samples: startup.length,
    help_ms: summarize(startup), projection_100k_ms: projectionMs,
    projection_retained_records: projection.active().records.length,
  }, null, 2)}\n`);
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}
