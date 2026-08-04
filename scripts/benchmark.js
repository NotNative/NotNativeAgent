// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { TuiProjection } from '../src/tui-model.js';

const startup = [];
for (let index = 0; index < 30; index += 1) {
  const began = performance.now();
  const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('help benchmark invocation failed');
  startup.push(performance.now() - began);
}

const projection = new TuiProjection(512);
projection.addSession('benchmark', 'Benchmark', { model: 'fixture', provider: 'fixture' });
const beganProjection = performance.now();
for (let sequence = 0; sequence < 100_000; sequence += 1) {
  projection.apply('benchmark', { type: 'stream_delta', sequence, text: 'x' });
}
const projectionMs = performance.now() - beganProjection;

process.stdout.write(`${JSON.stringify({
  measured_at: new Date().toISOString(), node: process.version,
  platform: process.platform, arch: process.arch,
  cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? 'unknown',
  memory_bytes: os.totalmem(), samples: startup.length,
  help_ms: summarize(startup), projection_100k_ms: projectionMs,
  projection_retained_records: projection.active().records.length,
}, null, 2)}\n`);

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

