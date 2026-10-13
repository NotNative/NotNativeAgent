// SPDX-License-Identifier: Apache-2.0
const WINDOWS_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const WINDOWS_FILE_REPLACE_DELAYS_MS = Object.freeze([50, 100, 200, 400, 800, 1000, 1000]);

/** Replace a target atomically; Windows file scanners may briefly lock either path. */
export async function replaceFileWithRetry(source, target, {
  platform = process.platform,
  rename = (from, to) => import('node:fs/promises').then((fs) => fs.rename(from, to)),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (platform !== 'win32') return rename(source, target);
  for (let attempt = 0; ; attempt += 1) {
    try { return await rename(source, target); }
    catch (error) {
      const delay = WINDOWS_FILE_REPLACE_DELAYS_MS[attempt];
      if (delay === undefined || !WINDOWS_RETRY_CODES.has(error?.code)) throw error;
      await sleep(delay);
    }
  }
}

/** Best-effort removal uses the same bounded Windows sharing-violation backoff. */
export async function removeFileWithRetry(target, {
  platform = process.platform,
  remove = (filePath) => import('node:fs/promises').then((fs) => fs.rm(filePath, { force: true })),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (platform !== 'win32') return remove(target);
  for (let attempt = 0; ; attempt += 1) {
    try { return await remove(target); }
    catch (error) {
      const delay = WINDOWS_FILE_REPLACE_DELAYS_MS[attempt];
      if (delay === undefined || !WINDOWS_RETRY_CODES.has(error?.code)) throw error;
      await sleep(delay);
    }
  }
}
