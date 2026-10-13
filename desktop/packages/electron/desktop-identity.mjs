// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_CLIENT_TOKEN_LENGTH = 8_192;

export function readDesktopLocalClientToken(readPrefs) {
  const token = readPrefs()?.desktopLocalClientToken;
  // Treat persisted preferences as untrusted input. In particular, returning
  // an arbitrarily large value over IPC can stall the renderer and retain a
  // corrupt credential indefinitely. Match host-config's storage boundary.
  if (typeof token !== 'string') return '';
  const normalized = token.trim();
  return normalized.length <= MAX_CLIENT_TOKEN_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : '';
}

export function readOrCreateDesktopInstallId({ readPrefs, writePrefs, generateId = randomUUID }) {
  const prefs = readPrefs();
  if (typeof prefs.desktopInstallId === 'string' && UUID_PATTERN.test(prefs.desktopInstallId)) {
    return prefs.desktopInstallId;
  }
  const id = generateId();
  if (!UUID_PATTERN.test(id)) throw new Error('Install ID generator returned an invalid UUID');
  writePrefs({ desktopInstallId: id });
  return id;
}
