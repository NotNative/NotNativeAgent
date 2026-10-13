// SPDX-License-Identifier: Apache-2.0
/** URL boundary for the unprivileged Electron preview guest. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Partition selection occurs while Electron attaches the guest. Reject a
// renderer-supplied alternate instead of assuming a later params mutation
// can move an already-created guest out of the privileged default session.
export function allowedGuestPartition(params) {
  return params.partition === 'nnd-preview';
}

export function isOwnAppUrl(value, appOrigin) {
  try {
    const url = new URL(value);
    const own = new URL(appOrigin);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    const ownHost = own.hostname.toLowerCase().replace(/\.$/u, '');
    return url.origin === own.origin || (LOOPBACK.has(host) && LOOPBACK.has(ownHost)
      && url.protocol === own.protocol && url.port === own.port);
  } catch { return false; }
}

export function allowedGuestUrl(value, appOrigin) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, '');
    if (url.username || url.password || isOwnAppUrl(value, appOrigin)) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK.has(host);
  } catch { return false; }
}

export function hardenGuestPreferences(preferences, params) {
  delete preferences.preload;
  delete preferences.preloadURL;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInWorker = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.allowRunningInsecureContent = false;
  delete params.preload;
  delete params.allowpopups;
  params.partition = 'nnd-preview'; // no persist: prefix → in-memory guest session
}
