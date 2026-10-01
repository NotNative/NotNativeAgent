// SPDX-License-Identifier: Apache-2.0
/**
 * Registry gates (doc 14 §F.1/§F.4/§F.6): the checked-in snapshot copy must
 * be FRESH (the regenerate gate), scopes/flags must be coherent, and the
 * parse document enforces "invalid == absent" with no default injection.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS_REGISTRY, REGISTRY_SNAPSHOT_VERSION, autoSaveKeys, getSettingsField } from '../registry.ts';
import { parseSettingsDocument } from '../parse.ts';

const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = resolve(here, '../../../../../web/src/server/lib/settings-registry.json');
const renderScript = resolve(here, '../../../../../../scripts/registry-render.mjs');

describe('settings registry (doc 14 §F.1/§F.4)', () => {
  it('drops legacy NND permission auto-accept settings', () => {
    expect(getSettingsField('permissionAutoAccept')).toBeNull();
    expect(parseSettingsDocument({ permissionAutoAccept: { sessions: { s1: true }, revision: 2 } })).toEqual({});
  });
  it('checked-in snapshot equals a fresh render (stale = regenerate gate)', async () => {
    const { renderSnapshot } = await import(renderScript);
    const committed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as {
      version: number; fields: Record<string, Record<string, unknown>>;
    };
    expect(committed.version).toBe(REGISTRY_SNAPSHOT_VERSION);
    expect(committed.fields).toEqual(renderSnapshot(SETTINGS_REGISTRY, REGISTRY_SNAPSHOT_VERSION).fields);
    expect(Object.keys(committed.fields).length).toBe(SETTINGS_REGISTRY.length);
  });

  it('keys are unique and flags are coherent', () => {
    const keys = new Set(SETTINGS_REGISTRY.map((field) => field.key));
    expect(keys.size).toBe(SETTINGS_REGISTRY.length);
    const saves = new Set(autoSaveKeys());
    for (const field of SETTINGS_REGISTRY) {
      if (field.local) expect(field.scope).toBe('device');
      if (field.computed || field.secret || field.owner || field.local) {
        expect(saves.has(field.key), `${field.key} must not auto-save`).toBe(false);
      }
      if (field.perSurface) expect(['profile', 'instance']).toContain(field.scope);
    }
  });

  it('carries the doc-14 §F.5 inventory (spot keys + volume)', () => {
    const keys = new Set(SETTINGS_REGISTRY.map((field) => field.key));
    for (const key of ['themeVariant', 'lightThemeId', 'chatRenderMode', 'fontSize', 'defaultModel',
      'favoriteModels', 'sessionGoalDefaultBudget', 'notificationTemplates', 'globalBehaviorPrompt',
      'pwaAppName', 'mobileKeyboardMode', 'alwaysShowScrollbars', 'desktopSplashColors']) {
      expect(keys.has(key), `${key} registered`).toBe(true);
    }
    expect(SETTINGS_REGISTRY.length).toBeGreaterThanOrEqual(150);
  });

  it('defines auto-saves only on bindable store keys (§F.3)', () => {
    const saves = autoSaveKeys();
    expect(saves.length).toBeGreaterThan(20);
    expect(saves).toContain('fontSize');
    expect(saves).toContain('chatRenderMode');
    expect(saves).not.toContain('favoriteModels'); // 1200 ms cadence owner lands later
  });
});

describe('parseSettingsDocument (§F.3: invalid == absent)', () => {
  it('parses valid values, drops unknown and invalid keys silently', () => {
    const doc = parseSettingsDocument({
      chatRenderMode: 'sorted',
      fontSize: 125,
      inputHistoryLimit: '40',
      notInRegistry: 'x',
      workStatusHiddenSections: ['tasks', 'tasks', 'git'],
    });
    expect(doc.chatRenderMode).toBe('sorted');
    expect(doc.fontSize).toBe(125);
    expect(doc.inputHistoryLimit).toBeUndefined();
    expect(doc.notInRegistry).toBeUndefined();
    expect(doc.workStatusHiddenSections).toEqual(['tasks', 'git']);
  });

  it('collects derived for adoption; never injects defaults ("missing is not default")', () => {
    expect(parseSettingsDocument({})).toEqual({});
    expect(parseSettingsDocument({ themeVariant: 'light' }).themeVariant).toBe('light'); // sent-only but readable (P0-1 review fix)
  });

  it('enforces the documented parse constraints per key', () => {
    const kept = (patch: Record<string, unknown>): string[] =>
      Object.keys(parseSettingsDocument(patch)).filter((key) => key in patch);
    expect(kept({ inputHistoryLimit: 0 })).not.toContain('inputHistoryLimit'); // 1..100
    expect(kept({ inputHistoryLimit: 100 })).toContain('inputHistoryLimit');
    expect(kept({ autoDeleteAfterDays: 366 })).not.toContain('autoDeleteAfterDays');
    expect(kept({ hiddenModels: Array.from({ length: 1100 }, (_, i) => `p/${i}`) })).not.toContain('hiddenModels'); // cap 1024
    expect(kept({ sessionGoalDefaultBudget: 999 })).not.toContain('sessionGoalDefaultBudget');
    expect(kept({ chatRenderMode: 'chaos' })).not.toContain('chatRenderMode');
    expect(kept({ pwaAppName: 'x'.repeat(65) })).not.toContain('pwaAppName'); // ≤64
    expect(kept({ globalBehaviorPrompt: 'prompt' })).toContain('globalBehaviorPrompt');
  });

  it('rejects duplicate Git identities and preserves spaced SSH key paths', () => {
    const kept = (patch: Record<string, unknown>): string[] =>
      Object.keys(parseSettingsDocument(patch)).filter((key) => key in patch);
    const profile = { id: 'work-key', name: 'Work', sshKeyPath: 'C:/Users/Tester/.ssh/work key' };
    expect(kept({ gitIdentityProfiles: [profile] })).toContain('gitIdentityProfiles');
    expect(kept({ gitIdentityProfiles: [profile, profile] })).not.toContain('gitIdentityProfiles');
    expect(kept({ gitIdentityProfiles: [{ ...profile, sshKeyPath: 'relative/key' }] }))
      .not.toContain('gitIdentityProfiles');
  });

  it('exposes field lookup used by the engine', () => {
    expect(getSettingsField('fontSize')?.perSurface).toBe(true);
    expect(getSettingsField('nope')).toBeNull();
  });
});
