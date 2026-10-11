// SPDX-License-Identifier: Apache-2.0
/** W-53 UI surfaces: PR/issue lists render, fail-closed states surface codes. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LinearIssuesPanel, PullRequestsPanel } from '../integrations-panel.tsx';

const { runtimeFetchState } = vi.hoisted(() => ({ runtimeFetchState: { impl: (..._args: unknown[]): Promise<Response> => Promise.resolve(new Response('{}')) } }));
vi.mock('../../../lib/runtime-fetch.ts', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetchState.impl(...args) }));
vi.mock('../../../lib/runtime-url.ts', () => ({ getApiBaseUrl: () => 'http://runtime.test' }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('integrations panels (W-53)', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); });
  afterEach(() => {
    if (container !== null && root !== null) { const r = root; root = null; act(() => { r.unmount(); }); }
    container?.remove(); container = null; vi.restoreAllMocks();
  });

  function mount(node: Parameters<typeof createRoot> extends never ? never : React.ReactNode): HTMLDivElement {
    const target = container!;
    root = createRoot(target);
    act(() => root!.render(node));
    return target;
  }

  it('pull requests render, drafts labelled; failure surfaces the typed code', async () => {
    runtimeFetchState.impl = async () => jsonResponse({ pulls: [
      { number: 7, title: 'Fix leak', state: 'draft', headRef: 'fix', baseRef: 'main', url: 'u', updatedAt: 'x' },
    ] });
    const node = mount(<PullRequestsPanel directory="/work" />);
    await act(async () => { (node.querySelector('[data-testid="pull-requests-refresh"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="pull-7"]')?.textContent).toContain('Fix leak');
      expect(node.querySelector('[data-testid="pull-7"]')?.textContent).toContain('draft');
    });
    runtimeFetchState.impl = async () => jsonResponse({ error: 'rate limited', code: 'github-rate-limited' }, 429);
    await act(async () => { (node.querySelector('[data-testid="pull-requests-refresh"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="pull-requests-failure"]')?.textContent).toContain('github-rate-limited');
    });
  });

  it('linear issues render with assignee; unconfigured state stays closed with guidance', async () => {
    runtimeFetchState.impl = async () => jsonResponse({ issues: [
      { id: 'i-1', identifier: 'AC-1', title: 'Ship it', state: 'In Progress', assignee: 'Ada', url: 'u', updatedAt: 'x' },
    ] });
    const node = mount(<LinearIssuesPanel />);
    await act(async () => { (node.querySelector('[data-testid="linear-issues-refresh"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="issue-AC-1"]')?.textContent).toContain('Ship it');
      expect(node.querySelector('[data-testid="issue-AC-1"]')?.textContent).toContain('Ada');
    });
    runtimeFetchState.impl = async () => jsonResponse({ error: 'no key', code: 'linear-unconfigured' }, 409);
    await act(async () => { (node.querySelector('[data-testid="linear-issues-refresh"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => {
      expect(node.querySelector('[data-testid="linear-issues-failure"]')?.textContent).toContain('setup is optional');
    });
  });
});
