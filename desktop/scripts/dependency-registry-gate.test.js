// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditDependencyRegistry } from './dependency-registry-gate.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'nnd-dependency-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs/architecture'), { recursive: true });
  await mkdir(join(root, 'packages/ui'), { recursive: true });
  await mkdir(join(root, 'packages/web'), { recursive: true });
  await writeFile(join(root, 'docs/architecture/dependency-registry.json'),
    JSON.stringify({ dependencies: [{ name: 'a' }, { name: 'b' }] }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }));
  await writeFile(join(root, 'packages/ui/package.json'), JSON.stringify({ dependencies: { b: '1' } }));
  await writeFile(join(root, 'packages/web/package.json'), JSON.stringify({ dependencies: {} }));
  return root;
}

test('registry audit compares all mandatory manifests', async (t) => {
  const root = await fixture(t);
  const errors = [];
  await auditDependencyRegistry(root, errors);
  assert.deepEqual(errors, []);
});

test('missing manifest reports the source failure without misleading registry entries', async (t) => {
  const root = await fixture(t);
  await rm(join(root, 'packages/web/package.json'));
  const errors = [];
  await auditDependencyRegistry(root, errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dependency manifest packages\/web\/package\.json could not be read or parsed/u);
});

test('malformed manifest cannot silently shrink the declared dependency set', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'packages/ui/package.json'), '{');
  const errors = [];
  await auditDependencyRegistry(root, errors);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dependency manifest packages\/ui\/package\.json could not be read or parsed/u);
});

test('manifest with non-object dependencies fails before comparison', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'packages/ui/package.json'), JSON.stringify({ dependencies: [] }));
  const errors = [];
  await auditDependencyRegistry(root, errors);
  assert.deepEqual(errors, ['dependency manifest packages/ui/package.json has an invalid dependencies object']);
});

test('missing registry list reports an invalid inventory', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'docs/architecture/dependency-registry.json'), '{}');
  const errors = [];
  await auditDependencyRegistry(root, errors);
  assert.deepEqual(errors, ['dependency registry docs/architecture/dependency-registry.json has an invalid dependencies list']);
});
