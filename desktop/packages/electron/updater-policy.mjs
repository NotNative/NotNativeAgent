// SPDX-License-Identifier: Apache-2.0

import { accessSync, constants, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

const LOOPBACK_HOSTS = new Set(['localhost', '::1']);

function isLoopbackAddress(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  const ipv4 = host.split('.');
  return ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    && Number(ipv4[0]) === 127;
}

function validE2eFeed(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || !isLoopbackAddress(url.hostname)) return null;
    return { provider: 'generic', url: url.href.replace(/\/+$/u, '') };
  } catch { return null; }
}

export function resolveUpdaterFeed({ environment = {}, testBuild = false } = {}) {
  if (environment.OPENCHAMBER_E2E === '1' && testBuild) {
    const testFeed = validE2eFeed(environment.OPENCHAMBER_UPDATER_E2E_URL);
    if (testFeed) return testFeed;
  }
  return { provider: 'github', owner: 'openchamber', repo: 'openchamber' };
}

export function resolveUpdaterChannel({ platform, architecture }) {
  return platform === 'win32' && architecture === 'arm64' ? 'latest-arm64' : null;
}

export function assertUpdaterCapability({ platform, packaged, environment = process.env, fs = { statSync, accessSync }, paths = { dirname, isAbsolute } }) {
  if (!packaged || platform !== 'linux') return;
  const imagePath = environment.APPIMAGE;
  if (!imagePath) throw new Error('Updates require the packaged Linux AppImage. Start NotNativeDesktop from its .AppImage file, not an extracted or repackaged copy.');
  if (!paths.isAbsolute(imagePath)) throw new Error(`The running AppImage path is not absolute: ${imagePath}`);
  let metadata;
  try { metadata = fs.statSync(imagePath); } catch {
    throw new Error(`The running AppImage cannot be found at ${imagePath}. Start NotNativeDesktop from a valid .AppImage file.`);
  }
  if (!metadata.isFile()) throw new Error(`The running AppImage cannot be found at ${imagePath}. Start NotNativeDesktop from a valid .AppImage file.`);
  try {
    fs.accessSync(imagePath, constants.W_OK);
    // AppImageUpdater downloads beside the running image and atomically
    // replaces it. A writable file in a read-only directory passes a file
    // mode check but cannot be updated.
    fs.accessSync(dirname(imagePath), constants.W_OK);
  } catch {
    throw new Error(`The AppImage is not writable at ${imagePath}. Move it to a writable location or grant write permission before updating.`);
  }
}

export function compareVersions(left, right) {
  const parse = (value) => {
    const text = String(value ?? '').trim().replace(/^v/iu, '');
    const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(text);
    if (!match) return null;
    return {
      core: match[1].split('.').map(BigInt),
      prerelease: match[2]?.split('.') ?? null,
    };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return 0;
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const x = a.core[i] ?? 0n; const y = b.core[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease !== b.prerelease) return a.prerelease === null ? 1 : -1;
    return 0;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    if (a.prerelease[i] === undefined || b.prerelease[i] === undefined) {
      return a.prerelease[i] === undefined ? -1 : 1;
    }
    const x = a.prerelease[i]; const y = b.prerelease[i];
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x); const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) {
      const xn = BigInt(x); const yn = BigInt(y);
      return xn > yn ? 1 : -1;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
