// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit parser gates (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * A block is drawn only when it parses completely. These tests pin the
 * happy path, every rejection the plan lists, and the streaming behaviour a
 * reply being written depends on.
 */
import { describe, expect, it } from 'vitest';
import { parseBlock, usedComponentNames } from '../parse.ts';
import { COMPONENTS, signatureOf } from '../catalog.ts';

const VALID = [
  'root = Stack([note, flow])',
  'note = Callout("Routers rewrite the MAC header, keep the IP header.", "info")',
  'flow = Steps([{title: "Sender", status: "done"}, {title: "Router", status: "current"}, {title: "Receiver"}], "row")',
].join('\n');

describe('parse', () => {
  it('parses a block with nested statements', () => {
    const parsed = parseBlock(['root = Stack([card])', 'card = Card("Report", [Text("All good.")])'].join('\n'));
    expect(parsed.kind).toBe('block');
    if (parsed.kind !== 'block') return;
    expect(parsed.root.typeName).toBe('Stack');
    expect(parsed.nodes.get('card')?.typeName).toBe('Card');
    expect(parsed.complete).toBe(true);
  });

  it('parses objects, numbers, booleans, and null', () => {
    const parsed = parseBlock([
      'root = Stack([chart])',
      'chart = BarChart(["a", "b"], [Series("one", [1, null])], "%", true)',
    ].join('\n'));
    expect(parsed.kind).toBe('block');
    if (parsed.kind !== 'block') return;
    const chart = parsed.nodes.get('chart')!;
    expect(chart.args[3]).toEqual({ kind: 'boolean', value: true });
    const series = (chart.args[1] as { items: unknown[] }).items[0] as { kind: string };
    expect(series.kind).toBe('node');
  });

  it('keeps a line break inside a string', () => {
    const parsed = parseBlock(['root = Stack([t])', 't = Text("one', 'two")'].join('\n'));
    expect(parsed.kind).toBe('block');
    if (parsed.kind !== 'block') return;
    expect(parsed.nodes.get('t')?.args[0]).toEqual({ kind: 'string', value: 'one\ntwo' });
  });

  it('ignores comment lines', () => {
    const parsed = parseBlock(['# a note', 'root = Stack([])'].join('\n'));
    expect(parsed.kind).toBe('block');
  });
});

describe('rejections', () => {
  const rejected = (source: string) => {
    const parsed = parseBlock(source);
    expect(parsed.kind).toBe('invalid');
    return parsed.kind === 'invalid' ? parsed.errors.map((error) => error.code) : [];
  };

  it('rejects a block with no root', () => {
    expect(rejected('a = Stack([])')).toContain('no-root');
  });

  it('rejects a root that is not a stack', () => {
    expect(rejected('root = Text("hi")')).toContain('bad-root');
  });

  it('rejects an undefined name', () => {
    expect(rejected('root = Stack([missing])')).toContain('undefined-name');
  });

  it('rejects an unused name', () => {
    expect(rejected(['root = Stack([])', 'lonely = Text("unused")'].join('\n'))).toContain('unused-name');
  });

  it('rejects a duplicated name', () => {
    expect(rejected(['root = Stack([a])', 'a = Text("one")', 'a = Text("two")'].join('\n'))).toContain('duplicate-name');
  });

  it('rejects an unknown component', () => {
    expect(rejected('root = Stack([a])\na = Sparkle("boom")')).toContain('unknown-component');
  });

  it('rejects a missing required argument', () => {
    expect(rejected('root = Stack([])\na = Badge()')).toContain('arity');
  });

  it('rejects an argument of the wrong type', () => {
    expect(rejected(['root = Stack([s])', 's = Stat("Users", "many")'].join('\n'))).toContain('arity');
  });

  it('rejects a node that names itself', () => {
    expect(rejected(['root = Stack([a])', 'a = Row([a])'].join('\n'))).toContain('cycle');
  });

  it('rejects an unterminated call when the block is finished', () => {
    expect(rejected('root = Stack([a]\na = Text("x")')).toContain('unterminated');
  });

  it('treats an empty source as empty, not an error', () => {
    expect(parseBlock('   ').kind).toBe('empty');
  });
});

describe('streaming', () => {
  it('draws what parsed while a call is still being written', () => {
    const parsed = parseBlock(['root = Stack([card])', 'card = Card("Report", [Text("All'].join('\n'), { streaming: true });
    expect(parsed.kind).toBe('block');
    if (parsed.kind !== 'block') return;
    expect(parsed.complete).toBe(false);
    // The cut Card keeps the title it parsed.
    expect(parsed.nodes.get('card')?.args[0]).toEqual({ kind: 'string', value: 'Report' });
  });

  it('draws nothing before the root exists', () => {
    expect(parseBlock('root = Sta', { streaming: true }).kind).toBe('empty');
  });

  it('reports completeness for a finished block', () => {
    const parsed = parseBlock(['root = Stack([a])', 'a = Text("done")'].join('\n'), { streaming: false });
    expect(parsed.kind === 'block' && parsed.complete).toBe(true);
  });
});

describe('catalog', () => {
  it('gives every component a signature', () => {
    for (const component of COMPONENTS) {
      expect(signatureOf(component)).toMatch(/^[A-Z][A-Za-z]+\(/u);
    }
  });

  it('reads the component names a source uses', () => {
    expect(usedComponentNames(VALID)).toEqual(['Stack', 'Callout', 'Steps']);
  });
});

