// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { NativeSkillsFailure, parseNativeSkillsCatalog } from '../skills.ts';

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  id, version: '1', description: `demo ${id}`, invocation: 'both',
  source: 'bundled:demo', requires_tools: [], body_sha256: 'a'.repeat(64), ...extra });
const diagnostic = { status: 'skipped', scope: 'user', path: 'C:\\nna\\skills\\broken.md',
  code: 'skill_duplicate', message: 'duplicate skill demo.one' };
const receipt = (overrides: Record<string, unknown> = {}) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1',
  scope: 'workspace', scope_root: 'C:\\workspace', trusted: true,
  catalog: [entry('demo.one'), entry('demo.two', { invocation: 'agent' })],
  diagnostics: [diagnostic], ...overrides });
const parse = () => parseNativeSkillsCatalog(receipt());

describe('native skills catalog parser', () => {
  it('accepts the route projection and refuses drift', () => {
    const parsed = parse();
    expect(parsed.catalog.length).toBe(2);
    expect(parsed.catalog[0]?.body_sha256).toBe('a'.repeat(64));
    expect(parsed.diagnostics[0]?.scope).toBe('user');
    for (const drift of [
      receipt({ trusted: 'yes' }),
      receipt({ catalog: [{ ...entry('demo.one'), body_sha256: 'nothex' }] }),
      receipt({ catalog: [{ ...entry('demo.one'), invocation: 'system' }] }),
      receipt({ catalog: [{ ...entry('demo.one'), source: 'workspace:demo' }] }),
      receipt({ catalog: [{ ...entry('demo.one'), extra: 1 }] }),
      receipt({ diagnostics: [{ ...diagnostic, status: 'loaded' }] }),
      receipt({ scope: 'user' }),
      receipt({ schema_version: '2.0' }),
    ]) {
      expect(() => parseNativeSkillsCatalog(drift)).toThrow(NativeSkillsFailure);
    }
  });
});
