// SPDX-License-Identifier: Apache-2.0
/**
 * The contract a host must be able to satisfy to spawn NNA as its OpenCode.
 *
 * Why this is its own test: three separate details have to agree at once — the
 * version string the host's preflight parses, the argv it passes, and the
 * handshake line it waits for. Each has been got wrong individually, and a
 * mismatch in any one makes the host report "process exited before serving",
 * which reads like a crash rather than a contract disagreement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseCli } from '../src/cli-options.js';
import { VERSION } from '../src/product.js';
import { HANDSHAKE_LINE_PREFIX, MINIMUM_OPENCODE_VERSION, WIRED_OPENCODE_VERSION } from '../src/opencode/version.js';

const binary = process.execPath;
const argv = ['--disable-warning=ExperimentalWarning', 'src/cli.js'];

/** What a host reads from `binary --version`, before parsing. */
function reportedVersion() {
  return execFileSync(binary, [...argv, '--version'], { encoding: 'utf8' }).trim();
}

/** The host's own acceptance rules, restated so a drift on either side fails here. */
const SCHEMA = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const releaseParts = (value) => value.split(/[-+]/, 1)[0].split('.').map(Number);
const atOrAboveFloor = (value) => {
  const parts = releaseParts(value);
  const floor = releaseParts(MINIMUM_OPENCODE_VERSION);
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== floor[index]) return parts[index] > floor[index];
  }
  return true;
};

test('the reported version passes a host preflight that requires an OpenCode semver', () => {
  const version = reportedVersion();
  assert.match(version, SCHEMA, `reported ${version} is not a semantic version`);
  assert.equal(releaseParts(version)[0], 2, 'the host requires major 2');
  assert.ok(atOrAboveFloor(version), `${version} is below the required ${MINIMUM_OPENCODE_VERSION}`);
  // The claim is the contract NNA implements, not an invented number.
  assert.equal(releaseParts(version).join('.'), WIRED_OPENCODE_VERSION);
});

test('the reported version still names the product build, so one string serves both readers', () => {
  // Why: the installer verifies `--version` against the product version, and a host
  // verifies it against the OpenCode semver. Build metadata is what carries both.
  assert.match(reportedVersion(), new RegExp(`\\+nna\\.${VERSION.replaceAll('.', '\\.')}$`, 'u'));
});

test('the spawn argv a host uses parses into the managed runtime', () => {
  // Exactly what OpenChamber builds on Windows: bare `serve`, --stdio, host, port,
  // with no product prefix — so this binary can stand where opencode.exe is expected.
  const parsed = parseCli(['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '4137']);
  assert.equal(parsed.mode, 'opencode');
  assert.equal(parsed.serveAction, 'serve');
  assert.equal(parsed.serveStdioLease, true);
  assert.equal(parsed.serveHostname, '127.0.0.1');
  assert.equal(parsed.servePort, 4137);
});

test('the product-prefixed spelling still parses to the same operation', () => {
  // Why keep both: the wiring service and login script call `nna opencode run`, and
  // an operator may type `nna opencode serve`. One runtime, three spellings.
  const prefixed = parseCli(['opencode', 'serve', '--stdio']);
  assert.equal(prefixed.mode, 'opencode');
  assert.equal(prefixed.serveAction, 'serve');
  assert.equal(prefixed.serveStdioLease, true);
  assert.equal(parseCli(['opencode', 'run']).serveAction, 'run');
  // A bare `serve` and a prefixed one must not differ in what they run.
  assert.equal(parseCli(['serve']).serveAction, parseCli(['opencode', 'serve']).serveAction);
});

test('the handshake line is one the host matches', () => {
  // The host accepts `server listening on <url>` or a bare `{"url":...}`. NNA emits
  // the first, and the prefix is asserted rather than the whole line so a port
  // change cannot hide an edit to the wording.
  assert.equal(HANDSHAKE_LINE_PREFIX, 'opencode server listening on ');
  const line = `${HANDSHAKE_LINE_PREFIX}http://127.0.0.1:4137`;
  assert.match(line, /server listening on\s+(https?:\/\/\S+)/u);
});

test('a daemon invocation keeps its own lifecycle', () => {
  // Why: the spawn contract is additive. Without --stdio NNA must keep serving
  // until a signal, so an operator running it by hand is unaffected.
  const daemon = parseCli(['opencode', 'run']);
  assert.equal(daemon.serveStdioLease, false);
  assert.equal(daemon.servePort, null);
  assert.equal(daemon.serveHostname, null);
});
