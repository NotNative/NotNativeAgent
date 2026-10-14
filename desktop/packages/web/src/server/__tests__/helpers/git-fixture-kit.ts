// SPDX-License-Identifier: Apache-2.0
/**
 * Shared Git test fixtures built ONCE per file and reused via cheap directory
 * copies. Why: per-test `git init`/`push`/`clone` fixture setup dominated the
 * timing audit for the sync/walkthrough/skill-scan suites; a template repo is
 * built once and each test gets an isolated `cpSync` copy, preserving the
 * per-test isolation the old per-test construction provided. Scratch roots go
 * through desktop/scripts/test-scratch.mjs so cleanup stays centralized
 * (operator cleanup policy 2026-10-11); the .mjs helper is loaded dynamically
 * because the TypeScript server config does not typecheck plain-JS imports.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratchModule = (await import(
  pathToFileURL(join(
    dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', 'scripts', 'test-scratch.mjs',
  )).href
)) as {
  createScratchSync: (prefix: string) => string;
  reserveScratch: (prefix: string) => string;
};
const { createScratchSync, reserveScratch } = scratchModule;

export function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', windowsHide: true,
  }).trim();
}

export interface SyncTemplate {
  root: string; local: string; remote: string; peer: string;
}

/** Build one template local repo + bare remote (+ peer clone) once. */
export function buildSyncTemplate(): SyncTemplate {
  const root = createScratchSync('nnd-git-sync-template');
  const local = join(root, 'local');
  const remote = join(root, 'remote.git');
  const peer = join(root, 'peer');
  execFileSync('git', ['init', '-q', '-b', 'main', local], { windowsHide: true });
  git(local, 'config', 'user.name', 'NND Test');
  git(local, 'config', 'user.email', 'nnd@example.test');
  writeFileSync(join(local, 'base.txt'), 'base\n');
  git(local, 'add', '-A');
  git(local, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base');
  execFileSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], { windowsHide: true });
  execFileSync('git', ['clone', '-q', remote, peer], { windowsHide: true });
  git(peer, 'config', 'user.name', 'NND Peer');
  git(peer, 'config', 'user.email', 'peer@example.test');
  return { root, local, remote, peer };
}

/** Fresh per-test copy of the sync template (fs copy is far cheaper than the
 *  git init/push/clone chain and keeps tests mutually isolated). */
export function copySyncFixture(template: SyncTemplate): {
  root: string; local: string; remote: string; peer: string;
} {
  const root = reserveScratch('nnd-git-sync-case');
  mkdirSync(root, { recursive: true });
  for (const name of ['local', 'remote.git', 'peer'] as const) {
    cpSync(join(template.root, name), join(root, name), { recursive: true });
  }
  const local = join(root, 'local');
  const remote = join(root, 'remote.git');
  const peer = join(root, 'peer');
  // Copied clones still carry the template remote URL; re-point them so pushes
  // land on this test's own copied remote, not the shared template.
  git(local, 'remote', 'set-url', 'origin', remote);
  git(peer, 'remote', 'set-url', 'origin', remote);
  return { root, local, remote, peer };
}

/** One plain committed template repo for walkthrough fixtures. */
export function buildWalkthroughTemplate(): { repo: string } {
  const root = createScratchSync('nnd-walkthrough-template');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'both.txt'), 'old\n');
  writeFileSync(join(repo, 'rename.txt'), 'rename old\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  return { repo };
}

/** Fresh per-test copy of the walkthrough template repo. */
export function copyWalkthroughRepo(template: { repo: string }): string {
  const root = reserveScratch('nnd-walkthrough-case');
  mkdirSync(root, { recursive: true });
  cpSync(template.repo, join(root, 'repo'), { recursive: true });
  return join(root, 'repo');
}

/** One committed catalog-source template repo for skill-scan fixtures. */
export function buildCatalogTemplate(): string {
  const root = createScratchSync('nnd-p10-catalog-template');
  const repository = join(root, 'repository');
  const valid = join(repository, 'skills', 'source-good');
  const invalid = join(repository, 'skills', 'Invalid Name');
  mkdirSync(valid, { recursive: true });
  mkdirSync(invalid, { recursive: true });
  writeFileSync(join(valid, 'SKILL.md'),
    '---\nname: source-good\ndescription: Repository source skill\n---\nReady.');
  writeFileSync(join(invalid, 'SKILL.md'),
    '---\ndescription: Invalid but still visible\n---\nInspect.');
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'catalog@nnd.test'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['config', 'user.name', 'NND Catalog'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['add', '-A'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-q', '-m', 'catalog source'], { cwd: repository, stdio: 'ignore', windowsHide: true });
  return repository;
}

/** Fresh per-test copy of the catalog template (the cache test amends its
 *  copy's history, so sharing the template directly would leak mutations). */
export function copyCatalogRepository(template: string): string {
  const root = reserveScratch('nnd-p10-catalog-case');
  mkdirSync(root, { recursive: true });
  cpSync(template, join(root, 'repository'), { recursive: true });
  return join(root, 'repository');
}
