// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectProductionSources } from './source-catalog.js';
import { auditDependencyRegistry } from './dependency-registry-gate.js';
import { functionSpans } from './function-spans.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAX_FILE_LINES = 500;
const MAX_FUNCTION_LINES = 60;
const MAX_SOURCE_BYTES = 400_000;
const TS_CONFIGS = ['packages/ui/tsconfig.json', 'packages/web/tsconfig.ui.json', 'packages/web/tsconfig.server.json'];
const SPDX_TOKEN = 'SPDX-License-Identifier: Apache-2.0';
const FUNCTION_BASELINE = new URL('./function-length-baseline.json', import.meta.url);

async function main() {
  const files = await collectProductionSources(root);
  const errors = [];
  const functionDebt = {};
  for (const path of files) {
    const label = relative(root, path).replaceAll('\\', '/');
    let source;
    try { source = await readFile(path, 'utf8'); }
    catch (error) { errors.push(`${label} could not be read: ${error.code ?? error.message}`); continue; }
    auditFile(label, source, errors, functionDebt);
    if (/\.(m?js)$/u.test(path)) checkSyntaxNative(path, errors);
  }
  if (process.argv.includes('--write-function-baseline')) {
    if (errors.length > 0) { finishGate(files, errors); return; }
    await writeFile(FUNCTION_BASELINE, `${JSON.stringify(functionDebt, null, 2)}\n`);
    process.stdout.write(`wrote function-length baseline for ${Object.keys(functionDebt).length} files\n`);
    return;
  }
  await auditFunctionDebt(functionDebt, errors);
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

function auditFile(label, source, errors, functionDebt) {
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length > MAX_FILE_LINES) errors.push(`${label} has ${lines.length} lines (max ${MAX_FILE_LINES})`);
  if (source.length > MAX_SOURCE_BYTES) errors.push(`${label} is ${source.length} bytes (max ${MAX_SOURCE_BYTES})`);
  if (lines.some((line) => /[ \t]+$/u.test(line))) errors.push(`${label} has trailing whitespace`);
  if (!source.includes(SPDX_TOKEN)) errors.push(`${label} lacks SPDX identifier`);
  // Encoding incident guard (P2/P5-6 history): CP1252-misread UTF-8 remnants.
  if (/\u00C2[\u0080-\u00BF]|\u00E2\u20AC/u.test(source)) errors.push(`${label} has CP1252-mojibake sequences (encoding incident)`);
  let spans;
  try { spans = functionSpans(source, label); }
  catch (error) { errors.push(error.message); return; }
  const debt = spans.filter((span) => span.length > MAX_FUNCTION_LINES)
    .map(({ length, digest }) => ({ length, digest }))
    .sort((a, b) => b.length - a.length || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  if (debt.length > 0) functionDebt[label] = debt;
}

async function auditFunctionDebt(observed, errors) {
  let baseline;
  try { baseline = JSON.parse(await readFile(FUNCTION_BASELINE, 'utf8')); }
  catch (error) { errors.push(`function-length baseline unavailable: ${error.code ?? error.message}`); return; }
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    errors.push('function-length baseline must be a file map'); return;
  }
  for (const label of new Set([...Object.keys(baseline), ...Object.keys(observed)])) {
    const expected = Object.hasOwn(baseline, label) ? baseline[label] : [];
    if (!Array.isArray(expected) || expected.some((span) => !span || !Number.isSafeInteger(span.length)
      || span.length <= MAX_FUNCTION_LINES || !/^[a-f0-9]{64}$/u.test(span.digest))) {
      errors.push(`function-length baseline is invalid for ${label}`); continue;
    }
    const actual = observed[label] ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${label} function-length debt changed; review the functions and regenerate the baseline`);
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

main().catch((error) => {
  process.stderr.write(`quality gates failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
