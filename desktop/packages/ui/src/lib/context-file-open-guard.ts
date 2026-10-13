// SPDX-License-Identifier: Apache-2.0
/** Doc 15 §G.4: open context-file links only after a bounded safe read. */
import { FileReadError, readFileStat, readFileText } from './files/api.ts';

export const MAX_OPEN_FILE_LINES = 20_000;
export const MAX_OPEN_FILE_BYTES = 10 * 1024 * 1024;

export type ContextFileOpenResult =
  | { status: 'ok' }
  | { status: 'binary' }
  | { status: 'too-large' }
  | { status: 'missing' }
  | { status: 'unreadable' };

const NOW_READ_EXTENSIONS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.exe', '.dll', '.bin', '.zip', '.gz', '.tar', '.7z', '.mp3', '.wav', '.ogg',
  '.mp4', '.mov', '.ttf', '.otf', '.woff', '.woff2', '.sqlite', '.db',
]);

export async function validateContextFileOpen(
  path: string,
  directory = '',
): Promise<ContextFileOpenResult> {
  const suffix = path.split(/[/\\]/u).at(-1)?.toLowerCase().match(/\.([a-z0-9]{1,16})$/u)?.[0];
  if (suffix && NOW_READ_EXTENSIONS.has(suffix)) return { status: 'ok' };
  if (!path) return { status: 'missing' };
  let stat = null;
  try {
    stat = await readFileStat(directory, path, true);
  } catch {
    stat = null;
  }
  if (stat && stat.size > MAX_OPEN_FILE_BYTES) return { status: 'too-large' };
  let content: string;
  try {
    content = await readFileText(directory, path, true);
  } catch (error) {
    return error instanceof FileReadError && error.status === 404
      ? { status: 'missing' } : { status: 'unreadable' };
  }
  if (content.includes('\u0000')) return { status: 'binary' };
  if (content.length > MAX_OPEN_FILE_BYTES) return { status: 'too-large' };
  let lineCount = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    lineCount += 1;
    if (lineCount > MAX_OPEN_FILE_LINES) return { status: 'too-large' };
  }
  return { status: 'ok' };
}
