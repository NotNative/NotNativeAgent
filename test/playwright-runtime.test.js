// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { playwrightStatus } from '../src/playwright-runtime.js';
import { runWebBrowseCommand } from '../src/web-browse-cli.js';

test('managed Playwright status is absent-safe and does not download anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-playwright-'));
  const status = await playwrightStatus(root);
  assert.equal(status.available, false);
  assert.equal(status.reason, 'not_installed');
  assert.equal(status.root, root);
});

test('managed Playwright status validates both package and Chromium binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-playwright-'));
  const packageRoot = join(root, 'node_modules', 'playwright');
  const browserPath = join(root, 'browsers', 'chromium-test');
  await mkdir(packageRoot, { recursive: true }); await mkdir(join(root, 'browsers'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'playwright', version: '1.61.1' }));
  await writeFile(browserPath, 'fixture');
  const fakeRequire = () => ({ chromium: { executablePath: () => browserPath } });
  const status = await playwrightStatus(root, { require: fakeRequire });
  assert.equal(status.available, true);
  assert.equal(status.version, '1.61.1');
  assert.equal(status.browserPath, browserPath);
});

test('webbrowse CLI exposes only bounded status and validation operations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-playwright-'));
  assert.equal((await runWebBrowseCommand(['status'], { managedPlaywright: root })).available, false);
  await assert.rejects(runWebBrowseCommand(['install'], { managedPlaywright: root }), { code: 'web_browse_command_invalid' });
});
