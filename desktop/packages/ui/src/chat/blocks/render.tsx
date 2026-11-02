// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit renderer (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * A block draws with the same primitives as the app: badges, callouts, boxes,
 * rows, bars, tables, and form controls. Nothing here re-styles itself, so a
 * block an agent writes looks like the surrounding app whatever wrote it.
 *
 * Invariants:
 * - Only an assistant reply draws a block. Any other surface shows the source.
 * - A block that fails to parse draws its source instead; the rest of the
 *   reply stays.
 * - A choice or field freezes the block with what was answered, and shows the
 *   answer, so a reply read again later reports what the reader chose.
 * - Charts draw from a fixed series palette that stays distinct from the
 *   accent and from itself in light and dark.
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { BlockArg, BlockNode } from './catalog.ts';
import { parseBlock, type ParsedBlock } from './parse.ts';
import { Bar, Badge, Box, Button, Callout, Disclosure, Dot, Floating, Input, Row, Slider, Tile, Textarea } from '../../components/ui/primitives.tsx';
import { renderMarkdown } from '../markdown-lite.tsx';

/**
 * Chart series colours, kept apart from each other and from the accent in
 * both light and dark, so two series of a chart never blur together.
 */
const SERIES_LIGHT = ['#4d7fb3', '#5f9e54', '#b8863b', '#c96a52', '#8f7f4e', '#7a6fae'];
const SERIES_DARK = ['#5aa9d9', '#81af6c', '#c2974d', '#d8886d', '#d29470', '#a99ae0'];

export function seriesColor(index: number, dark = false): string {
  const set = dark ? SERIES_DARK : SERIES_LIGHT;
  return set[index % set.length] ?? '#000000';
}

export type BlockAnswer = { values?: Record<string, string>; chosen?: Record<string, string[]>; note?: string };

export type BlockHost = {
  /** True while the reply is still being written. */
  streaming?: boolean;
  /** What the reader answered, read back when the reply is shown again. */
  answered?: BlockAnswer | null;
  /** Send an answer. Without it the block is read-only. */
  submit?: (answer: BlockAnswer, summary: string) => void;
};

/** Draws one block from an assistant reply. */
export function UiBlock({ source, host }: { source: string; host: BlockHost }): ReactNode {
  const parsed = useMemo(() => parseBlock(source, { streaming: host.streaming === true }), [source, host.streaming]);
  if (parsed.kind === 'empty') return null;
  if (parsed.kind === 'invalid') return <BlockSource source={source} errors={parsed.errors.map((error) => error.message)} />;
  if (host.streaming !== true && !parsed.complete) return <BlockSource source={source} errors={['the block is not finished']} />;
  return <BlockBody parsed={parsed} host={host} />;
}

function BlockSource({ source, errors }: { source: string; errors: string[] }): ReactNode {
  return (
    <div className="my-[var(--space-3)] flex flex-col gap-[var(--space-1)]" data-testid="block-source">
      <pre className="rounded-[var(--radius-card)] bg-card p-[var(--space-3)] text-[length:var(--type-code)] leading-[var(--type-line)] ui-scroll overflow-auto"><code>{source}</code></pre>
      <div className="flex flex-col gap-0.5 text-[length:var(--type-micro)] text-tone-error">
        {errors.map((message) => <span key={message}>{message}</span>)}
      </div>
    </div>
  );
}

function BlockBody({ parsed, host }: { parsed: Extract<ParsedBlock, { kind: 'block' }>; host: BlockHost }): ReactNode {
  const state = useBlockForm(host, parsed);
  return (
    <div className="my-[var(--space-3)] flex flex-col gap-[var(--space-3)]" data-testid="ui-block">
      <NodeTree node={parsed.root} nodes={parsed.nodes} state={state} streaming={host.streaming === true} depth={0} />
      {state.decisions > 0 ? (
        <div className="flex min-h-6 items-center gap-2 text-[length:var(--type-meta)] text-muted-foreground" aria-live="polite">
          {state.sent ? `Answered${state.summary ? `: ${state.summary}` : ''}` : host.submit ? <Button variant="primary" disabled={!state.canSend} onClick={() => state.answer()}>Send</Button> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The answer state every form control in a block shares. */
type BlockFormState = {
  values: Record<string, string>;
  chosen: Record<string, string[]>;
  setValue: (name: string, value: string) => void;
  toggleChoice: (name: string, option: string) => void;
  decisions: number;
  canSend: boolean;
  sent: boolean;
  summary: string;
  answer: () => void;
};

function useBlockForm(host: BlockHost, parsed: Extract<ParsedBlock, { kind: 'block' }>): BlockFormState {
  const answered = host.answered ?? null;
  const [values, setValues] = useState<Record<string, string>>(() => answered?.values ?? {});
  const [chosen, setChosen] = useState<Record<string, string[]>>(() => answered?.chosen ?? {});
  const [sent, setSent] = useState(answered !== null);
  const decisions = useMemo(() => decisionNames(parsed), [parsed]);
  // A decision is answerable when every field and every choice has an answer.
  const canSend = decisions.length > 0 && decisions.every(({ name, node }) =>
    node.typeName === 'Choice' || node.typeName === 'Slider' ? (chosen[name]?.length ?? 0) > 0 || (node.typeName === 'Slider' && (values[name]?.trim().length ?? 0) > 0) : (values[name]?.trim().length ?? 0) > 0);
  const summary = useMemo(() => {
    const parts: string[] = [];
    for (const { name, node } of decisions) {
      if (node.typeName === 'Choice') {
        const picked = chosen[name] ?? [];
        if (picked.length > 0) parts.push(picked.join(', '));
      } else if (values[name]?.trim()) {
        parts.push(values[name]);
      } else if (node.typeName === 'Button') {
        parts.push(stringArg(node.args[0]));
      }
    }
    return parts.join('; ');
  }, [decisions, chosen, values]);
  return {
    values,
    chosen,
    setValue: (name, value) => setValues((current) => ({ ...current, [name]: value })),
    toggleChoice: (name, option) => setChosen((current) => {
      const picked = current[name] ?? [];
      const node = parsed.nodes.get(name);
      const multiple = node !== undefined && node.args[3]?.kind === 'boolean' && node.args[3].value === true;
      const next = multiple
        ? (picked.includes(option) ? picked.filter((item) => item !== option) : [...picked, option])
        : (picked.includes(option) ? [] : [option]);
      return { ...current, [name]: next };
    }),
    decisions: decisions.length,
    canSend,
    sent,
    summary,
    answer: () => {
      if (!canSend || sent) return;
      setSent(true);
      host.submit?.({ values, chosen, ...(host.answered?.note ? { note: host.answered.note } : {}) }, summary);
    },
  };
}

/**
 * The names of every decision in a block, found by walking the tree: a
 * decision is usually written inline inside a stack, not as its own statement.
 */
function decisionNames(parsed: Extract<ParsedBlock, { kind: 'block' }>): Array<{ name: string; node: BlockNode }> {
  const out: Array<{ name: string; node: BlockNode }> = [];
  const seen = new Set<BlockNode>();
  const visit = (node: BlockNode): void => {
    if (seen.has(node)) return;
    seen.add(node);
    if (node.typeName === 'Choice' || node.typeName === 'Input' || node.typeName === 'Slider' || node.typeName === 'Button') {
      const name = node.typeName === 'Button' ? stringArg(node.args[2]) : stringArg(node.args[0]);
      if (name.length > 0) out.push({ name, node });
    }
    for (const arg of node.args) {
      if (arg.kind === 'node') visit(arg.node);
      if (arg.kind === 'name') { const named = parsed.nodes.get(arg.name); if (named) visit(named); }
      if (arg.kind === 'array') {
        for (const item of arg.items) {
          if (item.kind === 'node') visit(item.node);
          if (item.kind === 'name') { const named = parsed.nodes.get(item.name); if (named) visit(named); }
        }
      }
    }
  };
  visit(parsed.root);
  return out;
}

type TreeProps = { node: BlockNode; nodes: Map<string, BlockNode>; state: BlockFormState; streaming: boolean; depth: number };

function NodeTree({ node, nodes, state, streaming, depth }: TreeProps): ReactNode {
  if (depth > 32) return null;
  switch (node.typeName) {
    case 'Stack':
      return <div className="flex flex-col gap-[var(--space-3)]">{renderChildren(node.args[0], nodes, state, streaming, depth)}</div>;
    case 'Row':
      return <div className="flex flex-wrap items-stretch gap-[var(--space-3)]">{renderChildren(node.args[0], nodes, state, streaming, depth)}</div>;
    case 'Text':
      return <div className="flex flex-col gap-[var(--space-1)]">{renderMarkdown(stringArg(node.args[0]))}</div>;
    case 'Card':
      return (
        <Box>
          {stringArg(node.args[0]).length > 0 ? <div className="mb-[var(--space-2)] font-medium">{renderMarkdown(stringArg(node.args[0]))}</div> : null}
          <div className="flex flex-col gap-[var(--space-2)]">{renderChildren(node.args[1], nodes, state, streaming, depth)}</div>
        </Box>
      );
    case 'Tabs':
      return <Tabs node={node} nodes={nodes} state={state} streaming={streaming} depth={depth} />;
    case 'Tab':
      return <div className="flex flex-col gap-[var(--space-2)]">{renderChildren(node.args[1], nodes, state, streaming, depth)}</div>;
    case 'Details':
      return <Details node={node} nodes={nodes} state={state} streaming={streaming} depth={depth} />;
    case 'Badge':
      return <Badge label={stringArg(node.args[0])} tone={toneArg(node.args[1])} />;
    case 'Callout':
      return <Callout tone={toneArg(node.args[1]) ?? 'info'} title={stringArg(node.args[2]) || undefined}>{renderMarkdown(stringArg(node.args[0]))}</Callout>;
    case 'KeyValue':
      return <div className="flex flex-col gap-[var(--space-1)]">{keyValues(node.args[0]).map((entry) => <Row key={entry.label} label={entry.label} value={entry.value} />)}</div>;
    case 'Table':
      return <BlockTable columns={stringList(node.args[0])} rows={rowsList(node.args[1])} />;
    case 'Stat':
      return <StatCard node={node} />;
    case 'Progress':
      return <ProgressRow node={node} />;
    case 'BarChart':
      return <BarChart node={node} />;
    case 'LineChart':
      return <LineChart node={node} />;
    case 'Series':
      return null;
    case 'Choice':
      return <ChoiceControl node={node} state={state} />;
    case 'Input':
      return <InputControl node={node} state={state} />;
    case 'Slider':
      return <SliderControl node={node} state={state} />;
    case 'Button':
      return <Button variant={stringArg(node.args[1]) === 'primary' ? 'primary' : 'secondary'} disabled={state.sent} onClick={() => state.answer()}>{stringArg(node.args[0])}</Button>;
    case 'Steps':
      return <Steps node={node} />;
    default:
      return null;
  }
}

function Steps({ node }: { node: BlockNode }): ReactNode {
  const rows = node.args[0]?.kind === 'array' ? node.args[0].items : [];
  const row = stringArg(node.args[1]) === 'row';
  return (
    <div className={row ? 'flex flex-wrap items-stretch gap-[var(--space-2)]' : 'flex flex-col gap-[var(--space-2)]'} data-testid="block-steps">
      {rows.flatMap((entry) => {
        if (entry.kind !== 'object') return [];
        const title = stringArg(entry.entries.title);
        const status = stringArg(entry.entries.status);
        const tone = status === 'done' ? 'success' : status === 'current' ? 'info' : status === 'blocked' ? 'error' : 'neutral';
        const detail = stringArg(entry.entries.markdown);
        return [(
          <div key={title} className="flex min-w-[8rem] flex-col gap-[var(--space-1)]" data-status={status || undefined}>
            <div className="flex items-center gap-[var(--space-2)]"><Dot color={`var(--tone-${tone === 'neutral' ? 'info' : tone})`} /><span className="font-medium">{title}</span></div>
            {detail.length > 0 ? <div className="text-[length:var(--type-micro)] text-muted-foreground">{renderMarkdown(detail)}</div> : null}
            {row ? null : <span className="text-[length:var(--type-micro)] text-muted-foreground">{status || 'todo'}</span>}
          </div>
        )];
      })}
    </div>
  );
}

function renderChildren(arg: BlockArg | undefined, nodes: Map<string, BlockNode>, state: BlockFormState, streaming: boolean, depth: number): ReactNode[] {
  if (arg === undefined) return [];
  const items = arg.kind === 'array' ? arg.items : [];
  return items.map((item, index) => <NodeTree key={index} node={resolveArg(item, nodes)} nodes={nodes} state={state} streaming={streaming} depth={depth + 1} />);
}

/** A name resolves to its statement; an inline call is its own node. */
function resolveArg(arg: BlockArg, nodes: Map<string, BlockNode>): BlockNode {
  if (arg.kind === 'node') return arg.node;
  if (arg.kind === 'name') return nodes.get(arg.name) ?? { typeName: 'Stack', args: [], offset: 0 };
  return { typeName: 'Stack', args: [], offset: 0 };
}

function stringArg(arg: BlockArg | undefined): string {
  if (arg === undefined) return '';
  if (arg.kind === 'string') return arg.value;
  if (arg.kind === 'number') return String(arg.value);
  return '';
}

function numberArg(arg: BlockArg | undefined): number | null {
  return arg !== undefined && arg.kind === 'number' ? arg.value : null;
}

function toneArg(arg: BlockArg | undefined): 'neutral' | 'info' | 'success' | 'warning' | 'error' | undefined {
  const value = stringArg(arg);
  return value === 'info' || value === 'success' || value === 'warning' || value === 'error' ? value : 'neutral';
}

function stringList(arg: BlockArg | undefined): string[] {
  if (arg === undefined || arg.kind !== 'array') return [];
  return arg.items.map((item) => (item.kind === 'array' ? '' : stringArg(item)));
}

function keyValues(arg: BlockArg | undefined): Array<{ label: string; value: string }> {
  if (arg === undefined || arg.kind !== 'array') return [];
  return arg.items.flatMap((item) => {
    if (item.kind !== 'object') return [];
    const label = stringArg(item.entries.label);
    return label.length > 0 ? [{ label, value: stringArg(item.entries.value) }] : [];
  });
}

function rowsList(arg: BlockArg | undefined): string[][] {
  if (arg === undefined || arg.kind !== 'array') return [];
  return arg.items.flatMap((row) => (row.kind === 'array' ? [row.items.map((cell) => stringArg(cell))] : []));
}

function Tabs({ node, nodes, state, streaming, depth }: { node: BlockNode } & Omit<TreeProps, 'node'>): ReactNode {
  const tabs = (node.args[0]?.kind === 'array' ? node.args[0].items : []).flatMap((item) => {
    const resolved = resolveArg(item, nodes);
    return resolved.typeName === 'Tab' ? [{ label: stringArg(resolved.args[0]), node: resolved }] : [];
  });
  const [active, setActive] = useState(0);
  const current = tabs[Math.min(active, tabs.length - 1)];
  if (tabs.length === 0) return null;
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <div className="flex flex-wrap gap-[var(--space-1)]">
        {tabs.map((tab, index) => (
          <Tile key={tab.label + index} chosen={index === active} onClick={() => setActive(index)}>{tab.label}</Tile>
        ))}
      </div>
      <Box>{current ? <NodeTree node={current.node} nodes={nodes} state={state} streaming={streaming} depth={depth + 1} /> : null}</Box>
    </div>
  );
}

function Details({ node, nodes, state, streaming, depth }: { node: BlockNode } & Omit<TreeProps, 'node'>): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure title={renderMarkdown(stringArg(node.args[0]))} open={open} onToggle={() => setOpen(!open)}>
      {renderChildren(node.args[1], nodes, state, streaming, depth + 1)}
    </Disclosure>
  );
}

function ChoiceControl({ node, state }: { node: BlockNode; state: BlockFormState }): ReactNode {
  const name = stringArg(node.args[0]);
  const label = stringArg(node.args[2]);
  const multiple = node.args[3]?.kind === 'boolean' && node.args[3].value === true;
  const options = node.args[1]?.kind === 'array' ? node.args[1].items : [];
  const picked = state.chosen[name] ?? [];
  return (
    <div className="flex flex-col gap-[var(--space-1)]" role={multiple ? 'group' : 'radiogroup'} aria-label={label || name}>
      {label.length > 0 ? <div className="ui-field-label text-foreground">{renderMarkdown(label)}</div> : null}
      {options.map((option, index) => {
        const description = option.kind === 'object' ? stringArg(option.entries.description) : '';
        const text = option.kind === 'object' ? stringArg(option.entries.label) : stringArg(option);
        return (
          <Tile key={text + index} chosen={picked.includes(text)} disabled={state.sent} onClick={() => state.toggleChoice(name, text)} className="flex-col items-start">
            <span>{text}</span>
            {description.length > 0 ? <span className="text-[length:var(--type-micro)] text-muted-foreground">{description}</span> : null}
          </Tile>
        );
      })}
    </div>
  );
}

function InputControl({ node, state }: { node: BlockNode; state: BlockFormState }): ReactNode {
  const name = stringArg(node.args[0]);
  const label = stringArg(node.args[1]);
  const placeholder = stringArg(node.args[2]);
  const multiline = node.args[3]?.kind === 'boolean' && node.args[3].value === true;
  return (
    <label className="flex flex-col gap-[var(--space-1)]">
      {label.length > 0 ? <span className="ui-field-label text-foreground">{label}</span> : null}
      {multiline
        ? <Textarea aria-label={label || name} placeholder={placeholder} disabled={state.sent} value={state.values[name] ?? ''} onChange={(event) => state.setValue(name, event.target.value)} />
        : <Input aria-label={label || name} placeholder={placeholder} disabled={state.sent} value={state.values[name] ?? ''} onChange={(event) => state.setValue(name, event.target.value)} />}
    </label>
  );
}

function SliderControl({ node, state }: { node: BlockNode; state: BlockFormState }): ReactNode {
  const name = stringArg(node.args[0]);
  const min = numberArg(node.args[1]) ?? 0;
  const max = numberArg(node.args[2]) ?? 100;
  const label = stringArg(node.args[3]);
  const current = Number(state.values[name] ?? numberArg(node.args[5]) ?? min);
  return (
    <label className="flex flex-col gap-[var(--space-1)]">
      <span className="ui-field-label text-foreground">{label.length > 0 ? label : name} <span className="tabular-nums text-muted-foreground">{current}</span></span>
      <Slider aria-label={label || name} min={min} max={max} step={numberArg(node.args[4]) ?? 1} value={current} disabled={state.sent} onChange={(event) => state.setValue(name, event.target.value)} />
    </label>
  );
}

function StatCard({ node }: { node: BlockNode }): ReactNode {
  const label = stringArg(node.args[0]);
  const value = numberArg(node.args[1]);
  const delta = stringArg(node.args[2]);
  return (
    <Box className="min-w-[10rem]">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="text-[length:var(--type-meta)] text-muted-foreground">{label}</span>
        <span className="text-[length:var(--type-page-title)] font-semibold tabular-nums">{value === null ? '—' : value.toLocaleString()}</span>
        {delta.length > 0 ? <Badge label={delta} tone={toneArg(node.args[3])} /> : null}
      </div>
    </Box>
  );
}

function ProgressRow({ node }: { node: BlockNode }): ReactNode {
  const label = stringArg(node.args[0]);
  const value = numberArg(node.args[1]) ?? 0;
  const max = numberArg(node.args[2]) ?? 100;
  return (
    <div className="flex flex-col gap-[var(--space-1)]">
      <Row label={label} value={`${Math.round(value)} / ${Math.round(max)}`} />
      <Bar value={value} max={max} />
    </div>
  );
}

function BlockTable({ columns, rows }: { columns: string[]; rows: string[][] }): ReactNode {
  if (columns.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] ui-scroll">
      <table className="w-full border-collapse text-[length:var(--type-meta)]">
        <thead>
          <tr>{columns.map((column) => <th key={column} className="px-[var(--space-2)] py-[var(--space-1)] text-left font-medium text-muted-foreground">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border/40">
              {columns.map((column, cell) => <td key={column + cell} className="px-[var(--space-2)] py-[var(--space-1)] align-top">{row[cell] ?? ''}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function seriesOf(node: BlockNode): Array<{ name: string; values: number[] }> {
  const items = node.args[1]?.kind === 'array' ? node.args[1].items : [];
  return items.flatMap((item) => {
    const series = item.kind === 'node' ? item.node : null;
    if (series === null || series.typeName !== 'Series') return [];
    const values = series.args[1]?.kind === 'array'
      ? series.args[1].items.map((cell) => (cell.kind === 'number' ? cell.value : 0))
      : [];
    return [{ name: stringArg(series.args[0]), values }];
  });
}

function BarChart({ node }: { node: BlockNode }): ReactNode {
  const labels = stringList(node.args[0]);
  const series = seriesOf(node);
  const points = series.flatMap((item) => item.values);
  if (labels.length === 0 || points.length === 0) return null;
  const scale = Math.max(1, ...points);
  return (
    <Box>
      <div className="flex flex-col gap-[var(--space-2)]">
        {series.length > 1 ? <SeriesLegend series={series.map((item) => item.name)} /> : null}
        {labels.map((label, index) => (
          <div key={label + index} className="flex flex-col gap-0.5">
            <Row label={label} value={series.map((item) => item.values[index] ?? 0).join(' / ')} />
            <div className="flex flex-col gap-0.5">
              {series.map((item, seriesIndex) => (
                <Bar key={item.name + seriesIndex} value={item.values[index] ?? 0} max={scale} color={seriesColor(seriesIndex)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Box>
  );
}

function LineChart({ node }: { node: BlockNode }): ReactNode {
  const labels = stringList(node.args[0]);
  const series = seriesOf(node);
  const points = series.flatMap((item) => item.values);
  if (labels.length === 0 || points.length === 0) return null;
  const max = Math.max(1, ...points);
  const width = 320;
  const height = 96;
  const step = labels.length > 1 ? width / (labels.length - 1) : width;
  return (
    <Box>
      <div className="flex flex-col gap-[var(--space-2)]">
        {series.length > 1 ? <SeriesLegend series={series.map((item) => item.name)} /> : null}
        <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" role="img" aria-label="Line chart">
          {series.map((item, seriesIndex) => {
            const path = item.values.map((value, index) => `${index === 0 ? 'M' : 'L'}${index * step}.0,${height - (value / max) * height}`).join(' ');
            return <path key={item.name + seriesIndex} d={path} fill="none" stroke={seriesColor(seriesIndex)} strokeWidth={2} strokeLinejoin="round" />;
          })}
        </svg>
        <div className="flex flex-wrap gap-[var(--space-2)] text-[length:var(--type-micro)] text-muted-foreground">
          {labels.map((label) => <span key={label}>{label}</span>)}
        </div>
      </div>
    </Box>
  );
}

function SeriesLegend({ series }: { series: string[] }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-[var(--space-3)] text-[length:var(--type-micro)] text-muted-foreground">
      {series.map((name, index) => (
        <span key={name + index} className="inline-flex items-center gap-1"><Dot color={seriesColor(index)} />{name}</span>
      ))}
    </div>
  );
}

export type { BlockArg, BlockNode };
