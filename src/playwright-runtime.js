// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ContractError } from './ids.js';

export const MANAGED_PLAYWRIGHT_VERSION = '1.61.1';

export async function playwrightStatus(root, options = {}) {
  const location = normalizeRoot(root);
  const packagePath = join(location, 'node_modules', 'playwright', 'package.json');
  try {
    const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
    if (manifest.name !== 'playwright' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(manifest.version)) throw new Error('invalid package');
    const runtime = loadFrom(location, options.require ?? createRequire(import.meta.url));
    const browserPath = runtime.chromium.executablePath();
    if (!isAbsolute(browserPath)) throw new Error('invalid browser path');
    await access(browserPath, constants.F_OK);
    if (options.verifyLaunch) await launchProbe(runtime);
    return Object.freeze({ available: true, version: manifest.version, root: location, browser: 'chromium', browserPath });
  } catch (error) {
    return Object.freeze({ available: false, version: null, root: location, browser: 'chromium', browserPath: null, reason: classify(error) });
  }
}

export async function loadManagedPlaywright(root, options = {}) {
  const status = await playwrightStatus(root, options);
  if (!status.available) {
    throw new ContractError('web_browse_unavailable', 'Interactive browsing is not installed; rerun the NNA installer to add Playwright Chromium');
  }
  return Object.freeze({ playwright: loadFrom(status.root, options.require ?? createRequire(import.meta.url)), status });
}

function loadFrom(root, require) {
  const prior = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = join(root, 'browsers');
    return require(join(root, 'node_modules', 'playwright'));
  } finally {
    if (prior === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = prior;
  }
}
async function launchProbe(runtime) {
  const browser = await runtime.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,<title>NNA browser validation</title>', { waitUntil: 'domcontentloaded', timeout: 10_000 });
    if (await page.title() !== 'NNA browser validation') throw new Error('browser validation failed');
  } finally { await browser.close(); }
}
function normalizeRoot(value) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) {
    throw new ContractError('playwright_root_invalid', 'managed Playwright root must be absolute');
  }
  return resolve(value.trim());
}
function classify(error) {
  if (error?.code === 'ENOENT' || error?.code === 'MODULE_NOT_FOUND') return 'not_installed';
  return 'validation_failed';
}
