// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Tool card + markdown hardening (W-17): state pills (running/done/error),
 * expandable JSON detail (summary/formatted/raw riding the registry
 * `toolJsonViewMode`), live bash output block, and the markdown-lite
 * hardening rules (no raw HTML, scheme-restricted links, fences/lists).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ToolCard, jsonViewModeFromSettings } from '../tool-cards.tsx';
import { renderMarkdown } from '../markdown-lite.tsx';
import { setSettingsField, __resetSettingsStoreForTests } from '../../lib/settings/store.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function mount(node: React.ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(node); });
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function headerButton(): HTMLButtonElement {
  return (document.querySelector('[data-testid="chat-tool-card"]')?.querySelector('button') as HTMLButtonElement);
}

function openDetail(): string {
  return document.querySelector('[data-testid="chat-tool-card"]')!.textContent ?? '';
}

afterEach(() => {
  __resetSettingsStoreForTests();
  act(() => { rootHandle?.unmount(); });
  container?.remove();
  container = null;
  rootHandle = null;
  document.body.innerHTML = '';
});

const COMPLETED_READ = {
  type: 'tool',
  tool: 'read',
  callID: 'call_p1',
  state: {
    status: 'completed',
    input: { path: 'packages/ui/src/chat/turns.ts' },
    output: 'export function projectTurns(messages: Message[]): ChatTurn[] {\n  ...\n}',
    title: 'packages/ui/src/chat/turns.ts',
    metadata: { lines: 64, source: 'packages/ui/src/chat/turns.ts' },
    time: { start: 1_000, end: 1_240 },
  },
} as unknown as Parameters<typeof ToolCard>[0]['part'];

describe('ToolCard states (doc 05 parts, W-17)', () => {
  it('completed state shows done pill, duration, and a summary detail with the path', async () => {
    mount(<ToolCard part={COMPLETED_READ} />);
    const card = document.querySelector('[data-testid="chat-tool-card"]')!;
    expect(card.getAttribute('data-tool-state')).toBe('completed');
    expect(card.textContent).toContain('reading file');
    expect(card.textContent).toContain('240ms');
    await click(headerButton());
    expect(openDetail()).toContain('packages/ui/src/chat/turns.ts');
    expect(document.querySelector('[data-testid="chat-tool-metadata"]')!.textContent).toContain('lines: 64');
  });

  it('running state shows the pulse pill; live output rides the dedicated block', () => {
    mount(<ToolCard part={{
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'pnpm test' }, time: { start: 2_000 }, output: 'RUN  v3.2.4\n ok suite\n' },
    } as unknown as Parameters<typeof ToolCard>[0]['part']} />);
    const card = document.querySelector('[data-testid="chat-tool-card"]')!;
    expect(card.getAttribute('data-tool-state')).toBe('running');
    expect(card.textContent).toContain('running');
    expect(document.querySelector('[data-testid="chat-tool-live-output"]')!.textContent).toContain('ok suite');
  });

  it('error state surfaces the error text and the error data attribute', async () => {
    mount(<ToolCard part={{
      type: 'tool',
      tool: 'grep',
      state: { status: 'error', input: { pattern: 'x' }, error: 'no matches found (exit 1)', time: { start: 1, end: 2 } },
    } as unknown as Parameters<typeof ToolCard>[0]['part']} />);
    const card = document.querySelector('[data-testid="chat-tool-card"]')!;
    expect(card.getAttribute('data-tool-state')).toBe('error');
    await click(headerButton());
    expect(document.querySelector('[data-testid="chat-tool-error"]')!.textContent).toContain('exit 1');
  });

  it('detail modes: formatted JSON default rides the registry toolJsonViewMode', async () => {
    setSettingsField('toolJsonViewMode', 'formatted');
    expect(jsonViewModeFromSettings()).toBe('formatted');
    mount(<ToolCard part={COMPLETED_READ} />);
    await click(headerButton());
    const body = openDetail();
    expect(body).toContain('"status": "completed"');
    expect(body).toContain('"input"');
  });

  it('summary mode renders the settled output through the hardened markdown pass', async () => {
    setSettingsField('toolJsonViewMode', 'summary');
    mount(<ToolCard part={COMPLETED_READ} />);
    await click(headerButton());
    expect(document.querySelector('[data-testid="chat-tool-output"]')!.textContent).toContain('projectTurns');
  });
});

describe('markdown-lite hardening (W-17)', () => {
  it('renders headings/bold/code and never injects raw HTML', () => {
    mount(<div>{renderMarkdown('## Fixed\nthe **bug** in `turns.ts`\n<script>alert(1)</script>')}</div>);
    const host = container!;
    expect(host.querySelector('h4')?.textContent).toBe('Fixed');
    expect(host.querySelector('strong')?.textContent).toBe('bug');
    expect(host.querySelector('code')?.textContent).toBe('turns.ts');
    expect(host.querySelector('script')).toBeNull(); // inert text, never a node
    expect(host.textContent).toContain('<script>alert(1)</script>');
  });

  it('links are scheme-restricted: javascript: collapses to inert text, https renders', () => {
    mount(<div>{renderMarkdown('[bad](javascript:alert(1)) and [good](https://example.test/x)')}</div>);
    const anchors = container!.querySelectorAll('a');
    expect(anchors.length).toBe(1);
    expect(anchors[0]!.getAttribute('href')).toBe('https://example.test/x');
    expect(anchors[0]!.getAttribute('rel')).toContain('noreferrer');
  });

  it('fences/list items render without executing content', () => {
    mount(<div>{renderMarkdown('- one\n- two\n```json\n{"a":1}\n```')}</div>);
    expect(container!.querySelectorAll('li').length).toBe(2);
    expect(container!.querySelector('pre')?.textContent).toBe('{"a":1}');
  });

  it('uses the active syntax palette for fenced code blocks', () => {
    mount(<div>{renderMarkdown('```ts\nconst value = 1;\n```')}</div>);
    const code = document.querySelector('[data-code-lang="ts"]') as HTMLElement;
    expect(code.style.backgroundColor).toBe('var(--syntax-background)');
    expect(code.style.color).toBe('var(--syntax-foreground)');
    expect(code.textContent).toContain('const value = 1;');
  });

  it('garbage input never throws', () => {
    expect(() => renderMarkdown('')).not.toThrow();
    expect(renderMarkdown('plain text only').length).toBe(1);
  });
});
