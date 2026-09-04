// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { loadTabPool } from '../src/experience/tab-pool.js';
import { restorePresentation } from '../src/experience/presentation.js';

function configuration(root) {
  return resolveManifest({
    persistence: 'durable', workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'model', trust_zone: 'loopback' },
  });
}

test('presentation restore rejects unknown review postures before mutating policy', () => {
  const session = {
    editor: { text: '', set(value) { this.text = value; } }, reviewPosture: 'auto-review',
  };
  const engine = { reviewPosture: 'auto-review' };
  assert.throws(() => restorePresentation(session, engine, {
    draft: '', expanded_turn_ids: [], pending_attachments: [], review_posture: 'anything',
  }), { code: 'presentation_state_invalid' });
  assert.equal(session.reviewPosture, 'auto-review');
  assert.equal(engine.reviewPosture, 'auto-review');
});

test('legacy tab-pool migrations reject missing tab arrays with a stable contract error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-migration-'));
  const path = join(root, 'pool.json');
  await writeFile(path, JSON.stringify({ schema_version: 2 }), 'utf8');
  await assert.rejects(loadTabPool(path), { code: 'tab_pool_invalid' });
});

test('legacy custom tab names migrate as locked while generated names remain eligible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-name-migration-'));
  const path = join(root, 'pool.json');
  const presentation = {
    draft: '', viewport_end: null, expanded_turn_ids: [], review_posture: 'auto-review',
    pending_attachments: [], work_collapsed: false,
  };
  const manifest = {
    version: 1, persistence: 'durable', workspace_root: root,
    providers: [{ id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'model', trust_zone: 'loopback' }],
  };
  await writeFile(path, JSON.stringify({
    schema_version: 4, saved_at: new Date().toISOString(), active_session_id: 'custom',
    tabs: [
      { session_id: 'custom', name: 'My Chosen Name', role: 'standard', main: false, meaningful: true, manifest, presentation, console_id: null },
      { session_id: 'generated', name: 'Previous Main', role: 'standard', main: false, meaningful: true, manifest, presentation, console_id: null },
    ],
  }), 'utf8');
  const migrated = await loadTabPool(path);
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.tabs[0].name_locked, true);
  assert.equal(migrated.tabs[1].name_locked, false);
  assert.equal(migrated.tabs.every((tab) => tab.auto_named === false), true);
});

test('durable tab pool restores conversation presentation but opens with fresh Main focused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-state-'));
  const options = {
    config: configuration(root), tabPoolPath: join(root, 'pool.json'), configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
  };
  const first = new InteractiveWorkspace(options);
  await first.restore();
  const other = await first.create('Investigation', 'investigation');
  await first.submitActive('make this tab meaningful');
  const projected = first.projection.active();
  projected.editor.set('unfinished draft\nsecond line');
  projected.viewportEnd = 0;
  projected.expandedTurns.add('turn-example');
  projected.detailedTurns.add('turn-example');
  projected.workCollapsed = true;
  projected.pendingAttachments.push(Object.freeze({
    path: join(root, 'pending.png'), mime_type: 'image/png', size: 8,
  }));
  first.cycleReviewPosture();
  await first.shutdown();

  const second = new InteractiveWorkspace(options);
  const main = await second.restore();
  assert.notEqual(main, other);
  assert.equal(second.projection.activeId, main);
  assert.equal(second.projection.sessions.get(main).role, 'primary');
  const restored = second.projection.sessions.get(other);
  assert.equal(restored.editor.text, 'unfinished draft\nsecond line');
  assert.equal(restored.viewportEnd, 0);
  assert.deepEqual([...restored.expandedTurns], ['turn-example']);
  assert.deepEqual([...restored.detailedTurns], ['turn-example']);
  assert.equal(restored.workCollapsed, true);
  assert.equal(restored.reviewPosture, 'unattended');
  assert.equal(restored.pendingAttachments[0].mime_type, 'image/png');
  assert.equal(second.sessions.get(other).engine.reviewPosture, 'unattended');
  await second.shutdown();
});

test('completed topical turns receive a durable automatic name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-auto-title-'));
  const tabPoolPath = join(root, 'pool.json');
  const options = {
    config: configuration(root), tabPoolPath, configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
  };
  const first = new InteractiveWorkspace(options);
  const original = await first.restore();
  await first.submitActive('Please diagnose the Telegram gateway logs for me.');
  assert.equal(first.sessions.get(original).name, 'Telegram Gateway Logs');
  const saved = JSON.parse(await readFile(tabPoolPath, 'utf8'));
  assert.equal(saved.schema_version, 5);
  assert.equal(saved.tabs.find((tab) => tab.session_id === original).auto_named, true);
  assert.equal(saved.tabs.find((tab) => tab.session_id === original).name_locked, false);
  await first.shutdown();

  const second = new InteractiveWorkspace(options);
  await second.restore();
  assert.equal(second.sessions.get(original).name, 'Telegram Gateway Logs');
  assert.equal(second.sessions.get(original).autoNamed, true);
  await second.shutdown();
});

test('an explicit rename locks the durable name against automatic replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-title-lock-'));
  const tabPoolPath = join(root, 'pool.json');
  const options = {
    config: configuration(root), tabPoolPath, configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
  };
  const first = new InteractiveWorkspace(options);
  const original = await first.restore();
  first.renameActive('My Gateway Work');
  await first.submitActive('Please diagnose the Telegram gateway logs for me.');
  assert.equal(first.sessions.get(original).name, 'My Gateway Work');
  assert.equal(first.sessions.get(original).nameLocked, true);
  await first.shutdown();

  const second = new InteractiveWorkspace(options);
  await second.restore();
  assert.equal(second.sessions.get(original).name, 'My Gateway Work');
  assert.equal(second.sessions.get(original).nameLocked, true);
  await second.shutdown();
});

test('concurrent Consoles isolate live writers and merge both Main sessions back into the pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-concurrent-'));
  const options = {
    config: configuration(root), tabPoolPath: join(root, 'pool.json'), configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
  };
  const first = new InteractiveWorkspace(options);
  const firstMain = await first.restore();
  await first.submitActive('first terminal');
  const second = new InteractiveWorkspace(options);
  const secondMain = await second.restore();
  assert.equal(first.projection.sessions.get(firstMain).role, 'primary');
  assert.equal(second.projection.sessions.get(secondMain).role, 'standard');
  assert.equal(second.sessions.size, 1, 'a live session owned by another Console is not attached twice');
  assert.deepEqual(second.restoreFailures, []);
  await second.submitActive('second terminal');
  assert.deepEqual(await second.closeActive(), { protected: true });
  await first.shutdown();
  await second.shutdown();

  const later = new InteractiveWorkspace(options);
  const laterMain = await later.restore();
  assert.equal(later.projection.sessions.get(laterMain).role, 'primary');
  assert.equal(later.sessions.size, 3);
  assert.equal([...later.sessions.values()].filter((session) => session.name === 'Previous Main').length, 2);
  await later.shutdown();
});

test('a corrupt saved tab pool opens recoverable Main and preserves the original evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-corrupt-'));
  const tabPoolPath = join(root, 'pool.json');
  const corrupt = '{ this is not valid JSON';
  await writeFile(tabPoolPath, corrupt, 'utf8');
  const workspace = new InteractiveWorkspace({
    config: configuration(root), tabPoolPath, configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });

  const main = await workspace.restore();
  assert.equal(workspace.projection.sessions.get(main).role, 'primary');
  assert.equal(workspace.restoreFailures.length, 1);
  assert.equal(workspace.restoreFailures[0].code, 'tab_pool_invalid');
  assert.match(workspace.projection.sessions.get(main).records.at(-1).text, /Saved data was left untouched/u);
  await workspace.shutdown();
  assert.equal(await readFile(tabPoolPath, 'utf8'), corrupt);
});

test('a tab pool write failure is recoverable and does not falsify the engine state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-write-recovery-'));
  let failNext = false;
  let writes = 0;
  const workspace = new InteractiveWorkspace({
    config: configuration(root), tabPoolPath: join(root, 'pool.json'), configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }),
    tabPoolWriter: async () => {
      writes += 1;
      if (failNext) {
        failNext = false;
        const error = new Error('simulated storage interruption');
        error.code = 'tab_pool_unavailable';
        throw error;
      }
    },
  });

  await workspace.restore();
  failNext = true;
  await workspace.submitActive('continue despite presentation storage trouble');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(workspace.projection.active().state, 'idle');
  assert.equal(workspace.projection.notice.kind, 'persistence');
  assert.match(workspace.projection.notice.text, /retry on the next change/u);
  const writesAfterFailure = writes;

  workspace.renameActive('Recovered');
  await workspace.shutdown();
  assert.ok(writes > writesAfterFailure, 'a later tab-pool write must run after the failed write');
});

test('workspace shutdown attempts every engine and surfaces the first cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-shutdown-'));
  const workspace = new InteractiveWorkspace({
    config: configuration(root), tabPoolPath: join(root, 'pool.json'), configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await workspace.restore();
  const other = await workspace.create('Other', 'other');
  let otherClosed = false;
  const failure = Object.assign(new Error('simulated engine cleanup failure'), { code: 'engine_close_failed' });
  const closeMain = workspace.sessions.get(main).engine.shutdown.bind(workspace.sessions.get(main).engine);
  const closeOther = workspace.sessions.get(other).engine.shutdown.bind(workspace.sessions.get(other).engine);
  workspace.sessions.get(main).engine.shutdown = async (...args) => { await closeMain(...args); throw failure; };
  workspace.sessions.get(other).engine.shutdown = async (...args) => { await closeOther(...args); otherClosed = true; };

  await assert.rejects(workspace.shutdown(), failure);
  assert.equal(otherClosed, true);
});

test('a failed tab save does not misreport a successfully created conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-tab-create-recovery-'));
  let failNext = false;
  const workspace = new InteractiveWorkspace({
    config: configuration(root), tabPoolPath: join(root, 'pool.json'), configPath: join(root, 'settings.json'),
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
    tabPoolWriter: async () => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('simulated pool failure'), { code: 'tab_pool_unavailable' });
      }
    },
  });
  await workspace.restore();
  failNext = true;
  const created = await workspace.create('Survives storage interruption', 'created-tab');

  assert.equal(created, 'created-tab');
  assert.equal(workspace.sessions.has(created), true);
  assert.equal(workspace.projection.active().state, 'idle');
  assert.equal(workspace.projection.notice.kind, 'persistence');
  await workspace.shutdown();
});
