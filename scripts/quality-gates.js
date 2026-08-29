// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
const productionRoot = join(root, 'src');
const MAX_SOURCE_FILES = 2_000;
const MAX_FILE_LINES = 500;
const MAX_FUNCTION_LINES = 60;
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules']);

await main().catch((error) => {
  process.stderr.write(`quality gates failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});

async function main() {
const files = await collect(productionRoot, MAX_SOURCE_FILES);
const errors = [];
for (const path of files) {
  if (extname(path) !== '.js') continue;
  const source = await readFile(path, 'utf8');
  const lines = source.split(/\r?\n/u);
  if (lines.length > MAX_FILE_LINES) errors.push(`${relative(root, path)} has ${lines.length} lines (max ${MAX_FILE_LINES})`);
  for (const span of functionSpans(lines)) {
    if (span.length > MAX_FUNCTION_LINES) errors.push(`${relative(root, path)}:${span.start} function has ${span.length} lines (max ${MAX_FUNCTION_LINES})`);
  }
  if (lines.some((line) => /[ \t]+$/u.test(line))) errors.push(`${relative(root, path)} has trailing whitespace`);
  if (!source.includes('SPDX-License-Identifier: Apache-2.0')) errors.push(`${relative(root, path)} lacks SPDX identifier`);
  const checked = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (checked.status !== 0) errors.push(`${relative(root, path)} fails node --check: ${checked.stderr.trim()}`);
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (Object.keys(packageJson.dependencies ?? {}).length > 0) {
  errors.push('runtime dependencies exist without an updated dependency review');
}

const graphCheck = spawnSync(process.execPath, [join(root, 'scripts', 'repository-graph.js'), '--check'], { encoding: 'utf8' });
if (graphCheck.status !== 0) errors.push(graphCheck.stderr.trim() || 'repository graph check failed');

const languageCheck = spawnSync(process.execPath, [join(root, 'scripts', 'controlled-language-gates.js')], { encoding: 'utf8' });
if (languageCheck.status !== 0) errors.push(languageCheck.stderr.trim() || 'controlled-language check failed');
else if (languageCheck.stdout) process.stdout.write(languageCheck.stdout);

if (errors.length > 0) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`quality gates passed for ${files.length} production files\n`);
}
}

async function collect(directory, maxFiles) {
  const pending = [directory];
  const result = [];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { throw new Error(`cannot inspect ${current}: ${error.code ?? error.message}`, { cause: error }); }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      else result.push(path);
      if (result.length > maxFiles) throw new Error(`source file count exceeds ${maxFiles}`);
    }
  }
  return result;
}

function functionSpans(lines) {
  const spans = [];
  const starts = /^\s*(?:(?:export\s+)?(?:async\s+)?function\b|(?:async\s+)?\*?#?[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{|(?:const|let)\s+\w+\s*=.*=>\s*\{)/u;
  for (let index = 0; index < lines.length; index += 1) {
    if (!starts.test(lines[index])) continue;
    const length = blockLength(lines, index);
    if (length > 0) spans.push({ start: index + 1, length });
  }
  return spans;
}

function blockLength(lines, start) {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    const safe = lines[index].replace(/(['"`])(?:\\.|(?!\1).)*\1/gu, '');
    for (const character of safe) {
      if (character === '{') { depth += 1; opened = true; }
      if (character === '}') depth -= 1;
    }
    if (opened && depth === 0) return index - start + 1;
  }
  return 0;
}
