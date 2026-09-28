// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MANAGED_CHATS_OWNER, projectIdForPath, resolveMemoryOwnership } from '../project-context/agent-memory-ownership.ts';

const root = mkdtempSync(join(tmpdir(), 'nnd-memory-owner-'));
let checkout = '';

afterAll(() => rmSync(root, { recursive: true, force: true }));

function directory(name = 'repo'): string {
  checkout = isAbsolute(name) ? name : join(root, name);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'package.json'), '{}');
  return checkout;
}

describe('agent memory ownership', () => {
  it('uses only one authoritative input and prefers project records', () => {
    const value = directory('alpha');
    expect(resolveMemoryOwnership({ projectId: 'alpha' })).toBe('alpha');
    expect(resolveMemoryOwnership({ projectId: 'path_abc' })).toBe('path_abc');
    expect(resolveMemoryOwnership({ directory: value })).toBe(projectIdForPath(checkout));
    expect(() => resolveMemoryOwnership({ projectId: 'alpha', directory: value })).toThrow('not both');
    expect(() => resolveMemoryOwnership({})).toThrow('directory or projectID');
  });

  it('resolves worktrees to the project record, but never collides unregistered paths', () => {
    const primary = directory('primary');
    const registered = directory(join(primary, 'worktree'));
    expect(resolveMemoryOwnership({ directory: registered, projects: [{ id: 'alpha', worktree: primary }] }))
      .toBe('alpha');
    const unregistered = directory('worktree');
    expect(resolveMemoryOwnership({ directory: unregistered, projects: [{ id: 'alpha', worktree: primary }] }))
      .toBe(projectIdForPath(checkout));
  });

  it('maps chats under the managed root and rejects custom contains callbacks', () => {
    const chats = directory('chats');
    const value = directory(join(chats, 'session'));
    expect(resolveMemoryOwnership({ directory: value, managedChatsRoot: chats })).toBe(MANAGED_CHATS_OWNER);
    expect(() => resolveMemoryOwnership({
      directory: value,
      containsPath: () => true,
      projects: [{ id: 'phoenix', worktree: join(root, 'other') }],
    })).toThrow(/not supported/);
  });
});
