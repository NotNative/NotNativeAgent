// SPDX-License-Identifier: Apache-2.0
// Governance contract for the bounded fs_read default: the tool keeps its
// read_only/workspace declaration, so the deterministic reviewer still approves it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationWork } from '../src/conversation-work.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nna-read-governance-'));
  const ledger = new ReviewerLedger({ root });
  await ledger.initialize();
  const registry = new ToolRegistry(root, { boundedToWorkspace: true, conversationWork: new ConversationWork() });
  await registry.initialize();
  return {
    root, registry, ledger,
    async close() {
      await registry.close();
      await ledger.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('the bounded default read keeps deterministic safe classification', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, 'large.js'), Array.from({ length: 900 }, (_, i) => `line ${i}\n`).join(''));
    const definition = item.registry.definition('fs_read');
    assert.equal(definition.sideEffect, 'read_only');
    assert.equal(definition.scope, 'workspace');
    const reviewer = new MandatoryReviewer({ ledger: item.ledger });
    const authority = { id: 'authority-1', intent: [{ content: 'Read large.js', sequence: 1 }], mission: null };
    let index = 0;
    for (const args of [{ path: 'large.js' }, { path: 'large.js', start_line: 401 }]) {
      index += 1;
      const validated = await definition.validate(args);
      const result = await reviewer.review({
        ...validated, id: `read-${index}`, providerCallId: `call-${index}`, toolName: 'fs_read',
        authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
        caller: 'primary', expiresAt: Date.now() + 60_000,
      }, {
        authority, definition, surface: 'interactive_tui', reviewPosture: 'auto-review', justification: '',
      });
      assert.equal(result.outcome, 'approve', `${JSON.stringify(args)} must be approved without a model`);
      assert.equal(result.reasonCode, 'deterministic_safe');
    }
    // Posture still governs: prompt posture escalates even a safe read to the operator.
    const escalated = await reviewer.review({
      ...(await definition.validate({ path: 'large.js' })), id: 'read-prompt', providerCallId: 'call-prompt',
      toolName: 'fs_read', authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1,
      definitionVersion: 1, caller: 'primary', expiresAt: Date.now() + 60_000,
    }, { authority, definition, surface: 'interactive_tui', reviewPosture: 'prompt', justification: '' });
    assert.equal(escalated.outcome, 'escalate_to_operator');
  } finally { await item.close(); }
});
