// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit renderer and guidance gates (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * A block draws with the app's own primitives, a bad block falls back to its
 * source, a waiting block freezes with its answer, charts keep their series
 * apart, and every example the guidance shows is a valid block.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UiBlock, seriesColor, type BlockHost } from '../render.tsx';
import { renderMarkdown } from '../../markdown-lite.tsx';
import { blockGuidance, EXAMPLES } from '../guidance.ts';
import { parseBlock } from '../parse.ts';

const host: BlockHost = {};
const render = (source: string, override: BlockHost = {}) => renderToStaticMarkup(<UiBlock source={source} host={{ ...host, ...override }} />);

describe('block rendering', () => {
  it('draws a valid block with the app primitives', () => {
    const html = render(['root = Stack([card])', 'card = Card("Report", [Text("All good."), Badge("Open", "info")])'].join('\n'));
    expect(html).toContain('data-testid="ui-block"');
    expect(html).toContain('ui-box');
    expect(html).toContain('ui-badge');
    expect(html).toContain('data-tone="info"');
  });

  it('falls back to the source for a block that does not parse', () => {
    const html = render('root = Stack([missing])');
    expect(html).toContain('data-testid="block-source"');
    expect(html).toContain('missing');
  });

  it('draws a tone callout as a banner only for warning and error', () => {
    const warning = render(['root = Stack([a])', 'a = Callout("Watch out.", "warning")'].join('\n'));
    const info = render(['root = Stack([a])', 'a = Callout("For context.", "info")'].join('\n'));
    expect(warning).toContain('data-tone="warning"');
    expect(info).toContain('data-tone="info"');
  });

  it('draws a labelled row for a key-value pair', () => {
    const html = render(['root = Stack([kv])', 'kv = KeyValue([{label: "Branch", value: "main"}])'].join('\n'));
    expect(html.indexOf('Branch')).toBeLessThan(html.indexOf('main'));
    expect(html).toContain('ui-row-value');
  });

  it('draws a chart with one bar per label and a legend for several series', () => {
    const html = render(['root = Stack([c])', 'c = BarChart(["a", "b"], [Series("one", [1, 2]), Series("two", [2, 1])])'].join('\n'));
    expect(html).toContain('ui-bar');
    expect(html).toContain('one');
    expect(html).toContain('two');
    expect(html).toContain('ui-dot');
  });

  it('keeps every series colour apart', () => {
    const light = new Set(Array.from({ length: 6 }, (_, index) => seriesColor(index)));
    const dark = new Set(Array.from({ length: 6 }, (_, index) => seriesColor(index, true)));
    expect(light.size).toBe(6);
    expect(dark.size).toBe(6);
    for (const colour of light) expect(dark.has(colour)).toBe(false);
  });

  it('shows a send control for a block with a decision that waits on the reader', () => {
    const html = render(['root = Stack([pick])', 'pick = Choice("direction", [{label: "A"}, {label: "B"}], "Which?")'].join('\n'), { submit: () => {} });
    expect(html).toContain('Send');
    expect(html).toContain('disabled');
  });

  it('offers no send control when nobody can receive the answer', () => {
    const html = render(['root = Stack([pick])', 'pick = Choice("direction", [{label: "A"}, {label: "B"}], "Which?")'].join('\n'));
    expect(html).not.toContain('>Send<');
  });

  it('freezes a block that was already answered and shows the answer', () => {
    const source = ['root = Stack([pick])', 'pick = Choice("direction", [{label: "A"}, {label: "B"}], "Which?")'].join('\n');
    const html = render(source, { answered: { chosen: { direction: ['B'] }, note: '' }, submit: () => {} });
    expect(html).toContain('Answered: B');
    expect(html).not.toContain('>Send<');
  });

  it('draws nothing for an empty source', () => {
    expect(render('')).toBe('');
  });

  it('draws only for an assistant reply', () => {
    // Routing is owned by the Markdown renderer: a fence draws a block only
    // where the caller opts in, and that caller is the assistant text path.
    const source = ['```openui-lang', 'root = Stack([a])', 'a = Text("x")', '```'].join('\n');
    const optedIn = renderToStaticMarkup(<div>{renderMarkdown(source, undefined, { blocks: {} })}</div>);
    const plain = renderToStaticMarkup(<div>{renderMarkdown(source)}</div>);
    expect(optedIn).toContain('data-testid="ui-block"');
    expect(plain).not.toContain('data-testid="ui-block"');
  });
});

describe('guidance', () => {
  it('names the root rule and the tone values', () => {
    const text = blockGuidance();
    expect(text).toContain('root');
    expect(text).toContain('Stack');
    expect(text).toContain('"warning"');
  });

  it('lists every component signature', () => {
    const text = blockGuidance();
    for (const name of ['Stack(', 'Row(', 'Card(', 'Badge(', 'BarChart(', 'Choice(', 'Button(']) {
      expect(text).toContain(name);
    }
  });

  it('keeps every example a valid block', () => {
    for (const example of EXAMPLES) {
      const parsed = parseBlock([...example].join('\n'));
      if (parsed.kind === 'invalid') {
        throw new Error(`example failed: ${parsed.errors.map((error) => error.message).join('; ')}`);
      }
      expect(parsed.kind).toBe('block');
    }
  });
});
