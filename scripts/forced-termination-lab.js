// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { VERSION } from '../src/product.js';
import { JournalStore, recoverJournal } from '../src/store.js';

const script = fileURLToPath(import.meta.url);
const beforeHash = digest('before');
const afterHash = digest('after');

export async function runForcedTerminationLab(options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'nna-force-kill-'));
  const owned = options.root === undefined;
  try {
    const discoveryRoot = join(root, 'discovery');
    await prepare(discoveryRoot);
    await runChild(['--child', '--root', discoveryRoot, '--target-sequence', '0'], 'completed');
    const discovery = await recoverJournal(journalPath(discoveryRoot));
    const limit = options.maxBoundaries ?? discovery.records.length;
    const boundaries = discovery.records.slice(0, limit).map((item) => ({ sequence: item.sequence, type: item.type }));
    const cases = [];
    for (const boundary of boundaries) cases.push(await forceAt(root, boundary));
    return Object.freeze({
      schema_version: 1, product_version: VERSION, measured_at: new Date().toISOString(),
      evidence_kind: 'forced_termination_session_journal', platform: process.platform,
      discovered_boundaries: discovery.records.length, exercised_boundaries: cases.length,
      complete_matrix: cases.length === discovery.records.length,
      passed: cases.length > 0 && cases.every((item) => item.passed), cases,
    });
  } finally { if (owned) await rm(root, { recursive: true, force: true }); }
}

async function forceAt(root, boundary) {
  const caseRoot = join(root, `boundary-${boundary.sequence}`);
  await prepare(caseRoot);
  const child = spawn(process.execPath, [script, '--child', '--root', caseRoot,
    '--target-sequence', String(boundary.sequence)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let marker;
  try {
    marker = await waitForRecord(child, (item) => item.kind === 'boundary', 20_000);
    child.kill('SIGKILL');
    await waitForExit(child, 10_000);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  const prefix = await recoverJournal(journalPath(caseRoot));
  const resume = await runChild(['--resume', '--root', caseRoot], 'resume');
  const durableResult = hasDurableWriteResult(prefix.records);
  const passed = marker.sequence === boundary.sequence && marker.type === boundary.type
    && !prefix.corruptTail && prefix.lastSequence === boundary.sequence
    && resume.provider_calls === 0 && resume.recovery_notice_count <= 1
    && (!durableResult || resume.target_state === 'after');
  return Object.freeze({
    sequence: boundary.sequence, type: boundary.type, passed,
    recovered_last_sequence: prefix.lastSequence, corrupt_tail: prefix.corruptTail,
    provider_calls_on_resume: resume.provider_calls,
    recovery_notice_count: resume.recovery_notice_count,
    target_state: resume.target_state, durable_tool_result: durableResult,
  });
}

export function hasDurableWriteResult(records) {
  return records.some((item) => item.type === 'tool_result'
    && item.payload?.toolName === 'fs.write_text'
    && item.payload?.toolLifecycleStatus === 'succeeded'
    && item.payload?.effectCertainty === 'completed');
}

async function childRun(root, targetSequence) {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 1) yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'force-kill-read', function: {
        name: 'fs.read_text', arguments: JSON.stringify({ path: 'target.txt' }),
      },
    }] };
    else if (calls === 2) yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'force-kill-write', function: {
        name: 'fs.write_text', arguments: JSON.stringify({
          path: 'target.txt', content: 'after',
        }),
      },
    }] };
    else yield { type: 'text', text: 'completed' };
    yield { type: 'terminal', finishReason: calls <= 2 ? 'tool_calls' : 'stop' };
  } };
  class ObservedStore extends JournalStore {
    async append(type, payload) {
      const record = await super.append(type, payload);
      if (record.sequence === targetSequence) {
        emit({ kind: 'boundary', sequence: record.sequence, type: record.type });
        await new Promise(() => undefined);
      }
      return record;
    }
  }
  const engine = new SessionEngine({
    config: config(root), sessionId: 'force-kill-session', storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewers'), providerFactory: () => provider,
    semanticReviewer: { async review() {
      return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' };
    } },
    storeFactory: (storeRoot, id, storeOptions) => new ObservedStore(storeRoot, id, storeOptions),
  });
  await engine.initialize();
  await engine.submit({ request_id: 'force-kill-turn', content: 'Write after to target.txt' }, 'operator');
  await engine.shutdown({ request_id: 'force-kill-shutdown' });
  emit({ kind: 'completed' });
}

async function resumeRun(root) {
  let providerCalls = 0;
  const engine = new SessionEngine({
    config: config(root), sessionId: 'force-kill-session', storeRoot: join(root, 'sessions'),
    reviewerRoot: join(root, 'reviewers'), providerFactory: () => ({ async *stream() {
      providerCalls += 1; yield { type: 'text', text: 'unexpected' }; yield { type: 'terminal' };
    } }),
  });
  await engine.initialize();
  const target = await readFile(join(root, 'target.txt'), 'utf8');
  emit({
    kind: 'resume', provider_calls: providerCalls,
    recovery_notice_count: engine.recoveryNotices.length,
    target_state: digest(target) === beforeHash ? 'before' : digest(target) === afterHash ? 'after' : 'unexpected',
  });
  await engine.shutdown({ request_id: 'resume-shutdown' });
}

function config(root) {
  return resolveManifest({
    persistence: 'durable', workspace_root: root,
    provider: {
      endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
      capabilities: { tools: true, structured_output: true },
    },
  });
}

async function prepare(root) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'target.txt'), 'before', 'utf8');
}

function journalPath(root) { return join(root, 'sessions', 'force-kill-session.journal.ndjson'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

export async function runChild(args, expectedKind, options = {}) {
  const spawnProcess = options.spawn ?? spawn;
  const child = spawnProcess(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const result = await waitForRecord(child, (item) => item.kind === expectedKind, options.recordTimeoutMs ?? 30_000);
    await waitForExit(child, options.exitTimeoutMs ?? 10_000);
    if (child.exitCode !== 0) throw coded('forced_termination_child_failed');
    return result;
  } catch (error) {
    try { await terminateChild(child, options.cleanupTimeoutMs ?? 10_000); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'forced-termination child cleanup failed', { cause: error });
    }
    throw error;
  }
}

async function terminateChild(child, timeoutMs) {
  if (child.exitCode !== null) return;
  const exited = waitForExit(child, timeoutMs);
  child.kill('SIGKILL');
  await exited;
}

function waitForRecord(child, predicate, timeoutMs) {
  return new Promise((resolveRecord, reject) => {
    let buffer = ''; let stderr = '';
    const timer = setTimeout(() => reject(coded('forced_termination_child_timeout')), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 1024); });
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
      for (const line of lines) {
        try { const item = JSON.parse(line); if (predicate(item)) { clearTimeout(timer); resolveRecord(item); } }
        catch { /* ignore non-protocol child output */ }
      }
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) { clearTimeout(timer); reject(coded(stderr ? 'forced_termination_child_failed' : 'forced_termination_child_exit')); }
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(coded('forced_termination_exit_timeout')), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
}

function coded(code) { return Object.assign(new Error(code), { code }); }
function argument(name) { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; }

async function main() {
  const root = argument('--root');
  if (process.argv.includes('--child')) return childRun(resolve(root), Number(argument('--target-sequence')));
  if (process.argv.includes('--resume')) return resumeRun(resolve(root));
  const report = await runForcedTerminationLab();
  const output = argument('--output'); const encoded = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(resolve(output), encoded, { encoding: 'utf8', mode: 0o600 });
  else process.stdout.write(encoded);
  if (!report.passed || !report.complete_matrix) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error?.code ?? 'forced_termination_lab_failed'}\n`); process.exitCode = 1; });
}
