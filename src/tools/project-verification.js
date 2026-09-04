// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../ids.js';
import { runProcess } from './process.js';

const MAX_MANIFEST_BYTES = 131_072;
const CHECK_ORDER = Object.freeze(['quality', 'test', 'lint', 'typecheck', 'build']);
const SCRIPT_NAMES = Object.freeze({
  quality: ['check', 'verify', 'quality'], test: ['test'], lint: ['lint'],
  typecheck: ['typecheck', 'type-check', 'check:types'], build: ['build'],
});

export function projectVerifyDefinition(paths) {
  return {
    name: 'project.verify', version: 1,
    purpose: 'Discover and run the project\'s bounded Node/npm or Bun verification commands. The exact resolved commands and manifest fingerprints are reviewed before execution; results are durable turn evidence.',
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 3_600_000,
    inputSchema: {
      type: 'object', properties: {
        scope: { type: 'string', enum: ['focused', 'affected', 'full'], description: 'Verification breadth. Defaults to full; focused uses supplied test paths when supported.' },
        checks: { type: 'array', items: { type: 'string', enum: CHECK_ORDER }, maxItems: 5, description: 'Checks to run in canonical order. Omit to discover the project defaults.' },
        paths: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: 64, description: 'Existing test-file paths used only for focused verification.' },
        timeout_ms: { type: 'integer', minimum: 1000, maximum: 3_600_000, description: 'Deadline per resolved verification command in milliseconds. Defaults to 1800000.' },
      }, additionalProperties: false,
    },
    validate: (args) => validateVerification(paths, args),
    executor: executeVerification,
  };
}

export async function discoverVerificationPlan(root, input = {}) {
  const manifestPath = join(root, 'package.json');
  const manifest = await regularBoundedFile(manifestPath, 'verification_manifest_unavailable');
  let value;
  try { value = JSON.parse(manifest.content); }
  catch { throw new ContractError('verification_manifest_invalid', 'package.json is not valid JSON'); }
  const scripts = stringScripts(value.scripts);
  const manager = await packageManager(root, value.packageManager);
  const runtime = await verificationRuntime(manager);
  const scope = input.scope ?? 'full';
  const requested = uniqueChecks(input.checks);
  const selected = requested.length > 0 ? requested : defaultChecks(scripts);
  const commands = [];
  const unavailable = [];
  for (const check of selected) {
    const script = SCRIPT_NAMES[check].find((name) => Object.hasOwn(scripts, name));
    if (!script) { unavailable.push({ check, reason: 'script_not_found' }); continue; }
    commands.push(await commandFor(runtime, check, script, scripts[script], scope, input.paths ?? []));
  }
  if (commands.length === 0) {
    throw new ContractError('verification_checks_unavailable', 'package.json does not define any requested verification scripts');
  }
  return Object.freeze({
    adapter: manager, runtime: Object.freeze(runtime), scope, requested_checks: selected, commands: Object.freeze(commands),
    unavailable: Object.freeze(unavailable), manifest: Object.freeze({
      path: manifestPath, sha256: sha256(manifest.content), bytes: manifest.bytes,
    }),
    fallback: scope === 'affected' ? 'affected currently uses the full project script unless focused test paths are supplied' : null,
  });
}

async function validateVerification(paths, input = {}) {
  requireInput(input);
  const cwd = await paths.resolveDirectory(input.cwd ?? '.');
  const resolvedPaths = [];
  for (const candidate of input.paths ?? []) {
    const target = await paths.resolveRead(candidate);
    resolvedPaths.push(target.path);
  }
  const normalized = {
    scope: input.scope ?? 'full', checks: uniqueChecks(input.checks), paths: resolvedPaths,
    timeout_ms: input.timeout_ms ?? 1_800_000,
  };
  const plan = await discoverVerificationPlan(cwd.path, normalized);
  if (!plan.runtime.available) {
    throw new ContractError('verification_runtime_unavailable',
      `${plan.adapter} was selected by the project but its runtime was not found on the host (${plan.runtime.reason ?? 'executable unavailable'})`);
  }
  return {
    args: normalized,
    resolved: {
      path: cwd.path, insideWorkspace: cwd.insideWorkspace, recovery: cwd.recovery,
      reviewComplexity: 'opaque_package_script', reviewPurpose: 'project_verification',
      adapter: plan.adapter, runtime: plan.runtime, scope: plan.scope, commands: plan.commands,
      requested_checks: plan.requested_checks,
      unavailable: plan.unavailable, manifest: plan.manifest, fallback: plan.fallback,
    },
  };
}

async function executeVerification(request, signal) {
  const current = await regularBoundedFile(request.resolved.manifest.path, 'verification_manifest_unavailable');
  if (sha256(current.content) !== request.resolved.manifest.sha256) {
    throw new ContractError('verification_plan_drift', 'package.json changed after the verification plan was reviewed');
  }
  const results = [];
  for (const command of request.resolved.commands) {
    if (signal.aborted) throw new ContractError('tool_cancelled', 'project verification was cancelled');
    const result = await runProcess({
      executable: command.executable, args: command.argv, cwd: request.resolved.path,
      timeout_ms: request.args.timeout_ms,
    }, signal);
    const parsed = parseProcessResult(result.content);
    const lifecycle = result.status ?? 'succeeded';
    results.push({ ...parsed, check: command.check, script: command.script, command: command.display,
      tool_lifecycle_status: lifecycle, reason_code: result.reasonCode ?? null });
    if (lifecycle !== 'succeeded' || parsed.exit_code !== 0) break;
  }
  // Invariant: successful subprocess exits cannot erase missing checks or incomplete process evidence.
  const passed = request.resolved.unavailable.length === 0 && results.length === request.resolved.commands.length
    && results.every((item) => item.exit_code === 0 && item.tool_lifecycle_status === 'succeeded'
      && item.output_limit_exceeded !== true);
  const receipt = {
    version: 1, receipt_id: receiptId(request, results), passed,
    evidence_scope: 'requested_project_checks', requested_checks: request.resolved.requested_checks,
    adapter: request.resolved.adapter, runtime: request.resolved.runtime, scope: request.resolved.scope,
    manifest_sha256: request.resolved.manifest.sha256,
    commands: request.resolved.commands.map((item) => ({ display: item.display, source: item.source })),
    unavailable: request.resolved.unavailable, results,
  };
  return { status: passed ? 'succeeded' : 'failed', reasonCode: passed ? null : 'verification_failed',
    content: JSON.stringify(receipt, null, 2), metadata: {
    passed, checks: results.length, receiptId: receipt.receipt_id,
  } };
}

async function commandFor(runtime, check, script, source, scope, paths) {
  const focused = scope === 'focused' && paths.length > 0;
  if (focused && check === 'test' && runtime.adapter === 'bun') {
    return frozenCommand(check, script, source, runtime.executable, ['test', ...paths]);
  }
  if (focused && check === 'test' && /^node\s+--test(?:\s|$)/u.test(source.trim())) {
    return frozenCommand(check, script, source, process.execPath, ['--test', ...paths]);
  }
  if (runtime.adapter === 'bun') return frozenCommand(check, script, source, runtime.executable, ['run', script]);
  return frozenCommand(check, script, source, runtime.executable, [...runtime.prefix, 'run', script]);
}

async function verificationRuntime(adapter) {
  if (adapter === 'bun') {
    const executable = await executableOnPath(process.platform === 'win32' ? ['bun.exe', 'bun'] : ['bun']);
    return runtimeRecord(adapter, Boolean(executable), executable ?? 'bun', [], null,
      executable ? null : 'bun_executable_not_found');
  }
  if (process.platform !== 'win32') {
    const executable = await executableOnPath(['npm']);
    return runtimeRecord(adapter, Boolean(executable), executable ?? 'npm', [], process.version,
      executable ? null : 'npm_executable_not_found');
  }
  for (const directory of String(process.env.PATH ?? process.env.Path ?? '').split(';').filter(Boolean)) {
    const cli = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (await exists(cli)) return runtimeRecord(adapter, true, process.execPath, [await realpath(cli)], process.version, null);
  }
  return runtimeRecord(adapter, false, process.execPath, [], process.version, 'npm_cli_not_found_on_path');
}

function runtimeRecord(adapter, available, executable, prefix, nodeVersion, reason) {
  return Object.freeze({ adapter, available, executable, prefix: Object.freeze(prefix), node_version: nodeVersion, reason });
}

async function executableOnPath(names) {
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const directory of String(process.env.PATH ?? process.env.Path ?? '').split(separator).filter(Boolean)) {
    for (const name of names) {
      try {
        const canonical = await realpath(join(directory, name));
        const info = await lstat(canonical);
        if (info.isFile()) return canonical;
      } catch { /* continue bounded PATH discovery */ }
    }
  }
  return null;
}

function frozenCommand(check, script, source, executable, argv) {
  return Object.freeze({ check, script, source, executable, argv: Object.freeze(argv), display: displayCommand(executable, argv) });
}

async function packageManager(root, declared) {
  if (typeof declared === 'string') {
    if (declared.toLowerCase().startsWith('bun@') || declared.toLowerCase() === 'bun') return 'bun';
    if (declared.toLowerCase().startsWith('npm@') || declared.toLowerCase() === 'npm') return 'npm';
  }
  if (await exists(join(root, 'bun.lock')) || await exists(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

function defaultChecks(scripts) {
  if (Object.hasOwn(scripts, 'check')) return ['quality'];
  return CHECK_ORDER.filter((check) => SCRIPT_NAMES[check].some((name) => Object.hasOwn(scripts, name)));
}

function uniqueChecks(value = []) {
  if (!Array.isArray(value)) throw new ContractError('verification_checks_invalid', 'checks must be a bounded array');
  const result = [...new Set(value)];
  if (result.length > 5 || result.some((item) => !CHECK_ORDER.includes(item))) {
    throw new ContractError('verification_checks_invalid', 'checks contain an unsupported verification kind');
  }
  return result.sort((left, right) => CHECK_ORDER.indexOf(left) - CHECK_ORDER.indexOf(right));
}

function requireInput(input) {
  const allowed = new Set(['scope', 'checks', 'paths', 'timeout_ms']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ContractError('verification_request_invalid', 'project verification arguments are invalid');
  }
  if (input.scope !== undefined && !['focused', 'affected', 'full'].includes(input.scope)) {
    throw new ContractError('verification_scope_invalid', 'scope must be focused, affected, or full');
  }
  if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length > 64
    || input.paths.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 4096 || item.includes('\0')))) {
    throw new ContractError('verification_paths_invalid', 'verification paths are invalid or exceed bounds');
  }
  if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms)
    || input.timeout_ms < 1000 || input.timeout_ms > 3_600_000)) {
    throw new ContractError('verification_timeout_invalid', 'verification timeout must be 1000 to 3600000 milliseconds');
  }
  uniqueChecks(input.checks);
}

function stringScripts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const scripts = Object.entries(value).filter(([name, command]) => name.length <= 128
    && typeof command === 'string' && command.length <= 32768);
  if (scripts.length > 128) {
    throw new ContractError('verification_scripts_exceeded', 'package.json defines more than 128 bounded verification scripts');
  }
  return Object.fromEntries(scripts);
}

function parseProcessResult(content) {
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || (!Number.isInteger(value.exit_code)
      && !(value.exit_code === null && (typeof value.signal === 'string' || value.output_limit_exceeded === true)))) {
      throw new Error('invalid result');
    }
    return Object.freeze({
      exit_code: value.exit_code, signal: typeof value.signal === 'string' ? value.signal : null,
      stdout: boundedOutput(value.stdout), stderr: boundedOutput(value.stderr),
      stdout_bytes: boundedCount(value.stdout_bytes), stderr_bytes: boundedCount(value.stderr_bytes),
      output_limit_exceeded: value.output_limit_exceeded === true,
    });
  } catch {
    throw new ContractError('verification_result_invalid', 'verification process returned an invalid result envelope');
  }
}

async function regularBoundedFile(path, code) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error('not bounded');
    const handle = await open(path, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_MANIFEST_BYTES
        || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('not bounded');
      const bytes = await handle.readFile();
      if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('not bounded');
      return { content: bytes.toString('utf8'), bytes: bytes.length };
    } finally { await handle.close(); }
  } catch { throw new ContractError(code, 'a bounded regular package.json is required for project verification'); }
}

async function exists(path) {
  try { const info = await lstat(path); return info.isFile() && !info.isSymbolicLink(); } catch { return false; }
}

function displayCommand(executable, argv) {
  return [executable, ...argv.map((item) => /\s|["']/u.test(item) ? JSON.stringify(item) : item)].join(' ');
}

function receiptId(request, results) {
  return `verify:${createHash('sha256').update(JSON.stringify({
    manifest: request.resolved.manifest.sha256, commands: request.resolved.commands,
    results: results.map((item) => ({ check: item.check, exit_code: item.exit_code,
      tool_lifecycle_status: item.tool_lifecycle_status, reason_code: item.reason_code })),
    requested_checks: request.resolved.requested_checks, unavailable: request.resolved.unavailable,
  })).digest('hex')}`;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function boundedOutput(value) {
  if (typeof value !== 'string') return '';
  return value.length > 16_384 ? `${value.slice(0, 16_384)}\n[output truncated in verification receipt]` : value;
}
function boundedCount(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
