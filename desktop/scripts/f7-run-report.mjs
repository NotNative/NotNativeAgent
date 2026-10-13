// SPDX-License-Identifier: Apache-2.0
/**
 * F7 run reports (process improvement P0): the journey writes a structured
 * `f7-run-latest.json` through writeRunState, and this module's CLI extracts a
 * compact verdict/phase report from any run log — sniffing the log encoding so
 * callers never guess at UTF-16 vs UTF-8 again.
 *
 * Usage:
 *   node scripts/f7-run-report.mjs <run-log>     # print a verdict report
 *   node scripts/f7-run-report.mjs --latest      # print the last written state
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_PATH = join(tmpdir(), 'f7-run-latest.json');

/** Read a possibly UTF-16 log file as a JS string (BOM / NUL sniffing). */
export function readLogText(path) {
  const bytes = readFileSync(path);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).swap16().toString('utf16le');
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  // A NUL-heavy head means UTF-16 without a BOM (PowerShell redirection).
  const head = bytes.subarray(0, Math.min(bytes.length, 200));
  let nul = 0;
  for (const byte of head) if (byte === 0) nul += 1;
  if (head.length > 0 && nul >= head.length / 4) return bytes.toString('utf16le');
  return bytes.toString('utf8');
}

/** Classify a run log into a stable verdict token for cross-run comparison. */
export function classify(log) {
  if (/page marker\s*\[FOUND\]/u.test(log)) return 'PASS';
  if (/Acceptance child timed out/u.test(log)) return 'TIMEOUT';
  if (/nnd_configuration_request_invalid/u.test(log)) return 'repair-rejected';
  if (/native activation reload was not ready|activation did not|activation control unavailable/u.test(log)
    && /AssertionError|Error:/u.test(log)) return 'activation-fail';
  if (/fresh install must require setup|setup did not reach ready/u.test(log)) return 'setup-fail';
  if (/probe crashed:|probe returned the reload stub/u.test(log)) return 'probe-fail';
  if (/evidence channel down/u.test(log)) return 'channel-fail';
  if (/never saw the proxied page content/u.test(log)) return 'f7-chain-fail';
  if (/capture was not honestly refused|fixture dev server was not discovered/u.test(log)) return 'f7-assert-fail';
  if (/AssertionError/u.test(log)) return 'other-fail';
  return 'no-assert';
}

/** Extract phases, timing, and key evidence lines from a run log. */
export function extractReport(log) {
  const report = { verdict: classify(log), notes: null, phases: [], errors: [], fixture: null, first: null, last: null };
  for (const match of log.matchAll(/===== (\S+?)(Z|-\d\d:\d\d)?\s/gu)) report.phases.push(match[1]);
  const times = [...log.matchAll(/"at":"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/gu)].map((m) => m[1]);
  if (times.length) { report.first = times[0]; report.last = times[times.length - 1]; report.notes = times.length; }
  const fixture = log.match(/(?:preserved fixture at|Journey evidence preserved at)\s+(\S*installed-accept-[0-9a-f]{16})/u);
  if (fixture) report.fixture = fixture[1];
  for (const pattern of [/AssertionError[^\n]*/gu, /Error: (?:native|F7|probe|Acceptance)[^\n]*/gu, /F7 REPORT:[^\n]*/gu]) {
    for (const match of log.matchAll(pattern)) report.errors.push(match[0].slice(0, 400));
  }
  report.errors = [...new Set(report.errors)].slice(0, 8);
  return report;
}

/** Persist the journey's structured run state for the next iteration. */
export function writeRunState(state) {
  const payload = { updated_at: new Date().toISOString(), ...state };
  writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2));
  return STATE_PATH;
}

export function readRunState() {
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return null; }
}

const invoked = process.argv[1] ?? '';
if (/f7-run-report\.mjs$/u.test(invoked)) {
  const target = process.argv[2];
  if (!target) throw new Error('usage: f7-run-report.mjs <run-log> | --latest');
  if (target === '--latest') {
    const state = readRunState();
    if (!state) throw new Error('no f7-run-latest.json yet');
    process.stdout.write(JSON.stringify(state, null, 2) + '\n');
  } else {
    const report = extractReport(readLogText(target));
    const line = `verdict=${report.verdict}  notes=${report.notes ?? '?'}  first=${report.first ?? '?'}  last=${report.last ?? '?'}`
      + (report.fixture ? `  fixture=${report.fixture}` : '');
    process.stdout.write(line + '\n');
    if (report.phases.length) process.stdout.write('phases: ' + report.phases.join(' -> ') + '\n');
    for (const error of report.errors) process.stdout.write('  | ' + error + '\n');
  }
}
