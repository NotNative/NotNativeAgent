// SPDX-License-Identifier: Apache-2.0
/**
 * Block kit parser (docs/planning/desktop-ui-visual-system.md §6.6).
 *
 * The language is one statement per line: `name = Component(args)`, with the
 * root required to be a stack. It is parsed by hand, without a dependency,
 * because the grammar is deliberately tiny and a reply streams into it.
 *
 * Invariants:
 * - Parsing never throws. A block that cannot be drawn returns its errors and
 *   no root, and the reader sees the source.
 * - While a block streams, a statement whose text is cut mid-value is kept as
 *   `complete: false` with the props that did parse; the renderer draws what it
 *   can and a node that never parsed draws nothing. A finished block with any
 *   incomplete statement is an error.
 * - A block with a parse error, an undefined or unused name, state, a query, or
 *   no stack root draws nothing.
 */
import { COMPONENTS, ROOT_COMPONENT, componentNamed, type BlockArg, type BlockNode, type ComponentSpec } from './catalog.ts';

export type BlockError = { code: string; message: string; offset: number };

export type ParsedBlock =
  | { kind: 'empty' }
  | { kind: 'invalid'; errors: BlockError[] }
  | { kind: 'block'; root: BlockNode; nodes: Map<string, BlockNode>; complete: boolean };

export type ParseOptions = {
  /** True while the reply is still being written. */
  streaming?: boolean;
};

const MAX_DEPTH = 32;

/**
 * The character at an index, or an empty string past the end. The parser reads
 * ahead of the end while a call is still open; an empty character then simply
 * matches no token.
 */
function at(text: string, index: number): string {
  return text[index] ?? '';
}

/**
 * Parse one block source. `streaming` relaxes only incomplete statements: a
 * statement cut mid-value is kept with what did parse.
 */
export function parseBlock(source: string, options: ParseOptions = {}): ParsedBlock {
  const text = source.trim();
  if (text.length === 0) return { kind: 'empty' };
  const errors: BlockError[] = [];
  const nodes = new Map<string, BlockNode>();
  let complete = true;
  const lines = splitStatements(source);
  for (const statement of lines) {
    if (statement.text.trim().length === 0) continue;
    if (statement.comment) continue;
    const parsed = parseStatement(statement.text, statement.offset);
    if (parsed.error) {
      // A statement whose brackets are still open is unterminated, not a
      // syntax error, whatever the inner parser reported about its tail.
      const code = statement.open ? 'unterminated' : parsed.error.code;
      if (code === 'unterminated' && options.streaming) {
        complete = false;
        if (parsed.partial) nodes.set(parsed.partial.name, parsed.partial.node);
        continue;
      }
      errors.push({ ...parsed.error, code });
      continue;
    }
    if (statement.open) {
      if (options.streaming) { complete = false; nodes.set(parsed.name, parsed.node); continue; }
      errors.push({ code: 'unterminated', message: `"${parsed.name}" is not closed`, offset: statement.offset });
      continue;
    }
    if (nodes.has(parsed.name)) {
      errors.push({ code: 'duplicate-name', message: `"${parsed.name}" is defined twice`, offset: statement.offset });
      continue;
    }
    nodes.set(parsed.name, parsed.node);
  }
  if (errors.length > 0) return { kind: 'invalid', errors };
  const root = nodes.get('root');
  if (!root) {
    if (options.streaming) return { kind: 'empty' };
    return { kind: 'invalid', errors: [{ code: 'no-root', message: 'no "root" statement', offset: 0 }] };
  }
  if (root.typeName !== ROOT_COMPONENT) {
    return { kind: 'invalid', errors: [{ code: 'bad-root', message: `root must be ${ROOT_COMPONENT}`, offset: root.offset }] };
  }
  errors.push(...reachabilityErrors(nodes, root));
  if (errors.length > 0) return { kind: 'invalid', errors };
  return { kind: 'block', root, nodes, complete };
}

type Statement = { text: string; offset: number; comment: boolean; open: boolean };

/**
 * Split a source into statements at top-level line breaks: a line break
 * inside a string or inside brackets does not end a statement.
 *
 * A statement whose brackets are still open at the end of the source is kept
 * whole and marked `open`, so a finished block reports it as unterminated and
 * a streaming one keeps what parsed. It is never glued onto the next
 * statement, which would report the next statement's text as a syntax error.
 */
function splitStatements(source: string): Statement[] {
  const out: Statement[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let offset = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = at(source, index);
    if (quote !== null) {
      current += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
    if (char === '\n' && depth === 0) {
      out.push({ text: current, offset, comment: current.trimStart().startsWith('#'), open: false });
      current = '';
      offset = index + 1;
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    out.push({ text: current, offset, comment: current.trimStart().startsWith('#'), open: depth > 0 || quote !== null });
  }
  return out;
}

type StatementResult =
  | { name: string; node: BlockNode; error?: undefined; partial?: undefined }
  | { partial?: { name: string; node: BlockNode }; name?: undefined; node?: undefined; error: BlockError };

/**
 * Capture 1 of a regex whose first group is mandatory. The parser's patterns
 * all make group 1 required, so this only states that to the type checker.
 */
function captured(match: RegExpExecArray): string {
  return match[1] ?? '';
}

/** The whole match of a pattern without a capture group. */
function matched(match: RegExpExecArray): string {
  return match[0];
}

function parseStatement(text: string, offset: number): StatementResult {
  const trimmed = text.trim();
  const assignment = /^([A-Za-z][A-Za-z0-9_]*)\s*=\s*/u.exec(trimmed);
  if (!assignment) {
    return { error: { code: 'syntax', message: 'expected "name = Component(...)"', offset } };
  }
  const name = captured(assignment);
  const rest = trimmed.slice(assignment[0].length);
  const call = /^([A-Za-z][A-Za-z0-9_]*)\s*\(/u.exec(rest);
  if (!call) {
    // A statement still being written has its call open or absent; either way
    // it is not closed yet, which streaming tolerates.
    const bare = /^([A-Za-z][A-Za-z0-9_]*)$/u.exec(rest.trim());
    const partialName = bare === null ? undefined : captured(bare);
    if (partialName !== undefined && componentNamed(partialName) !== undefined) {
      return {
        error: { code: 'unterminated', message: `"${name}" is not assigned a closed component call`, offset },
        partial: { name, node: { typeName: partialName, args: [], offset } },
      };
    }
    return { error: { code: 'unterminated', message: `"${name}" is not assigned a closed component call`, offset } };
  }
  const typeName = captured(call);
  const spec = componentNamed(typeName);
  if (!spec) {
    return { error: { code: 'unknown-component', message: `unknown component "${typeName}"`, offset } };
  }
  // The open paren is the character after the component name.
  const parenIndex = assignment[0].length + typeName.length;
  const parsed = parseArguments(trimmed, parenIndex + 1, offset + parenIndex);
  if (parsed.error) {
    // A partial node keeps the arguments that did parse, uncoerced: an
    // unfinished call is not yet an arity error, and the renderer reads only
    // the fields present.
    const partial: { name: string; node: BlockNode } | undefined = parsed.args.length > 0
      ? { name, node: { typeName, args: parsed.args, offset } }
      : undefined;
    return { error: parsed.error, partial };
  }
  const coerced = coerceArgs(spec, parsed.args);
  if (typeof coerced === 'string') return { error: { code: 'arity', message: coerced, offset } };
  return { name, node: { typeName, args: coerced, offset } };
}

type ArgumentResult = { args: BlockArg[]; error?: undefined } | { args: BlockArg[]; error: BlockError };

function parseArguments(text: string, start: number, offset: number): ArgumentResult {
  const args: BlockArg[] = [];
  let index = start;
  const skip = (): void => { while (index < text.length && /\s/u.test(at(text, index))) index += 1; };
  for (;;) {
    skip();
    if (index >= text.length) {
      return { args, error: { code: 'unterminated', message: 'the call is not closed', offset: offset + index } };
    }
    if (at(text, index) === ')') {
      return { args };
    }
    const value = parseValue(text, index, 0);
    if (value.error) return { args, error: value.error };
    args.push(value.value);
    index = value.next;
    skip();
    if (at(text, index) === ',') { index += 1; continue; }
    if (at(text, index) === ')') continue;
    if (index < text.length) continue;
    return { args, error: { code: 'unterminated', message: 'the call is not closed', offset: offset + index } };
  }
}

type ValueResult = { value: BlockArg; next: number; error?: undefined } | { value: BlockArg; next: number; error: BlockError };

function parseValue(text: string, start: number, depth: number): ValueResult {
  if (depth > MAX_DEPTH) {
    return { value: { kind: 'null' }, next: start, error: { code: 'nested-too-deep', message: 'value nests too deeply', offset: start } };
  }
  const char = at(text, start);
  if (char === '"' || char === "'") return parseString(text, start);
  if (char === '[') return parseArray(text, start, depth);
  if (char === '{') return parseObject(text, start, depth);
  const rest = text.slice(start);
  const literal = /^(-?\d+(?:\.\d+)?|true|false|null)/u.exec(rest);
  if (literal) {
    const token = captured(literal);
    const next = start + token.length;
    if (token === 'true') return { value: { kind: 'boolean', value: true }, next };
    if (token === 'false') return { value: { kind: 'boolean', value: false }, next };
    if (token === 'null') return { value: { kind: 'null' }, next };
    return { value: { kind: 'number', value: Number(token) }, next };
  }
  const name = /^([A-Za-z][A-Za-z0-9_]*)\s*(\(?)/u.exec(rest);
  if (name) {
    const componentName = captured(name);
    const afterName = start + componentName.length;
    // A component call is a value: `Card("x", [Text("y")])` nests a statement
    // inline, which is how a block expresses a shape without naming it.
    const spec = componentNamed(componentName);
    if ((name[2] ?? '') === '(') {
      if (spec === undefined) {
        return { value: { kind: 'null' }, next: afterName, error: { code: 'unknown-component', message: `unknown component "${componentName}"`, offset: start } };
      }
      const inner = parseArguments(text, afterName + 1, start);
      if (inner.error) return { value: { kind: 'null' }, next: inner.args.length, error: inner.error };
      const coerced = coerceArgs(spec, inner.args);
      if (typeof coerced === 'string') {
        return { value: { kind: 'null' }, next: indexAfterCall(text, afterName + 1), error: { code: 'arity', message: coerced, offset: start } };
      }
      return {
        value: { kind: 'node', node: { typeName: componentName, args: coerced, offset: start } },
        next: indexAfterCall(text, afterName + 1),
      };
    }
    return { value: { kind: 'name', name: componentName }, next: afterName };
  }
  return { value: { kind: 'null' }, next: start, error: { code: 'syntax', message: `unexpected "${char ?? 'end of call'}"`, offset: start } };
}

/** The index just past the `)` that closes a call opened at `from`. */
function indexAfterCall(text: string, from: number): number {
  let depth = 1;
  let quote: string | null = null;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const char = at(text, index);
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

function parseString(text: string, start: number): ValueResult {
  const quote = at(text, start);
  let index = start + 1;
  let value = '';
  let escaped = false;
  while (index < text.length) {
    const char = at(text, index);
    if (escaped) {
      value += char;
      escaped = false;
      index += 1;
      continue;
    }
    if (char === '\\') { escaped = true; index += 1; continue; }
    if (char === quote) return { value: { kind: 'string', value }, next: index + 1 };
    value += char;
    index += 1;
  }
  return { value: { kind: 'string', value }, next: index, error: { code: 'unterminated', message: 'a string is not closed', offset: start } };
}

function parseArray(text: string, start: number, depth: number): ValueResult {
  const items: BlockArg[] = [];
  let index = start + 1;
  for (;;) {
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    if (index >= text.length) {
      return { value: { kind: 'array', items }, next: index, error: { code: 'unterminated', message: 'a list is not closed', offset: start } };
    }
    if (at(text, index) === ']') return { value: { kind: 'array', items }, next: index + 1 };
    const item = parseValue(text, index, depth + 1);
    if (item.error) return { value: { kind: 'array', items }, next: item.next, error: item.error };
    items.push(item.value);
    index = item.next;
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    if (at(text, index) === ',') { index += 1; continue; }
    if (at(text, index) === ']') continue;
    return { value: { kind: 'array', items }, next: index, error: { code: 'syntax', message: 'expected "," or "]"', offset: index } };
  }
}

function parseObject(text: string, start: number, depth: number): ValueResult {
  const entries: Record<string, BlockArg> = {};
  let index = start + 1;
  for (;;) {
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    if (index >= text.length) {
      return { value: { kind: 'object', entries }, next: index, error: { code: 'unterminated', message: 'an object is not closed', offset: start } };
    }
    if (at(text, index) === '}') return { value: { kind: 'object', entries }, next: index + 1 };
    const key = parseKey(text, index);
    if (key.error) return { value: { kind: 'object', entries }, next: key.next, error: key.error };
    index = key.next;
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    if (at(text, index) !== ':') {
      return { value: { kind: 'object', entries }, next: index, error: { code: 'syntax', message: 'expected ":"', offset: index } };
    }
    // The value starts after the colon, past any space.
    index += 1;
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    const value = parseValue(text, index, depth + 1);
    if (value.error) return { value: { kind: 'object', entries }, next: value.next, error: value.error };
    entries[key.name] = value.value;
    index = value.next;
    while (index < text.length && /\s/u.test(at(text, index))) index += 1;
    if (at(text, index) === ',') { index += 1; continue; }
    if (at(text, index) === '}') continue;
    if (index >= text.length) continue;
    return { value: { kind: 'object', entries }, next: index, error: { code: 'syntax', message: `unexpected "${at(text, index)}"`, offset: index } };
  }
}

type KeyResult = { name: string; next: number; error?: undefined } | { name: string; next: number; error: BlockError };

/** A key: a quoted string or a bare identifier. */
function parseKey(text: string, start: number): KeyResult {
  const char = at(text, start);
  if (char === '"' || char === "'") {
    const parsed = parseString(text, start);
    if (parsed.error) return { name: '', next: parsed.next, error: parsed.error };
    return { name: parsed.value.kind === 'string' ? parsed.value.value : '', next: parsed.next };
  }
  const identifier = /^([A-Za-z_][A-Za-z0-9_-]*)/u.exec(text.slice(start));
  if (identifier === null) {
    return { name: '', next: start, error: { code: 'syntax', message: 'expected a key', offset: start } };
  }
  const name = captured(identifier);
  return { name, next: start + name.length };
}

/**
 * Bind positional arguments to a component's fields. A missing required
 * field, or too many arguments, is an arity error rather than a guess, so a
 * model sees exactly which signature it missed.
 */
function coerceArgs(spec: ComponentSpec, args: BlockArg[]): BlockArg[] | string {
  if (args.length > spec.positional.length) {
    return `${spec.name} takes ${spec.positional.length} arguments but got ${args.length}`;
  }
  const out: BlockArg[] = [];
  let index = 0;
  for (const field of spec.positional) {
    const arg = args[index];
    index += 1;
    if (arg === undefined || arg.kind === 'null') {
      if (field.optional) continue;
      return `${spec.name} is missing its "${field.name}" argument`;
    }
    if (arg.kind === 'node') {
      out.push(arg);
      continue;
    }
    if (field.type === 'children') {
      if (arg.kind !== 'array') return `${spec.name}.${field.name} must be a list`;
      out.push(arg);
      continue;
    }
    if (field.type === 'number' && arg.kind !== 'number') return `${spec.name}.${field.name} must be a number`;
    if ((field.type === 'string' || field.type === 'enum') && arg.kind !== 'string') return `${spec.name}.${field.name} must be a string`;
    if (field.type === 'boolean' && arg.kind !== 'boolean') return `${spec.name}.${field.name} must be true or false`;
    if (arg.kind === 'array') {
      // A list is accepted for columns, rows, labels, values, and options.
      out.push(arg);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * Every named statement must be reachable from the root, through stack, row,
 * card, tabs, and details; and a node may not name itself.
 */
function reachabilityErrors(nodes: Map<string, BlockNode>, root: BlockNode): BlockError[] {
  const errors: BlockError[] = [];
  const seen = new Set<string>();
  const visit = (node: BlockNode, path: Set<string>): void => {
    for (const arg of node.args) {
      if (arg.kind === 'name') {
        const target = nodes.get(arg.name);
        if (!target) {
          errors.push({ code: 'undefined-name', message: `"${arg.name}" is not defined`, offset: node.offset });
          continue;
        }
        if (path.has(arg.name)) {
          errors.push({ code: 'cycle', message: `"${arg.name}" names itself`, offset: node.offset });
          continue;
        }
        seen.add(arg.name);
        visit(target, new Set([...path, arg.name]));
      } else if (arg.kind === 'array') {
        for (const item of arg.items) visit({ typeName: node.typeName, args: [item], offset: node.offset }, path);
      }
    }
  };
  visit(root, new Set(['root']));
  seen.add('root');
  for (const name of nodes.keys()) {
    if (!seen.has(name)) errors.push({ code: 'unused-name', message: `"${name}" is never used`, offset: nodes.get(name)!.offset });
  }
  return errors;
}

/** The component names a source uses, for diagnostics. */
export function usedComponentNames(source: string): string[] {
  return [...source.matchAll(/=\s*([A-Za-z][A-Za-z0-9_]*)\s*\(/gu)].map((match) => captured(match));
}

export { COMPONENTS };










