// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit catalog (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * An assistant reply may carry a fenced program in a small declarative
 * language. The parser, the renderer, and the guidance the model reads all
 * build from this one catalog, so the signatures a model writes against are
 * exactly the ones the parser checks.
 *
 * Invariant: only the components here exist. An undefined name is a parse
 * error, never a silent skip, so a model learns its mistake from the fallback
 * instead of a block that quietly loses half its content.
 */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export type BlockArg =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'array'; items: BlockArg[] }
  | { kind: 'object'; entries: Record<string, BlockArg> }
  | { kind: 'name'; name: string }
  /** A component call written inline, e.g. Text("hi") inside a card's children. */
  | { kind: 'node'; node: BlockNode };

export type BlockNode = {
  typeName: string;
  args: BlockArg[];
  /** Where the statement started, for diagnostics. */
  offset: number;
};

export type FieldSpec = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'children' | 'enum' | 'object' | 'any';
  optional?: boolean;
  values?: readonly string[];
  /** How the guidance names this field in the signature. */
  hint?: string;
};

export type ComponentSpec = {
  name: string;
  /** Positional fields, in signature order. */
  positional: readonly FieldSpec[];
  description?: string;
};

const string = (name: string, optional = false, hint?: string): FieldSpec => ({ name, type: 'string', optional, ...(hint ? { hint } : {}) });
const number = (name: string, optional = false, hint?: string): FieldSpec => ({ name, type: 'number', optional, ...(hint ? { hint } : {}) });
const children = (name: string, optional = false): FieldSpec => ({ name, type: 'children', optional });
const oneOf = (name: string, values: readonly string[], optional = false): FieldSpec => ({ name, type: 'enum', values, optional });

/**
 * Layout and content components. Children are arrays of other component
 * names; every name must be defined and reachable from the stack root.
 */
export const COMPONENTS: readonly ComponentSpec[] = [
  { name: 'Stack', positional: [children('children')], description: 'A vertical column of items.' },
  { name: 'Row', positional: [children('children')], description: 'Items side by side; wraps on a narrow column.' },
  { name: 'Text', positional: [string('markdown', false, 'inline Markdown')] },
  { name: 'Card', positional: [string('title', true, 'title: inline Markdown, "" for none'), children('children')] },
  { name: 'Tabs', positional: [{ name: 'tabs', type: 'children' }], description: 'Tab children, each with its own label.' },
  { name: 'Tab', positional: [string('label'), children('children')] },
  { name: 'Details', positional: [string('title'), children('children')], description: 'A section folded under its title.' },
  { name: 'Badge', positional: [string('label'), oneOf('tone', ['neutral', 'info', 'success', 'warning', 'error'], true)] },
  { name: 'Callout', positional: [string('markdown'), oneOf('tone', ['neutral', 'info', 'success', 'warning', 'error'], true), string('title', true)] },
  { name: 'KeyValue', positional: [{ name: 'items', type: 'object' }], description: 'Labelled values: {label, value} pairs.' },
  { name: 'Table', positional: [{ name: 'columns', type: 'object' }, { name: 'rows', type: 'object' }], description: 'Columns then rows of cells.' },
  { name: 'Stat', positional: [string('label'), number('value'), string('delta', true), oneOf('tone', ['neutral', 'info', 'success', 'warning', 'error'], true)] },
  { name: 'Progress', positional: [string('label'), number('value'), number('max', true)] },
  { name: 'BarChart', positional: [{ name: 'labels', type: 'object' }, children('series'), string('unit', true), { name: 'whole', type: 'boolean', optional: true }] },
  { name: 'LineChart', positional: [{ name: 'labels', type: 'object' }, children('series'), string('unit', true)] },
  { name: 'Series', positional: [string('name'), { name: 'values', type: 'object' }], description: 'One value per label; null for no data.' },
  { name: 'Choice', positional: [{ name: 'name', type: 'string' }, { name: 'options', type: 'object' }, string('label', true), { name: 'multiple', type: 'boolean', optional: true }], description: 'Name keys the answer; add a description where a label alone leaves its meaning unclear.' },
  { name: 'Input', positional: [{ name: 'name', type: 'string' }, string('label', true), string('placeholder', true), { name: 'multiline', type: 'boolean', optional: true }], description: 'Name keys the answer.' },
  { name: 'Slider', positional: [{ name: 'name', type: 'string' }, number('min'), number('max'), string('label', true), number('step', true), number('value', true), string('unit', true)] },
  { name: 'Button', positional: [string('label'), oneOf('variant', ['primary', 'secondary'], true), { name: 'value', type: 'string' }], description: 'value = the item it decides; primary = your pick, one per decision.' },
  { name: 'Steps', positional: [{ name: 'items', type: 'object' }, oneOf('direction', ['column', 'row'], true)], description: 'A flow of steps: {title, markdown?, status} where status is "done", "current", "todo", or "blocked".' },
];

/** The one component every block must reach from its root. */
export const ROOT_COMPONENT = 'Stack';

/** Components that hold a single answer and freeze the block once answered. */
export const ANSWERING_COMPONENTS: readonly string[] = ['Choice', 'Input', 'Slider', 'Button'];

export function componentNamed(name: string): ComponentSpec | undefined {
  return COMPONENTS.find((component) => component.name === name);
}

/** The guidance a model reads for one component, built from its signature. */
export function signatureOf(component: ComponentSpec): string {
  const fields = component.positional.map((field) => {
    const label = field.optional ? `${field.name}?` : field.name;
    if (field.type === 'children') return `${label}: Item[]`;
    if (field.type === 'enum') return `${label}: ${field.values?.map((value) => `"${value}"`).join(' | ')}`;
    if (field.type === 'number') return `${label}: number`;
    if (field.type === 'boolean') return `${label}: boolean`;
    if (field.type === 'object') return `${label}: Array`;
    return `${label}: string`;
  });
  return `${component.name}(${fields.join(', ')})`;
}
