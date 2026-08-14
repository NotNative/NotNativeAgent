// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { EventHub } from '../src/events.js';
import { RecoverySupervisor } from '../src/recovery.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { TuiProjection } from '../src/experience/projection.js';
import { TuiRenderer } from '../src/tui/renderer.js';
import { VERSION } from '../src/product.js';

const quick = process.argv.includes('--quick');
const samples = quick ? 3 : 30;
const streamEvents = quick ? 2_000 : 100_000;
const observerEvents = quick ? 256 : 10_000;
const soakTurns = quick ? 5 : 100;
const root = await mkdtemp(join(tmpdir(), 'nna-performance-lab-'));

try {
  const report = {
    schema_version: 1, product_version: VERSION, measured_at: new Date().toISOString(),
    environment: environment(), parameters: { quick, samples, streamEvents, observerEvents, soakTurns },
    help_startup_ms: benchmarkHelp(samples),
    engine_initialization_ms: await benchmarkInitialization(root, samples),
    first_frame_ms: benchmarkFirstFrame(samples),
    stream_projection: benchmarkProjection(streamEvents),
    observer_queue: await benchmarkObserverQueue(observerEvents),
    detector_and_context: await benchmarkDetectorAndContext(root, quick),
    resource_soak: await benchmarkSoak(root, soakTurns),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function benchmarkHelp(count) {
  return summarize(measure(count, () => {
    const result = spawnSync(process.execPath, ['src/cli.js', '--help'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error('help benchmark invocation failed');
  }));
}

async function benchmarkInitialization(workspace, count) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const engine = fixtureEngine(workspace, `init-${index}`);
    const began = performance.now();
    await engine.initialize();
    values.push(performance.now() - began);
    await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: `stop-${index}` });
  }
  return summarize(values);
}

function benchmarkFirstFrame(count) {
  return summarize(measure(count, () => {
    const projection = new TuiProjection();
    projection.addSession('benchmark', 'Benchmark', { provider: 'fixture', model: 'fixture', workspace: '.' }, 'primary');
    new TuiRenderer().frame(projection, { width: 100, height: 30, color: false });
  }));
}

function benchmarkProjection(count) {
  const projection = new TuiProjection(512);
  projection.addSession('benchmark', 'Benchmark', { provider: 'fixture', model: 'fixture' });
  const began = performance.now();
  for (let sequence = 0; sequence < count; sequence += 1) {
    projection.apply('benchmark', { type: 'stream_delta', sequence, text: 'x' });
  }
  return { events: count, elapsed_ms: performance.now() - began, retained_records: projection.active().records.length };
}

async function benchmarkObserverQueue(count) {
  const hub = new EventHub({ maxBackground: 64 });
  hub.register({
    id: 'lab.slow-observer', category: 'turn', phase: 'active', blocking: false,
    priority: 0, timeoutMs: 1_000, failurePolicy: 'continue', cancellation: 'detach',
    inputContract: 'nna.performance-event/1.0', outputContract: 'nna.performance-result/1.0',
    origin: 'core:performance-lab', trust: 'local_diagnostic',
    resourceBounds: Object.freeze({ maxOutputBytes: 1_024, maxConcurrent: 64 }),
  }, async () => new Promise((resolve) => setTimeout(resolve, 2)));
  const latencies = [];
  for (let sequence = 0; sequence < count; sequence += 1) {
    const began = performance.now();
    await hub.dispatch({ category: 'turn', phase: 'active', sequence });
    latencies.push(performance.now() - began);
  }
  const beforeDrain = hub.health();
  await hub.close();
  return { events: count, forwarding_ms: summarize(latencies), before_drain: beforeDrain, after_drain: hub.health() };
}

async function benchmarkDetectorAndContext(workspace, isQuick) {
  const sizes = isQuick ? [100, 1_000] : [1_000, 10_000, 100_000];
  const detector = sizes.map((size) => {
    const supervisor = new RecoverySupervisor();
    const began = performance.now();
    for (let index = 0; index < size; index += 1) supervisor.observeProgress(`evidence-${index}`);
    return { inputs: size, elapsed_ms: performance.now() - began, retained: supervisor.exhaustion().progress_fingerprints };
  });
  const registry = new ToolRegistry(workspace);
  await registry.initialize();
  const visible = registry.providerDefinitions('');
  return { detector, visible_tool_count: visible.length, visible_tool_schema_bytes: Buffer.byteLength(JSON.stringify(visible)) };
}

async function benchmarkSoak(workspace, count) {
  const before = resourceCounts();
  const began = performance.now();
  for (let index = 0; index < count; index += 1) {
    const engine = fixtureEngine(workspace, `soak-${index}`);
    await engine.initialize();
    await engine.submit({ version: '1.0', type: 'submit', request_id: `turn-${index}`, content: 'respond' }, 'lab');
    await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: `shutdown-${index}` });
  }
  await new Promise((resolve) => setImmediate(resolve));
  const after = resourceCounts();
  return { turns: count, elapsed_ms: performance.now() - began, before, after, delta: resourceDelta(before, after) };
}

function fixtureEngine(workspace, sessionId) {
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: workspace,
    provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
  });
  return new SessionEngine({
    config, sessionId, hookRoot: join(workspace, 'hooks'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'ok' }; yield { type: 'terminal' }; } }),
  });
}

function measure(count, operation) {
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const began = performance.now(); operation(); values.push(performance.now() - began);
  }
  return values;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return { samples: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function resourceCounts() {
  return Object.fromEntries(Object.entries(Object.groupBy(process.getActiveResourcesInfo(), (name) => name))
    .map(([name, values]) => [name, values.length]));
}

function resourceDelta(before, after) {
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]).filter(([, value]) => value !== 0));
}

function environment() {
  return {
    node: process.version, platform: process.platform, release: os.release(), arch: process.arch,
    cpu_model: os.cpus()[0]?.model ?? 'unknown', cpu_count: os.cpus().length, memory_bytes: os.totalmem(),
  };
}
