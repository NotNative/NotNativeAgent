// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ContractError } from './ids.js';

export class PathPolicy {
  constructor(workspaceRoot, options = {}) {
    this.inputRoot = resolve(workspaceRoot);
    this.root = null;
    this.boundedToWorkspace = options.boundedToWorkspace === true;
    this.gitRoot = null;
  }

  async initialize() {
    this.root = await realpath(this.inputRoot);
    this.gitRoot = await discoverGitRoot(this.root);
  }

  async resolveRead(input) {
    const candidate = this.#candidate(input);
    const canonical = await realpath(candidate);
    this.#assertAllowed(canonical);
    const info = await stat(canonical);
    if (!info.isFile()) throw new ContractError('tool_target_invalid', 'target is not a regular file');
    return Object.freeze({ path: canonical, size: info.size, exists: true, ...await this.#classification(canonical, true) });
  }

  async resolveDirectory(input = '.') {
    const candidate = this.#candidate(input);
    const canonical = await realpath(candidate);
    this.#assertAllowed(canonical);
    if (!(await stat(canonical)).isDirectory()) throw new ContractError('tool_target_invalid', 'target is not a directory');
    return Object.freeze({ path: canonical, exists: true, ...await this.#classification(canonical, true) });
  }

  async resolveWrite(input) {
    const candidate = this.#candidate(input);
    let canonical;
    let exists = true;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
      const parent = await realpath(dirname(candidate));
      canonical = join(parent, basename(candidate));
    }
    this.#assertAllowed(canonical);
    if (exists && !(await stat(canonical)).isFile()) {
      throw new ContractError('tool_target_invalid', 'target is not a regular file');
    }
    return Object.freeze({ path: canonical, exists, ...await this.#classification(canonical, exists) });
  }

  async resolveMetadata(input) {
    const candidate = this.#candidate(input);
    const canonical = await realpath(candidate);
    this.#assertAllowed(canonical);
    const info = await stat(canonical);
    return Object.freeze({
      path: canonical, exists: true, size: info.size,
      kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other',
      modifiedMs: info.mtimeMs, ...await this.#classification(canonical, true),
    });
  }

  async resolveNew(input) {
    const resolved = await this.resolveWrite(input);
    if (resolved.exists) throw new ContractError('tool_target_exists', 'destination already exists');
    return resolved;
  }

  async withRecovery(resolved) {
    let recovery = resolved.exists ? 'none' : 'new_target';
    if (resolved.exists && resolved.insideWorkspace && this.gitRoot && await gitTracks(this.gitRoot, resolved.path)) recovery = 'git_tracked';
    return Object.freeze({ ...resolved, recovery });
  }

  #candidate(input) {
    if (typeof input !== 'string' || input.length === 0 || input.length > 4096 || input.includes('\0')) {
      throw new ContractError('tool_path_invalid', 'path is invalid or exceeds bounds');
    }
    assertPortablePath(input);
    const candidate = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    this.#assertAllowed(candidate);
    return candidate;
  }

  #insideWorkspace(candidate) {
    const relation = relative(this.root, candidate);
    return !(relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation));
  }

  #assertAllowed(candidate) {
    if (this.boundedToWorkspace && !this.#insideWorkspace(candidate)) {
      throw new ContractError('tool_scope_denied', 'target is outside the approved workspace');
    }
  }

  async #classification(candidate, exists) {
    const insideWorkspace = this.#insideWorkspace(candidate);
    return { insideWorkspace, workspaceGitBacked: Boolean(this.gitRoot), recovery: exists ? 'none' : 'new_target' };
  }
}

const execFileAsync = promisify(execFile);

async function discoverGitRoot(root) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true, timeout: 2_000 });
    return await realpath(stdout.trim());
  } catch { return null; }
}

async function gitTracks(root, target) {
  try {
    await execFileAsync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', target], { windowsHide: true, timeout: 2_000 });
    return true;
  } catch { return false; }
}

function assertPortablePath(input) {
  if (input.startsWith('\\\\.\\') || input.startsWith('\\\\?\\')
    || input.startsWith('\\.\\') || input.startsWith('\\?\\')) {
    throw new ContractError('tool_path_reserved', 'device namespace paths are not permitted');
  }
  const segments = input.split(/[\\/]/u).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    if (index === 0 && /^[A-Za-z]:$/u.test(segment)) continue;
    if (segment === '.' || segment === '..') continue;
    if (/[\u0000-\u001f<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment)) {
      throw new ContractError('tool_path_reserved', 'path contains a non-portable reserved segment');
    }
    const stem = segment.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)) {
      throw new ContractError('tool_path_reserved', 'path contains a reserved device name');
    }
  }
}
