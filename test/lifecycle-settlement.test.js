// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleRegistry } from '../src/lifecycle.js';
import { settleEngineAttempt, settleEngineStep } from '../src/engine/lifecycle-settlement.js';

test('attempt settlement claims its lifecycle before asynchronous publication', async () => {
  const lifecycles = new LifecycleRegistry();
  const attempt = lifecycles.start('provider_attempt');
  const active = { turnId: 'turn-1', attemptId: attempt.id };
  let release;
  const published = [];
  const first = settleEngineAttempt({ lifecycles }, active, 'completed', async (...args) => {
    published.push(args);
    await new Promise((resolve) => { release = resolve; });
  });

  assert.equal(active.attemptId, null);
  await settleEngineAttempt({ lifecycles }, active, 'failed', async () => assert.fail('duplicate publication'));
  release();
  await first;

  assert.equal(published.length, 1);
  assert.equal(published[0][3].attemptId, attempt.id);
  assert.equal(lifecycles.snapshot().find((item) => item.id === attempt.id).outcome, 'completed');
});

test('failed step publication does not leave a terminal lifecycle claim active', async () => {
  const lifecycles = new LifecycleRegistry();
  const step = lifecycles.start('model_step');
  const active = { turnId: 'turn-1', stepId: step.id };
  const engine = { lifecycles, surface: 'headless' };

  await assert.rejects(settleEngineStep(engine, active, 'failed', async (_name, _category, _phase, correlation) => {
    assert.equal(correlation.stepId, step.id);
    throw Object.assign(new Error('publication failed'), { code: 'publish_failed' });
  }), { code: 'publish_failed' });

  assert.equal(active.stepId, null);
  await settleEngineStep(engine, active, 'continued', async () => assert.fail('duplicate publication'));
  assert.equal(lifecycles.snapshot().find((item) => item.id === step.id).outcome, 'failed');
});
