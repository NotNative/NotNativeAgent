// SPDX-License-Identifier: Apache-2.0
/**
 * Fence routing gates (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * An `openui-lang` fence draws a block in an assistant reply that opts in,
 * and stays code everywhere else: user text, reasoning, and tool output.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from '../markdown-lite.tsx';

const SOURCE = ['Text before.', '```openui-lang', 'root = Stack([a])', 'a = Text("inside")', '```', 'Text after.'].join('\n');
const html = (options: { blocks?: object }) => renderToStaticMarkup(<div>{renderMarkdown(SOURCE, undefined, options)}</div>);

describe('fence routing', () => {
  it('draws a block where the caller opts in', () => {
    const markup = html({ blocks: {} });
    expect(markup).toContain('data-testid="ui-block"');
    expect(markup).toContain('Text before.');
    expect(markup).toContain('Text after.');
    expect(markup).not.toContain('openui-lang');
  });

  it('shows the fence as code when the caller does not opt in', () => {
    const markup = html({});
    expect(markup).not.toContain('data-testid="ui-block"');
    expect(markup).toContain('root = Stack([a])');
  });

  it('leaves a fence of another language alone', () => {
    const source = ['```ts', 'const value = 1;', '```'].join('\n');
    const markup = renderToStaticMarkup(<div>{renderMarkdown(source, undefined, { blocks: {} })}</div>);
    expect(markup).not.toContain('data-testid="ui-block"');
    expect(markup).toContain('const value = 1;');
  });
});
