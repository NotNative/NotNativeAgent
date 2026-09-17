// SPDX-License-Identifier: Apache-2.0
/** Editor support gates (doc 06 §3.3/§3.5/§3.10 + Appendix A constants):
 * line-ending discipline, binary sniffing, classification set, stat-change
 * comparison with 1 ms jitter, and the pinned thresholds. */
import { describe, expect, it } from 'vitest';
import {
  AUTO_SAVE_DELAY, LARGE_FILE_CHAR_THRESHOLD, MAX_CONTENT_POLL_BYTES, STAT_POLL_INTERVAL_MS,
  hasFileStatChanged, isBinaryFile, isImageFile, isPdfFile, looksLikeBinaryText,
  prepareFileEditorContent, serializeEditorContent,
} from '../edit-support.ts';
import { DirectoryRequests } from '../directory-requests.ts';

describe('line-ending discipline (§3.3 step 9 + §3.7.6)', () => {
  it('detects the dominant ending and restores it on write', () => {
    const prepared = prepareFileEditorContent('a\r\nb\r\nc\nd');
    expect(prepared.lineEnding).toBe('\r\n');
    expect(prepared.draft).toBe('a\nb\nc\nd');
    expect(serializeEditorContent(prepared.draft, prepared.lineEnding)).toBe('a\r\nb\r\nc\r\nd');
  });

  it('LF-dominant files keep LF and lone CRs normalize', () => {
    const prepared = prepareFileEditorContent('a\nb\rc');
    expect(prepared.lineEnding).toBe('\n');
    expect(prepared.draft).toBe('a\nb\nc');
    expect(serializeEditorContent(prepared.draft, prepared.lineEnding)).toBe('a\nb\nc');
  });
});

describe('content sniffing + classification (§3.3 steps 3/8)', () => {
  it('flags NUL/clustered control bytes as binary text', () => {
    expect(looksLikeBinaryText('plain ascii\n')).toBe(false);
    expect(looksLikeBinaryText('\u0000\u0001\u0002\u0003binary')).toBe(true);
    expect(looksLikeBinaryText(`${String.fromCharCode(3).repeat(8_192)}`)).toBe(true);
  });

  it('classifies images (svg text-side), pdfs, and binaries', () => {
    expect(isImageFile('/x/photo.png')).toBe(true);
    expect(isImageFile('/x/logo.svg', false)).toBe(false); // SVG stays text-side in the load pipeline
    expect(isImageFile('/x/logo.svg', true)).toBe(true);
    expect(isPdfFile('/x/doc.pdf')).toBe(true);
    expect(isBinaryFile('/x/thing.wasm')).toBe(true);
    expect(isBinaryFile('/x/code.ts')).toBe(false);
  });
});

describe('stat comparison + constants (§3.5.2, Appendix A)', () => {
  it('size diff wins; mtime deltas under 1 ms are jitter; missing mtime ignored', () => {
    expect(hasFileStatChanged(null, { size: 1, mtimeMs: 5 })).toBe(false); // first observation stores only
    expect(hasFileStatChanged({ size: 10, mtimeMs: 5 }, { size: 11, mtimeMs: 5 })).toBe(true);
    expect(hasFileStatChanged({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 5.9 })).toBe(false);
    expect(hasFileStatChanged({ size: 10, mtimeMs: 5 }, { size: 10, mtimeMs: 6 })).toBe(true);
    expect(hasFileStatChanged({ size: 10, mtimeMs: null }, { size: 10, mtimeMs: 6 })).toBe(false);
  });

  it('pins the Appendix A constants where users can observe them', () => {
    expect(AUTO_SAVE_DELAY).toBe(1_500);
    expect(STAT_POLL_INTERVAL_MS).toBe(2_000);
    expect(LARGE_FILE_CHAR_THRESHOLD).toBe(200_000);
    expect(MAX_CONTENT_POLL_BYTES).toBe(200_000);
  });
});

describe('DirectoryRequests (§2.1)', () => {
  it('coalesces, force-replaces, and clears slots', async () => {
    const requests = new DirectoryRequests();
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    const first = requests.run('d', loader);
    const join = requests.run('d', loader);
    expect(join).toBe(first);
    const forced = requests.run('d', loader, true);
    expect(forced).not.toBe(first);
    await Promise.all([first, forced]);
    expect(calls).toBe(2);
    requests.clear();
    expect(requests.has('d')).toBe(false);
  });
});
