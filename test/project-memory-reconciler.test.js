// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MANAGED_END, MANAGED_START, ProjectMemoryReconciler, projectMemoryCandidate,
} from '../src/project-memory-reconciler.js';

test('project-memory proposals preserve user content and replace only the managed region', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-memory-'));
  const before = `# User notes\nKeep this exactly.\n\n${MANAGED_START}\n## Known problems\n- Old issue\n${MANAGED_END}\n\nFooter.\n`;
  await writeFile(join(root, 'NNA.md'), before);
  const reconciler = new ProjectMemoryReconciler(root);
  const proposal = await reconciler.propose({
    evidenceRefs: ['evidence:verified'], sections: {
      'Decisions and rationale': ['Use the governance ledger for causal decisions.'],
      'Working conventions': ['Run the complete test suite before promotion.'],
    },
  });
  assert.equal(proposal.exists, true);
  assert.ok(proposal.expected_hash);
  assert.ok(proposal.content.startsWith('# User notes\nKeep this exactly.\n\n'));
  assert.ok(proposal.content.endsWith('\n\nFooter.\n'));
  assert.equal(proposal.content.includes('Old issue'), false);
  assert.equal(await readFile(join(root, 'NNA.md'), 'utf8'), before);
  const candidate = projectMemoryCandidate(proposal);
  assert.equal(candidate.kind, 'guidance.project_memory');
  assert.equal(candidate.payload.expected_hash, proposal.expected_hash);
});

test('project-memory proposals are exact for new files and reject malformed or secret content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-memory-new-'));
  const reconciler = new ProjectMemoryReconciler(root);
  const proposal = await reconciler.propose({
    evidenceRefs: ['evidence:user-decision'],
    sections: { 'Current architecture': ['Governance separates action authority from claim support.'] },
  });
  assert.equal(proposal.exists, false);
  assert.equal(proposal.expected_hash, null);
  assert.ok(proposal.content.startsWith(MANAGED_START));
  assert.ok(proposal.content.endsWith(`${MANAGED_END}\n`));
  await writeFile(join(root, 'NNA.md'), `${MANAGED_START}\nmissing end`);
  await assert.rejects(() => reconciler.propose({
    evidenceRefs: ['evidence:user-decision'], sections: { 'Known problems': ['A real issue.'] },
  }), { code: 'project_memory_markers_invalid' });
  await writeFile(join(root, 'NNA.md'), '');
  await assert.rejects(() => reconciler.propose({
    evidenceRefs: ['evidence:user-decision'], sections: { 'Verified environment': ['api_key: definitely-not-memory'] },
  }), { code: 'project_memory_secret_forbidden' });
});
