// SPDX-License-Identifier: Apache-2.0
/**
 * Editor content support (doc 06 §3.3/§3.7/§3.10): line-ending discipline
 * (detect CRLF, normalize to \n in the draft, restore on write), the
 * content-level binary sniff, file-class predicate set, and the large-file
 * thresholds. `LARGE_FILE_CHAR_THRESHOLD` selects the INITIAL preview mode
 * only — edit rights are never revoked.
 */
export const LARGE_FILE_CHAR_THRESHOLD = 200_000;
export const MAX_CONTENT_POLL_BYTES = 200_000;
export const AUTO_SAVE_DELAY = 1_500;
export const SAVE_STATUS_LINGER_MS = 2_000;
export const STAT_POLL_INTERVAL_MS = 2_000;
export const DIRECTORY_POLL_INTERVAL_MS = 8_000;
export const TREE_SEARCH_DEBOUNCE_MS = 200;
export const GIT_STATUS_POLL_INTERVAL_MS = 15_000; // §6.3 reconcile cadence
export const EMPTY_READ_RETRIES_MS = [50, 100, 150];

export interface PreparedFileContent {
  draft: string;
  lineEnding: '\n' | '\r\n';
}

export function prepareFileEditorContent(content: string): PreparedFileContent {
  const crlf = (content.match(/\r\n/gu) ?? []).length;
  const lf = (content.match(/\n/gu) ?? []).length - crlf;
  return { draft: content.replace(/\r\n|\r/gu, '\n'), lineEnding: crlf > lf ? '\r\n' : '\n' };
}

export function serializeEditorContent(draft: string, lineEnding: '\n' | '\r\n'): string {
  return lineEnding === '\r\n' ? draft.replace(/\n/gu, '\r\n') : draft;
}

const BINARY_TEXT_MARKERS = ['\u0000'];

/** §3.3 step 8: content-level binary sniff — applied alongside the
 * extension predicates so a "text" file carrying binary junk never reaches
 * a editor state where it would be corrupted. */
export function looksLikeBinaryText(content: string, sampleLength = 8_192): boolean {
  const sample = content.slice(0, sampleLength);
  if (BINARY_TEXT_MARKERS.some((marker) => sample.includes(marker))) return true;
  let suspicious = 0;
  for (const character of sample) {
    const code = character.charCodeAt(0);
    if (code < 9 || (code > 13 && code < 32)) suspicious += 1;
    if (suspicious > sample.length * 0.06) return true;
  }
  return false;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico']);
const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj', '.bin', '.dat',
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.wasm', '.class', '.jar', '.pyc', '.pyo',
  '.psd', '.ai', '.sketch', '.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx',
]);


export function isImageFile(path: string, svgAsImage = false): boolean {
  const ext = extensionOf(path);
  return IMAGE_EXTENSIONS.has(ext) || (svgAsImage && ext === '.svg');
}

export function isPdfFile(path: string): boolean {
  return extensionOf(path) === '.pdf';
}

/** F6.2 rich previews: markdown renders through the hardened chat pipeline in
 * view mode; JSON gets a pretty-printed view. Everything else stays text. */
export function richPreviewKind(path: string): 'markdown' | 'json' | null {
  const ext = extensionOf(path);
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.json') return 'json';
  return null;
}

/** §3.3: extension-based KNOWN binaries — unknown extensions default to
 * text and are content-sniffed instead (§3.3.8). */
export function isBinaryFile(path: string): boolean {
  const ext = extensionOf(path);
  if (isPdfFile(path)) return true;
  if (isImageFile(path, true)) return true;
  return BINARY_EXTENSIONS.has(ext);
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function hasFileStatChanged(previous: FileStatLike | null, latest: FileStatLike): boolean {
  if (previous === null) return false;
  if (previous.size !== latest.size) return true;
  if (previous.mtimeMs !== null && latest.mtimeMs !== null && Math.abs(latest.mtimeMs - previous.mtimeMs) >= 1) return true;
  return false;
}

export interface FileStatLike {
  size: number;
  mtimeMs: number | null;
}
