// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runModelStepLoop } from '../src/engine/step-loop.js';

test('turn wall clock bounds uncounted content-free completions after one provider attempt', async () => {
  const active = { startedAt: Date.now() - 5_000, recovery: {}, unresolvedToolFailures: [] };
  const engine = {
    config: { limits: { maxModelSteps: 8, turnWallClockMs: 1_000 } },
    reliability: {
      exhaustionDetail: (_recovery, _transcript, _failures, detail) => detail,
      exhaustionText: () => 'Turn time limit reached.',
    },
    transcript: [],
  };
  let attempts = 0;
  const result = await runModelStepLoop(engine, active, [], {
    runModelStep: async () => { attempts += 1; return { continue: true, countModelStep: false }; },
    prepareContext: async () => [],
    finalize: async (outcome, text, detail) => ({ outcome, text, detail }),
  });
  assert.equal(attempts, 1);
  assert.equal(result.outcome, 'limit_reached');
  assert.equal(result.detail.category, 'turn_wall_clock_limit');
  assert.equal(result.detail.count, 1);
});

test('turn wall clock finalizes a timed-out continuation before preparing another context', async () => {
  const active = { startedAt: Date.now(), recovery: {}, unresolvedToolFailures: [] };
  const engine = {
    config: { limits: { maxModelSteps: 8, turnWallClockMs: 1 } },
    reliability: {
      exhaustionDetail: (_recovery, _transcript, _failures, detail) => detail,
      exhaustionText: () => 'Turn time limit reached.',
    },
    transcript: [],
  };
  let preparations = 0;
  const result = await runModelStepLoop(engine, active, [], {
    runModelStep: async () => { active.startedAt = Date.now() - 5_000; return { continue: true, countModelStep: false }; },
    prepareContext: async () => { preparations += 1; return []; },
    finalize: async (outcome, text, detail) => ({ outcome, text, detail }),
  });
  assert.equal(result.outcome, 'limit_reached');
  assert.equal(preparations, 0);
});
