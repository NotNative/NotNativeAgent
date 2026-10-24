// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectProductionSources } from './source-catalog.js';
import { auditDependencyRegistry } from './dependency-registry-gate.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_FILE_LINES = 500;
const MAX_FUNCTION_LINES = 60;
const MAX_SOURCE_BYTES = 400_000;
const TS_CONFIGS = ['packages/ui/tsconfig.json', 'packages/web/tsconfig.ui.json', 'packages/web/tsconfig.server.json'];
const SPDX_TOKEN = 'SPDX-License-Identifier: Apache-2.0';

async function main() {
  const files = await collectProductionSources(root);
  const errors = [];
  for (const path of files) {
    const label = relative(root, path).replaceAll('\\', '/');
    let source;
    try { source = await readFile(path, 'utf8'); }
    catch (error) { errors.push(`${label} could not be read: ${error.code ?? error.message}`); continue; }
    auditFile(label, source, errors);
    if (/\.(m?js)$/u.test(path)) checkSyntaxNative(path, errors);
  }
  await runTypeScriptCompiles(errors);
  await auditDependencyRegistry(root, errors);
  spawnGate('scripts/repository-graph.js', ['--check'], 'repository graph check failed', errors);
  spawnGate('scripts/controlled-language-gates.js', [], 'controlled-language check failed', errors);
  finishGate(files, errors);
}

function finishGate(files, errors) {
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`quality gates passed for ${files.length} production files\n`);
  }
}

function auditFile(label, source, errors) {
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_FILE_LINES) errors.push(`${label} has ${lines.length} lines (max ${MAX_FILE_LINES})`);
  if (source.length > MAX_SOURCE_BYTES) errors.push(`${label} is ${source.length} bytes (max ${MAX_SOURCE_BYTES})`);
  if (lines.some((line) => /[ \t]+$/u.test(line))) errors.push(`${label} has trailing whitespace`);
  if (!source.includes(SPDX_TOKEN)) errors.push(`${label} lacks SPDX identifier`);
  // Encoding incident guard (P2/P5-6 history): CP1252-misread UTF-8 remnants.
  if (/\u00C2[\u0080-\u00BF]|\u00E2\u20AC/u.test(source)) errors.push(`${label} has CP1252-mojibake sequences (encoding incident)`);
  const clean = lines.map((line) => blankLine(line));
  for (const span of functionSpans(clean)) {
    if (span.length > MAX_FUNCTION_LINES) {
      errors.push(`${label}:${span.start} function has ${span.length} lines (max ${MAX_FUNCTION_LINES})`);
    }
  }
}

function checkSyntaxNative(path, errors) {
  const label = relative(root, path).replaceAll('\\', '/');
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`${label} fails node --check: ${failureText(checked)}`);
}

async function runTypeScriptCompiles(errors) {
  for (const config of TS_CONFIGS) {
    const tsc = resolveTypeScriptBinary(join(root, config, '..'));
    if (!tsc) { errors.push(`typescript binary not found for ${config}`); continue; }
    const result = spawnSync(process.execPath, [tsc, '-p', join(root, config), '--noEmit'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) errors.push(`tsc ${config} failed: ${failureText(result)}`);
  }
}

function spawnGate(script, args, label, errors) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) errors.push(`${label}: ${failureText(result)}`);
  else if (result.stdout) process.stdout.write(result.stdout);
}

function resolveTypeScriptBinary(startDir) {
  for (let dir = startDir; ; dir = resolve(dir, '..')) {
    const candidate = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    if (dir === resolve(dir, '..')) return null;
  }
}

function failureText(result) {
  if (result.error) return `${result.error.code ?? 'spawn_failed'}: ${result.error.message}`;
  if (result.signal) return `terminated by ${result.signal}`;
  return String(result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`).trim();
}

// ── noise blanking + function span detection (TS/TSX heuristic, bounded) ─────

function blankLine(line) {
  const out = [];
  let mode = 'code';
  let index = 0;
  while (index < line.length) {
    if (mode === 'code') {
      const ch = line[index];
      const next = line[index + 1];
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') { mode = 'block'; out.push(' ', ' '); index += 2; continue; }
      if (isQuote(ch) || startsRegexLiteral(line, index, out)) { mode = ch === "'" || ch === '"' || ch === '`' ? ch : 'regex'; out.push(' '); index += 1; continue; }
      out.push(ch);
      index += 1;
      continue;
    }
    const consumed = skipMode(mode, line, index);
    for (let i = 0; i < consumed; i += 1) out.push(' ');
    if (consumed === 0) {
      out.push(' ');
      index += 1;
    } else {
      index += consumed;
      mode = 'code';
    }
  }
  return out.join('');
}

function skipMode(mode, line, index) {
  const ch = line[index];
  const next = line[index + 1];
  if (mode === 'block') return ch === '*' && next === '/' ? 2 : ch === '\n' ? 1 : 1;
  if (mode === 'regex') return regexEnds(line, index) ? 1 : 1;
  return ch === mode ? 1 : 1;
}

function isQuote(ch) {
  return ch === "'" || ch === '"' || ch === '`';
}

const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', ';', '[', '{', '(', ' ', '']);

function startsRegexLiteral(line, index, out) {
  if (line[index] !== '/') return false;
  const before = [];
  for (let i = out.length - 1; i >= 0 && before.length < 16; i -= 1) before.push(out[i]);
  const previous = before.join('').replace(/\s+$/u, '').at(-1);
  if (!previous) return true;
  if (/[\w.\)\]]$/u.test(previous)) return false;
  if (REGEX_PRECEDERS.has(previous)) return true;
  const statement = /^.*\b(return|case|typeof|delete|in|of|new|instanceof|await)(\s*)$/u.exec(('\n' + out.join('')));
  return Boolean(statement);
}

function regexEnds(line, index) {
  let escaped = false;
  let inClass = false;
  for (let i = index + 1; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return true;
  }
  return false;
}

function functionSpans(clean) {
  const spans = [];
  for (let index = 0; index < clean.length; index += 1) {
    if (!looksLikeFunctionStart(clean[index])) continue;
    const length = blockLengthFrom(clean, index);
    if (length > 0) spans.push({ start: index + 1, length });
  }
  return spans;
}

const TYPELIKE_PREFIX = /^\s*(?:export\s+)?(?:type\s|interface\s|enum\s)/u;
const DECORATED = /^(?:(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b)/u;
const CONST_ARROW = /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^;{}]*\)|[A-Za-z_$][\w$]*)\s*=>/u;
const METHOD_SHAPE = /^\s*(?:(?:public|private|protected|static|get|set|override)\s+)*(?:async\s+)?(?:\*?)(?:constructor\b|[A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s[^{;]+)?\s*\{/u;
const PROP_ARROW = /^\s*(?:public|private|protected|readonly|static)?\s*[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^;{}]*\)\s*(?::\s[^=;{]+)?\s*=>/u;

function looksLikeFunctionStart(line) {
  if (/^\s*(?:if|for|while|switch|catch|with)\s*\(/u.test(line)) return false;
  if (TYPELIKE_PREFIX.test(line)) return false;
  if (DECORATED.test(line)) return true;
  if (CONST_ARROW.test(line) && line.includes('{', line.indexOf('=>'))) return true;
  if (METHOD_SHAPE.test(line) || PROP_ARROW.test(line)) return true;
  return false;
}

function blockLengthFrom(clean, start) {
  let depth = 0;
  let opened = false;
  for (let index = start; index < clean.length; index += 1) {
    for (const character of clean[index]) {
      if (character === '{') { depth += 1; opened = true; }
      if (character === '}') depth -= 1;
    }
    if (opened && depth <= 0) return index - start + 1;
  }
  return 0;
}

main().catch((error) => {
  process.stderr.write(`quality gates failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
