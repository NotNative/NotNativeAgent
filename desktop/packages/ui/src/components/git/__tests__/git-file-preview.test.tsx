// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * F6.3: image files with binary patches render a before/after view from the
 * /api/git/file-diff endpoint (working rail only — the endpoint compares HEAD
 * to the working tree, not the index).
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { runtimeFetch } from '../../../lib/runtime-fetch.ts';
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../I18nProvider.tsx';
import { GitFilePreview } from '../git-file-preview.tsx';
import { registerRuntimeAPIs } from '../../../lib/api/registry.ts';
import * as serverGit from '../../../lib/git/server-api.ts';
import type { RuntimeAPIs } from '../../../lib/api/types.ts';
import { fetchGitDiff, fetchGitFileDiff } from '../../../lib/git/api.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const fetchMock = runtimeFetch as unknown as Mock;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function renderPreview(path: string, staged: boolean): Promise<void> {
  return act(async () => {
    rootHandle?.render(createElement(I18nProvider, null,
      createElement(GitFilePreview, {
        directory: '/repo', path, staged, revision: null, onClose: () => undefined,
      })));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  registerRuntimeAPIs({ git: serverGit } as unknown as RuntimeAPIs);
  fetchMock.mockImplementation(async (input: string) => {
    if (String(input).includes('/api/git/diff')) {
      return jsonResponse({ diff: 'Binary files a/doc.png and b/doc.png differ\n' });
    }
    if (String(input).includes('/api/git/file-diff')) {
      const png = (label: string) => `data:image/png;base64,${Buffer.from(label).toString('base64')}`;
      return jsonResponse({ isBinary: true, original: png('old'), modified: png('new') });
    }
    return jsonResponse({});
  });
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
});

describe('git file preview image diffs', () => {
  it('renders before/after images instead of the binary card on the working rail', async () => {
    await renderPreview('doc.png', false);
    expect(document.body.textContent).toContain('Before (HEAD)');
    expect(document.body.textContent).toContain('After (working tree)');
    expect(document.querySelectorAll('img')).toHaveLength(2);
  });

  it('keeps the plain binary card on the staged rail (endpoint semantics mismatch)', async () => {
    await renderPreview('doc.png', true);
    expect(document.body.textContent).toContain('no textual diff');
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  it('falls back to the binary card when the endpoint returns no sides', async () => {
    fetchMock.mockImplementation(async (input: string) => String(input).includes('/api/git/file-diff')
      ? jsonResponse({ isBinary: true, original: null, modified: null })
      : jsonResponse({ diff: 'Binary files a/doc.png and b/doc.png differ\n' }));
    await renderPreview('doc.png', false);
    expect(document.body.textContent).toContain('no textual diff');
  });

  it('uses the api facade (adapter parity)', async () => {
    await expect(fetchGitDiff('/repo', 'a.ts', { staged: false, contextLines: 3 })).resolves.toBeDefined();
    await expect(fetchGitFileDiff('/repo', 'a.ts', false)).resolves.toBeDefined();
  });
});
