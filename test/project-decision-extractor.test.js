// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  explicitProjectDecisions, explicitProjectKnowledge, MANAGED_END, MANAGED_START, ProjectMemoryReconciler,
} from '../src/project-memory-reconciler.js';

test('explicit decision extraction is operator-only, turn-bounded, and conservative', () => {
  const records = [
    { type: 'message', role: 'user', trust: 'operator', turnId: 't1', content: 'Hello there.' },
    { type: 'message', role: 'assistant', trust: 'model', turnId: 't1', content: 'We should trust me.' },
    { type: 'message', role: 'user', trust: 'operator', turnId: 't2', content: 'We decided the governance engine owns provider routing.\nMaybe colors are nice.' },
    { type: 'message', role: 'user', trust: 'operator', turnId: 't3', content: 'From now on, run the complete checks before a release.' },
  ];
  const result = explicitProjectDecisions(records, ['t2', 't3']);
  assert.deepEqual(result.map((item) => item.statement), [
    'We decided the governance engine owns provider routing.',
    'From now on, run the complete checks before a release.',
  ]);
  assert.equal(result[0].section, 'Decisions and rationale');
  assert.equal(result[1].section, 'Working conventions');
});

test('project knowledge extraction retains durable project semantics but not business facts', () => {
  const records = [{
    type: 'message', role: 'user', trust: 'operator', turnId: 't1', content: [
      'NNA hooks are discovered from the user runtime directory.',
      'Provider routes must use stable profile IDs.',
      'Sleep is disabled on both inference nodes.',
      'The customer prefers email updates.',
    ].join('\n'),
  }];
  const result = explicitProjectKnowledge(records, ['t1']);
  assert.deepEqual(result.map((item) => item.statement), [
    'NNA hooks are discovered from the user runtime directory.',
    'Provider routes must use stable profile IDs.',
  ]);
  assert.deepEqual(result.map((item) => item.section), [
    'Verified environment', 'Current architecture',
  ]);
});

test('project-memory append proposals retain prior managed knowledge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-memory-append-'));
  await writeFile(join(root, 'NNA.md'), `${MANAGED_START}\n## Working conventions\n- Keep existing knowledge.\n${MANAGED_END}\n`);
  const proposal = await new ProjectMemoryReconciler(root).proposeAppend({
    evidenceRefs: ['evidence:decision'],
    sections: { 'Decisions and rationale': ['Use governed evidence.'] },
  });
  assert.match(proposal.new_region, /Keep existing knowledge\./u);
  assert.match(proposal.new_region, /Use governed evidence\./u);
});
