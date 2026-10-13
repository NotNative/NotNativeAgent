// SPDX-License-Identifier: Apache-2.0
/**
 * Worktree bootstrap seam (docs 06 worktree domain and 12 §F.1): creates the
 * linked worktree, optionally points the new branch at an upstream ref, and
 * treats git readiness as the population gate before any session exists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { ENV } from '../env.ts';
import { isGitRepository } from '../routes/git.ts';
import type { CreatedWorktree, WorktreeRequest } from './session-orchestration-contract.ts';

const GIT_TIMEOUT_MS = 30_000;

export class WorktreeCreatedError extends Error {
  constructor(message: string, readonly created: CreatedWorktree) {
    super(message);
    this.name = 'WorktreeCreatedError';
  }
}

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', windowsHide: true });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? 'git failed' };
  }
}

export function createSessionWorktree(directory: string, request: WorktreeRequest): Promise<CreatedWorktree> {
  const branchName = (request.branchName ?? '').trim();
  if (branchName === '') {
    return Promise.reject(new Error('branchName is required'));
  }
  if (!isGitRepository(directory)) {
    return Promise.reject(new Error('directory must be a git repository'));
  }
  const branchCheck = git(['check-ref-format', '--branch', branchName], directory);
  if (branchCheck.status !== 0) {
    return Promise.reject(new Error(branchCheck.stderr.trim() || 'branchName is invalid'));
  }
  const name = (request.name ?? branchName)
    .replace(/[^a-zA-Z0-9._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
    .slice(0, 60);
  if (name === '') return Promise.reject(new Error('worktree name is invalid'));
  const worktreePath = joinPath(ENV.dataDir, 'git-worktrees', slug(directory), name);
  if (request.setUpstream === true && request.startRef !== undefined) {
    const remote = request.startRef.split('/')[0]!;
    if (request.startRef.includes('/')) {
      const fetched = git(['fetch', remote, '--quiet'], directory);
      if (fetched.status !== 0) return Promise.reject(new Error(fetched.stderr.trim() || 'git fetch failed'));
    }
  } else if (request.setUpstream === true) {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], directory);
    if (upstream.status !== 0) {
      return Promise.reject(new Error(upstream.stderr.trim() || 'the source branch has no upstream to track'));
    }
  }
  if (request.startRef !== undefined && request.startRef.trimStart().startsWith('-')) {
    return Promise.reject(new Error('worktree.startRef is invalid'));
  }
  const args = ['worktree', 'add', '-b', branchName, worktreePath];
  if (request.startRef !== undefined) args.push(request.startRef);
  const created = git(args, directory);
  if (created.status !== 0) {
    return Promise.reject(new Error(created.stderr.trim() || 'git worktree add failed'));
  }
  if (request.setUpstream === true) {
    const upstream = request.startRef
      ?? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], directory).stdout.trim();
    if (upstream !== '') {
      const tracking = git(['branch', '--set-upstream-to', upstream, branchName], worktreePath);
      if (tracking.status !== 0) {
        throw new WorktreeCreatedError(
          tracking.stderr.trim() || 'git branch tracking failed',
          { directory: worktreePath, branch: branchName },
        );
      }
    }
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  return Promise.resolve({
    directory: worktreePath,
    branch: branch.status === 0 ? branch.stdout.trim() || branchName : branchName,
  });
}

function slug(directory: string): string {
  const last = directory.split(/[\\/]+/u).filter(Boolean).at(-1) ?? 'project';
  return last.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 60) || 'project';
}

export function waitForWorktree(directory: string, timeoutMs: number = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (existsSync(directory) && isGitRepository(directory)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 150).unref?.();
    };
    tick();
  });
}
