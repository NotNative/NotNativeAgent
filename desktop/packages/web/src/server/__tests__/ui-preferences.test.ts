// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerUiPreferenceRoutes } from '../routes/ui-preferences.ts';
import { ENV } from '../env.ts';
const app = new Hono(); registerUiPreferenceRoutes(app);
let scratch: string;
const previous = ENV.dataDir;
beforeEach(async () => { scratch = await mkdtemp(join(tmpdir(), 'nna-ui-prefs-')); (ENV as { dataDir: string }).dataDir = scratch; });
afterEach(async () => { (ENV as { dataDir: string }).dataDir = previous; await rm(scratch, { recursive: true, force: true }); });
const save = (settings: unknown, expected_revision = 0) => app.request('/api/ui-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings, expected_revision }) });
it('merges saved preferences, preserves unrelated choices, and survives a new route owner', async () => {
  expect(await (await app.request('/api/ui-preferences')).json()).toMatchObject({ settings: { celebrationPreference: 'off' } });
  expect((await save({ fontSize: 125 })).status).toBe(200);
  expect((await save({ inputSpellcheckEnabled: false }, 1)).status).toBe(200);
  const reopened = new Hono(); registerUiPreferenceRoutes(reopened);
  expect(await (await reopened.request('/api/ui-preferences')).json()).toMatchObject({ revision: 2, settings: { fontSize: 125, inputSpellcheckEnabled: false } });
});
it('serializes simultaneous revisions and rejects the stale writer without losing the winner', async () => {
  const results = await Promise.all([save({ fontSize: 125 }), save({ fontSize: 150 })]);
  expect(results.map(row => row.status).sort()).toEqual([200, 409]);
  const winner = await results.find(row => row.status === 200)!.json();
  expect(await (await app.request('/api/ui-preferences')).json()).toEqual(winner);
});
it.each([{ opencodeBinary: 'untrusted.exe' }, { fontSize: 1000 }, { enterToSend: 'yes' }, { lightThemeId: 'notnative-dark' }, { shortcutOverrides: { toggle_terminal: 'mod+x' } }, { shortcutOverrides: { new_chat: 'mod+x y z' } }, { desktopUiPassword: 'secret' }])('rejects invalid or non-presentation input atomically: %j', async patch => {
  expect((await save({ fontSize: 125, ...patch })).status).toBe(400);
  expect(await (await app.request('/api/ui-preferences')).json()).toMatchObject({ revision: 0 });
});
it.each(['{broken', JSON.stringify({ revision: 1, settings: { fontSize: 9000 } })])('preserves corrupt storage for repair', async source => {
  await writeFile(join(scratch, 'ui-preferences.json'), source);
  expect((await save({ fontSize: 125 })).status).toBe(500);
  expect(await readFile(join(scratch, 'ui-preferences.json'), 'utf8')).toBe(source);
});
