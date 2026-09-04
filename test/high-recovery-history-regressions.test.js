// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForProviderRecovery, startProviderHealthMonitor } from '../src/provider/completion-recovery.js';
import { sessionHistoryDefinitions } from '../src/session-history-tools.js';

test('recovery defaults supply a finite positive probe deadline', async () => {
  const original = globalThis.setTimeout; const delays = [];
  globalThis.setTimeout = (fn, ms, ...args) => { delays.push(ms); return original(fn, ms, ...args); };
  try {
    const active = { controller: new AbortController() };
    assert.equal(await waitForProviderRecovery({ health: async () => true }, active, { delayMs: 1 }), 'retry');
    assert.ok(delays.every((ms) => Number.isFinite(ms) && ms > 0));
  } finally { globalThis.setTimeout = original; }
});
test('throwing telemetry cannot abort recovery or stop health monitoring', async () => {
  const telemetry = { record() { throw new Error('sink failed'); } };
  assert.equal(await waitForProviderRecovery({ health: async () => true }, { controller: new AbortController() }, { delayMs: 1, healthProbeTimeoutMs: 50, telemetry }), 'retry');
  const controller = new AbortController(); const active = { lastProviderActivityAt: 0 }; let probes = 0;
  const monitor = startProviderHealthMonitor({ provider: { health: async () => { probes += 1; } }, active, signal: controller.signal, telemetry, intervalMs: 1, timeoutMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 20)); await monitor.stop();
  assert.ok(probes > 1); assert.ok(active.lastProviderHealthAt > 0);
});
test('steering cancels recovery probes without a spurious health failure', async () => {
  const events = []; let entered;
  const started = new Promise((resolve) => { entered = resolve; }); const active = { controller: new AbortController() };
  const provider = { health: async (signal) => { entered(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')), { once: true })); } };
  const pending = waitForProviderRecovery(provider, active, { delayMs: 1, healthProbeTimeoutMs: 5000, telemetry: { record: (...args) => events.push(args) } });
  await started; active.providerRecoveryWaiter.resolve('steering'); assert.equal(await pending, 'steering');
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(events.some(([, status]) => status === 'failed'), false);
});
test('history read stays parseable within the output bound across large neighboring records', async () => {
  const records = Array.from({ length: 7 }, (_, index) => ({ type: 'message', content: `${index}:` + '\u0001'.repeat(100000) }));
  const read = sessionHistoryDefinitions({ transcript: () => records }).find((item) => item.name === 'session.read_history');
  const result = await read.executor({ args: { record_index: 3, surrounding: 3 } }, new AbortController().signal);
  assert.ok(Buffer.byteLength(result.content) < 1_048_576); assert.equal(JSON.parse(result.content).records.length, 7);
});
test('history search yields so external cancellation can stop a long scan', async () => {
  const records = Array.from({ length: 50000 }, () => ({ type: 'message', content: 'needle' }));
  const search = sessionHistoryDefinitions({ transcript: () => records }).find((item) => item.name === 'session.search_history');
  const controller = new AbortController(); const cancel = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(search.executor({ args: { query: 'needle' } }, controller.signal), { code: 'tool_cancelled' }); }
  finally { clearTimeout(cancel); }
});
