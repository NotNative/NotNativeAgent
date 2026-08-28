// SPDX-License-Identifier: Apache-2.0
import { portableExecutableName } from './executable-name.js';

const BROWSER_EXECUTABLES = new Set([
  'chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'msedge', 'microsoft-edge', 'firefox', 'firefox-esr', 'safari',
]);
const SHELL_EXECUTABLES = new Set(['bash', 'cmd', 'powershell', 'pwsh', 'sh']);

export const EXTERNAL_BROWSER_GUIDANCE = 'Direct browser processes are not permitted through shell.run or process.run. Use web.fetch for bounded text retrieval, or web.browse for managed rendering, interaction, local-page serving, and screenshots.';

export function processLaunchesExternalBrowser(executable, args = []) {
  const name = portableExecutableName(executable);
  if (BROWSER_EXECUTABLES.has(name)) return true;
  if (packageRunnerLaunchesBrowser(name, args)) return true;
  if (!SHELL_EXECUTABLES.has(name)) return false;
  const commandIndex = args.findIndex((value) => /^(?:-c|-command|\/c)$/iu.test(value));
  return commandIndex >= 0 && shellLaunchesExternalBrowser(args[commandIndex + 1]);
}

export function shellLaunchesExternalBrowser(script) {
  const source = String(script ?? '');
  if (directBrowserCommand(source) || browserPackageCommand(source)) return true;
  for (const variable of browserPathVariables(source)) {
    const escaped = escapeRegExp(variable);
    if (new RegExp(`(?:&\\s*\\$${escaped}\\b|Start-Process\\s+(?:-FilePath\\s+)?\\$${escaped}\\b)`, 'iu').test(source)) return true;
  }
  return false;
}

function packageRunnerLaunchesBrowser(name, args) {
  if (!['npx', 'pnpm', 'yarn', 'npm'].includes(name)) return false;
  const words = args.map((value) => String(value).toLowerCase());
  return words.some((word) => word === 'playwright' || word.endsWith('/playwright') || word.endsWith('\\playwright'));
}

function directBrowserCommand(source) {
  const names = [...BROWSER_EXECUTABLES].map(escapeRegExp).join('|');
  const target = String.raw`(?:(?:['"][^'"]*[\\/])|(?:[^\s'";&|]*[\\/]))?(?:${names})(?:\.exe)?(?:['"])?`;
  const boundary = String.raw`(?:^|[;|\n]\s*|&&\s*|\|\|\s*|&\s+|Start-Process\s+(?:-FilePath\s+)?)`;
  return new RegExp(`${boundary}${target}(?=\\s|$)`, 'iu').test(source);
}

function browserPackageCommand(source) {
  return /(?:^|[;|\n]\s*|&&\s*|\|\|\s*)(?:npx|pnpm\s+(?:dlx|exec)|yarn\s+dlx|npm\s+exec)\s+(?:--yes\s+)?playwright\b/iu.test(source)
    || /node_modules[\\/]\.bin[\\/]playwright(?:\.cmd)?\b/iu.test(source);
}

function browserPathVariables(source) {
  const names = [];
  const assignments = /\$([A-Za-z_][\w-]*)\s*=\s*['"][^'"]*(?:chrome|chromium|msedge|firefox|safari)(?:\.exe)?['"]/giu;
  for (const match of source.matchAll(assignments)) names.push(match[1]);
  return names;
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
