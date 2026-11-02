// SPDX-License-Identifier: Apache-2.0
/**
 * Primitive gates (docs/planning/desktop-ui-visual-system.md §5, §10.2).
 *
 * Every surface is built from these components, so their contract is pinned:
 * a variant names itself in a data attribute, a tone never infers anything
 * from text, a chosen tile takes the selection fill, and no component carries
 * a palette colour, a pixel font size, or a shadow of its own.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Badge, Bar, Box, Button, Callout, Disclosure, Dot, Floating, Input, Row, Textarea, Tile, toneAttribute,
} from '../primitives.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../primitives.tsx'), 'utf8');

const render = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe('tone mapping', () => {
  it('keeps neutral as an absence, not a colour', () => {
    expect(toneAttribute('neutral')).toBeUndefined();
    expect(toneAttribute(undefined)).toBeUndefined();
  });

  it('passes a structured tone through unchanged', () => {
    expect(toneAttribute('error')).toBe('error');
    expect(toneAttribute('warning')).toBe('warning');
  });
});

describe('primitives', () => {
  it('names a primary button in a data attribute rather than a colour', () => {
    const html = render(<Button variant="primary">Send</Button>);
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain('ui-raised-primary');
    expect(html).not.toMatch(/bg-(amber|orange|rose|red|indigo|neutral)-\d/u);
  });

  it('marks a chosen tile with the selection state and the pressed attribute', () => {
    const html = render(<Tile chosen>Queue</Tile>);
    expect(html).toContain('ui-tile');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-chosen');
  });

  it('renders a warning callout as a banner and an info callout without a fill', () => {
    const warning = render(<Callout tone="warning" title="Slow network">Retrying.</Callout>);
    const info = render(<Callout tone="info">Routers keep the IP header.</Callout>);
    expect(warning).toContain('data-tone="warning"');
    expect(warning).toContain('ui-callout-title');
    expect(info).toContain('data-tone="info"');
    expect(info).toContain('ui-callout');
  });

  it('draws a badge tone only when a tone is given', () => {
    expect(render(<Badge label="Open" />)).not.toContain('data-tone');
    expect(render(<Badge label="Failed" tone="error" />)).toContain('data-tone="error"');
  });

  it('bounds a bar to its maximum and never exceeds one whole', () => {
    expect(render(<Bar value={150} max={100} />)).toContain('data-value="100"');
    expect(render(<Bar value={-10} max={100} />)).toContain('data-value="0"');
    expect(render(<Bar value={25} max={50} />)).toMatch(/--value:50%|--value: 50%/u);
    expect(render(<Bar value={25} max={50} />)).toContain('data-value="50"');
  });

  it('renders a labelled row with a label before its value', () => {
    const html = render(<Row label="Branch" value="main" />);
    expect(html.indexOf('Branch')).toBeLessThan(html.indexOf('main'));
    expect(html).toContain('ui-row-label');
    expect(html).toContain('ui-row-value');
  });

  it('keeps a disclosure body out of the DOM until it opens', () => {
    const closed = render(<Disclosure title="Read src/a.ts" open={false} onToggle={() => {}}>body</Disclosure>);
    const open = render(<Disclosure title="Read src/a.ts" open onToggle={() => {}}>body</Disclosure>);
    expect(closed).not.toContain('>body<');
    expect(open).toContain('>body<');
    expect(open).toContain('data-disclosure-connector');
  });

  it('gives a floating surface an opaque or a glass backing by request only', () => {
    expect(render(<Floating>menu</Floating>)).toContain('ui-floating');
    expect(render(<Floating glass>menu</Floating>)).toContain('ui-floating-glass');
  });

  it('shapes inputs with the field primitive', () => {
    expect(render(<Input placeholder="Search" />)).toContain('ui-field');
    expect(render(<Textarea />)).toContain('ui-field');
    expect(render(<Box>stat</Box>)).toContain('ui-box');
    expect(render(<Dot color="var(--chart-1)" />)).toContain('ui-dot');
  });
});

describe('primitive source rules', () => {
  it('carries no Tailwind palette colour', () => {
    expect(source).not.toMatch(/(?:text|bg|border|ring|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/u);
  });

  it('carries no pixel font size and no raw shadow', () => {
    expect(source).not.toMatch(/text-\[\d+px\]/u);
    expect(source).not.toMatch(/shadow-(?:sm|md|lg|xl|2xl)\b/u);
  });

  it('sizes every string from the type scale', () => {
    const sizes = [...source.matchAll(/text-\[length:var\(--type-([a-z-]+)\)\]/gu)].map((match) => match[1]);
    expect(sizes.length).toBeGreaterThanOrEqual(5);
    for (const size of sizes) {
      expect(['ui-label', 'meta', 'micro', 'markdown', 'code', 'ui-header']).toContain(size);
    }
  });
});
