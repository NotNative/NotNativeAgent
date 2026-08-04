// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, matchesGlob, relative } from 'node:path';
import { ContractError } from './ids.js';

const DEFAULT_SKIPS = new Set(['.git', 'node_modules']);
const MAX_FILES = 10_000;
const MAX_SEARCH_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

export function filesystemDiscoveryDefinitions(paths) {
  return [globDefinition(paths), searchDefinition(paths)];
}

function globDefinition(paths) {
  return {
    name: 'fs.glob', version: 1,
    purpose: 'Discover files by a bounded cross-platform glob. Root NNA may search any host path it can read; hosted sessions remain workspace-bounded.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      pattern: { type: 'string', minLength: 1, maxLength: 1024 },
      max_depth: { type: 'integer', minimum: 0, maximum: 64 },
      max_results: { type: 'integer', minimum: 1, maximum: 1000 },
    }, ['pattern']),
    validate: async (args) => {
      shape(args, ['pattern'], ['path', 'max_depth', 'max_results']);
      requireString(args.pattern, 'pattern');
      const resolved = await paths.resolveDirectory(args.path ?? '.');
      return {
        args: { path: args.path ?? '.', pattern: args.pattern, max_depth: integer(args.max_depth, 32, 0, 64), max_results: integer(args.max_results, 200, 1, 1000) },
        resolved,
      };
    },
    executor: async (request, signal) => {
      const walk = await walkFiles(request.resolved.path, request.args.max_depth, request.args.max_results, signal, (relativePath) => globMatch(relativePath, request.args.pattern));
      return {
        content: walk.files.map((path) => displayPath(request.resolved.path, path)).join('\n') || 'no matching files',
        metadata: { root: request.args.path, pattern: request.args.pattern, matches: walk.files.length, examined: walk.examined, skipped: walk.skipped, truncated: walk.truncated },
      };
    },
  };
}

function searchDefinition(paths) {
  return {
    name: 'fs.search_text', version: 1,
    purpose: 'Search bounded UTF-8 files with line-numbered snippets. Matching is literal by default; set match_mode to regex for expressions such as foo|bar. The runtime may transparently accelerate compatible searches with ripgrep.',
    sideEffect: 'read_only', scope: 'workspace', cancellation: true, timeoutMs: 120_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      query: { type: 'string', minLength: 1, maxLength: 4096 },
      match_mode: { type: 'string', enum: ['literal', 'regex'] },
      file_glob: { type: 'string', minLength: 1, maxLength: 1024 },
      case_sensitive: { type: 'boolean' },
      max_depth: { type: 'integer', minimum: 0, maximum: 64 },
      max_results: { type: 'integer', minimum: 1, maximum: 1000 },
    }, ['query']),
    validate: async (args) => {
      shape(args, ['query'], ['path', 'match_mode', 'file_glob', 'case_sensitive', 'max_depth', 'max_results']);
      requireString(args.query, 'query');
      if (args.match_mode !== undefined && !['literal', 'regex'].includes(args.match_mode)) invalid('match_mode must be literal or regex');
      if (args.file_glob !== undefined) requireString(args.file_glob, 'file_glob');
      if (args.case_sensitive !== undefined && typeof args.case_sensitive !== 'boolean') invalid('case_sensitive must be boolean');
      const resolved = await paths.resolveDirectory(args.path ?? '.');
      return {
        args: {
          path: args.path ?? '.', query: args.query, match_mode: args.match_mode ?? 'literal', file_glob: args.file_glob ?? '**/*',
          case_sensitive: args.case_sensitive ?? false, max_depth: integer(args.max_depth, 32, 0, 64),
          max_results: integer(args.max_results, 200, 1, 1000),
        },
        resolved,
      };
    },
    executor: async (request, signal) => (await ripgrepSearch(request, signal)) ?? searchFiles(request, signal),
  };
}

async function ripgrepSearch(request, signal) {
  const args = ripgrepArguments(request);
  return new Promise((resolve, reject) => {
    let settled = false; let pending = ''; let stderr = ''; let stoppedAtLimit = false;
    const matches = [];
    let child;
    try {
      child = spawn('rg', args, { cwd: request.resolved.path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) { resolve(null); return; }
      reject(error); return;
    }
    const finish = (operation) => {
      if (settled) return; settled = true; signal.removeEventListener('abort', cancel); operation();
    };
    const cancel = () => { child.kill(); finish(() => reject(new ContractError('tool_cancelled', 'tool was cancelled'))); };
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', (error) => {
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) finish(() => resolve(null));
      else finish(() => reject(error));
    });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.stdout.on('data', (chunk) => readRipgrepEvents(chunk, matches, request, child, () => { stoppedAtLimit = true; }, (rest) => { pending = rest; }, pending));
    child.on('close', (code) => finishRipgrep(code, stoppedAtLimit, stderr, matches, request, finish, resolve, reject));
  });
}

function ripgrepArguments(request) {
  return [
    '--json', '--no-config', '--no-ignore', '--color', 'never', '--max-filesize', '1M',
    '--max-depth', String(request.args.max_depth), '--glob', request.args.file_glob,
    '--glob', '!.git/**', '--glob', '!node_modules/**',
    request.args.case_sensitive ? '--case-sensitive' : '--ignore-case',
    ...(request.args.match_mode === 'literal' ? ['--fixed-strings'] : []),
    '--', request.args.query, '.',
  ];
}

function readRipgrepEvents(chunk, matches, request, child, stop, updatePending, prior) {
  const lines = `${prior}${chunk.toString('utf8')}`.split('\n'); updatePending(lines.pop() ?? '');
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'match') continue;
    const data = event.data; const first = data.submatches?.[0];
    const path = String(data.path?.text ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
    const text = String(data.lines?.text ?? '').replace(/\r?\n$/u, '');
    matches.push(`${path}:${data.line_number}:${Number(first?.start ?? 0) + 1}: ${boundedLine(text)}`);
    if (matches.length >= request.args.max_results) { stop(); child.kill(); break; }
  }
}

function finishRipgrep(code, stopped, stderr, matches, request, finish, resolve, reject) {
  if (![0, 1].includes(code) && !stopped) {
    if (/regex parse error|invalid regex/iu.test(stderr)) {
      finish(() => reject(new ContractError('tool_pattern_invalid', 'search regular expression is invalid'))); return;
    }
    finish(() => resolve(null)); return;
  }
  finish(() => resolve({
    content: matches.join('\n') || 'no text matches',
    metadata: { root: request.args.path, query: request.args.query, match_mode: request.args.match_mode, matches: matches.length, backend: 'ripgrep', truncated: stopped },
  }));
}

async function searchFiles(request, signal) {
  const candidates = await walkFiles(request.resolved.path, request.args.max_depth, MAX_FILES, signal,
    (relativePath) => globMatch(relativePath, request.args.file_glob));
  const matches = [];
  let bytesExamined = 0;
  let binarySkipped = 0;
  let oversizedSkipped = 0;
  const matcher = textMatcher(request.args);
  for (const path of candidates.files) {
    abort(signal);
    let info;
    try { info = await stat(path); } catch { continue; }
    if (info.size > MAX_FILE_BYTES) { oversizedSkipped += 1; continue; }
    if (bytesExamined + info.size > MAX_SEARCH_BYTES) break;
    let buffer;
    try { buffer = await readFile(path); } catch { continue; }
    bytesExamined += buffer.length;
    if (buffer.includes(0)) { binarySkipped += 1; continue; }
    const content = buffer.toString('utf8');
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const column = matcher(lines[index]);
      if (column === -1) continue;
      matches.push(`${displayPath(request.resolved.path, path)}:${index + 1}:${column + 1}: ${boundedLine(lines[index])}`);
      if (matches.length >= request.args.max_results) break;
    }
    if (matches.length >= request.args.max_results) break;
  }
  const truncated = matches.length >= request.args.max_results || candidates.truncated || bytesExamined >= MAX_SEARCH_BYTES;
  return {
    content: matches.join('\n') || 'no text matches',
    metadata: {
      root: request.args.path, query: request.args.query, match_mode: request.args.match_mode, matches: matches.length,
      files_examined: candidates.examined, bytes_examined: bytesExamined,
      binary_skipped: binarySkipped, oversized_skipped: oversizedSkipped, inaccessible_skipped: candidates.skipped,
      truncated,
    },
  };
}

function textMatcher(args) {
  if (args.match_mode === 'regex') {
    let expression;
    try { expression = new RegExp(args.query, args.case_sensitive ? 'u' : 'iu'); }
    catch { throw new ContractError('tool_pattern_invalid', 'search regular expression is invalid'); }
    return (line) => expression.exec(line)?.index ?? -1;
  }
  const needle = args.case_sensitive ? args.query : args.query.toLocaleLowerCase();
  return (line) => (args.case_sensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
}

async function walkFiles(root, maxDepth, limit, signal, accept) {
  const files = [];
  const pending = [{ path: root, depth: 0 }];
  let examined = 0;
  let skipped = 0;
  let truncated = false;
  while (pending.length > 0 && examined < MAX_FILES && files.length < limit) {
    abort(signal);
    const current = pending.shift();
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); } catch { skipped += 1; continue; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      abort(signal);
      if (DEFAULT_SKIPS.has(entry.name)) continue;
      const full = join(current.path, entry.name);
      const relativePath = relative(root, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) pending.push({ path: full, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        examined += 1;
        if (accept(relativePath)) files.push(full);
      }
      if (examined >= MAX_FILES || files.length >= limit) { truncated = true; break; }
    }
  }
  if (pending.length > 0) truncated = true;
  return { files, examined, skipped, truncated };
}

function globMatch(relativePath, pattern) {
  try { return matchesGlob(relativePath, pattern.replaceAll('\\', '/')); }
  catch { throw new ContractError('tool_pattern_invalid', 'glob pattern is invalid'); }
}

function displayPath(root, path) {
  return relative(root, path).replaceAll('\\', '/') || '.';
}

function boundedLine(value) {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '�');
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
}

function shape(args, required, optional) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('tool arguments must be an object');
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !allowed.has(key))) invalid('tool arguments do not match the schema');
  if (args.path !== undefined && typeof args.path !== 'string') invalid('path must be a string');
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length < 1) invalid(`${name} must be a non-empty string`);
}

function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid('integer argument is outside its bound');
  return value;
}

function abort(signal) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
}

function invalid(message) { throw new ContractError('tool_schema_invalid', message); }
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
