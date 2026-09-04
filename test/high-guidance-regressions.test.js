// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfiguration } from '../src/configuration-sources.js';
import { diagnoseDreamEvidence } from '../src/dream-diagnosis.js';
import { GuidanceCatalog } from '../src/guidance/catalog.js';

const provider = { endpoint: 'http://localhost:8000/v1', model: 'fixture', trust_zone: 'loopback' };

test('source structures are bounded before recursive merging or cloning arrays', () => {
  const circular = []; circular.push(circular);
  assert.throws(() => resolveConfiguration([{ name: 'test', manifest: { provider, unused: circular } }]), { code: 'configuration_cycle' });
  let deep = {}; for (let i = 0; i < 100; i += 1) deep = { child: deep };
  assert.throws(() => resolveConfiguration([{ name: 'test', manifest: { provider, unused: deep } }]), { code: 'configuration_depth' });
  assert.throws(() => resolveConfiguration([{ name: 'test', manifest: { provider, unused: Array.from({ length: 5000 }, () => ({})) } }]),
    { code: 'configuration_size' });
});

test('replaced configuration subtree does not retain obsolete source attribution', () => {
  const result = resolveConfiguration([{ name: 'old', manifest: { provider, memory: { max_items: 1 } } },
    { name: 'new', manifest: { memory: null } }]);
  assert.notEqual(result.provenance['memory.max_items'], 'old');
  const dropped = resolveConfiguration([{ name: 'source', manifest: { provider, future_hint: 'unused' } }]);
  assert.equal(Object.hasOwn(dropped.provenance, 'future_hint'), false);
});

test('malformed dream evidence is visible and repeated reasons count distinct failed turns', () => {
  assert.equal(diagnoseDreamEvidence([null, {}, { turn_id: '', status: 'failed' }]).status, 'attention');
  assert.equal(diagnoseDreamEvidence([]).status, 'clean');
  const rows = Array.from({ length: 3 }, () => ({ turn_id: 'same', status: 'failed', reason_code: 'disk' }));
  assert.equal(diagnoseDreamEvidence(rows).issues.some((item) => item.code === 'repeated_reason'), false);
  assert.equal(diagnoseDreamEvidence(rows.map((row, i) => ({ ...row, turn_id: String(i), status: 'succeeded' }))).status, 'clean');
  assert.equal(diagnoseDreamEvidence(rows.map((row, i) => ({ ...row, turn_id: String(i) }))).issues
    .find((item) => item.code === 'repeated_reason').count, 3);
});

test('guidance capacity counts accepted documents rather than oversized candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-catalog-count-'));
  try {
    await writeFile(join(root, '000-big.md'), 'x'.repeat(262145));
    for (let i = 1; i <= 64; i += 1) await writeFile(join(root, `${String(i).padStart(3, '0')}.md`), 'guidance');
    const catalog = new GuidanceCatalog(root); await catalog.initialize();
    assert.equal(catalog.documents.size, 64); assert.equal(catalog.read('064').content, 'guidance');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('guidance ranking remains unique-term-based rather than rewarding repeated wording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-catalog-rank-'));
  try {
    await writeFile(join(root, 'a.md'), 'needle'); await writeFile(join(root, 'b.md'), 'needle '.repeat(50));
    const catalog = new GuidanceCatalog(root); await catalog.initialize();
    const results = catalog.search('needle'); assert.equal(results[0].score, results[1].score);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project guidance bounds actual reads when metadata understates the file size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-guidance-growth-'));
  try {
    await writeFile(join(root, 'AGENTS.md'), 'x'.repeat(65537));
    const module = new URL('../src/guidance/project.js', import.meta.url).href;
    const code = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module'; const original = fs.lstat; fs.lstat = async (...args) => { const stats = await original(...args); stats.size = 1; return stats; }; syncBuiltinESMExports(); const { ProjectGuidance } = await import(${JSON.stringify(module)}); const result = await new ProjectGuidance(${JSON.stringify(root)}).resolve(); process.stdout.write(JSON.stringify(result));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
