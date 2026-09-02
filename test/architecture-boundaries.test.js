// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

const sourceRoot = resolve('src');

test('production modules use real relative targets without forwarding-only files', async () => {
  const files = await sourceFiles(sourceRoot);
  const forwarding = [];
  for (const file of files) {
    const source = (await readFile(file, 'utf8')).replace(/^\s*\/\/[^\n]*$/gmu, '').trim();
    // Why: a single forwarding export only preserves a moved path; callers should use its owner.
    if (/^export\s+(?:\*|\{[^}]*\})\s+from\s+['"][^'"]+['"];?$/u.test(source)) {
      forwarding.push(relative(sourceRoot, file).replaceAll('\\', '/'));
    }
    for (const target of await relativeTargets(file)) {
      await assert.doesNotReject(access(target), `${relative(sourceRoot, file)} imports missing ${target}`);
    }
  }
  assert.deepEqual(forwarding, []);
});

test('engine and surface dependency directions remain explicit', async () => {
  const files = await sourceFiles(sourceRoot);
  const violations = [];
  for (const file of files) {
    const owner = ownerOf(relative(sourceRoot, file).replaceAll('\\', '/'));
    const targets = await relativeTargets(file);
    for (const target of targets) {
      const targetOwner = ownerOf(relative(sourceRoot, target).replaceAll('\\', '/'));
      if (forbidden(owner, targetOwner)) {
        violations.push(`${relative(sourceRoot, file)} -> ${relative(sourceRoot, target)}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

async function sourceFiles(root) {
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      const path = resolve(entry.parentPath, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.endsWith('.js')) files.push(path);
    }
  }
  return files;
}

async function relativeTargets(file) {
  const source = await readFile(file, 'utf8');
  return [...source.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/gu)]
    .map((match) => match[1])
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => resolve(dirname(file), specifier));
}

function ownerOf(path) {
  if (path === 'engine.js' || path.startsWith('engine/')) return 'engine';
  if (path === 'reliability-engine.js' || path.startsWith('reliability/')) return 'reliability';
  if (path === 'governance-engine.js' || path.startsWith('governance/')) return 'governance';
  if (path === 'experience-engine.js' || path.startsWith('experience/')) return 'experience';
  if (path === 'tui.js' || path.startsWith('tui/')) return 'tui';
  if (path === 'gateway-cli.js') return 'gateway-control';
  if (path.startsWith('gateway/')) return 'gateway';
  return 'shared';
}

function forbidden(owner, targetOwner) {
  if (owner === 'engine' || owner === 'governance') return targetOwner === 'tui' || targetOwner === 'gateway';
  if (owner === 'reliability') {
    return ['engine', 'governance', 'experience', 'tui', 'gateway'].includes(targetOwner);
  }
  if (owner === 'experience') return targetOwner === 'tui' || targetOwner === 'gateway';
  if (owner === 'tui') return targetOwner === 'gateway';
  if (owner === 'gateway') return targetOwner === 'tui';
  return false;
}
