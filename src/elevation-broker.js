// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from './ids.js';

const HELPER_PATH = fileURLToPath(new URL('./elevation-helper.js', import.meta.url));

export class ElevationBroker {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.nodePath = options.nodePath ?? process.execPath;
    this.helperPath = options.helperPath ?? HELPER_PATH;
    this.root = options.root ?? join(tmpdir(), 'not-native-agent-elevation');
    this.interactive = options.interactive;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? Date.now;
  }

  async execute(request, signal) {
    if (!this.interactive || typeof this.interactive.run !== 'function') {
      throw new ContractError('elevation_interactive_required', 'elevation requires a local interactive Console');
    }
    const operation = await this.#prepare(request);
    try {
      let launched = false;
      const launch = () => { launched = true; return this.#launch(operation, signal); };
      let status;
      try { status = await this.interactive.run(launch, elevationNotice(request)); }
      catch (error) {
        if (!launched) throw error;
        // Invariant: once the launcher was invoked, a failed UI handoff cannot prove the command had no effect.
        status = { exitCode: null };
      }
      status ??= { exitCode: null };
      let exists;
      try { exists = await resultExists(operation.resultPath); }
      catch (error) {
        if (!['elevation_result_unavailable', 'elevation_result_invalid'].includes(error.code)) throw error;
        return missingResult(status, error.code);
      }
      if (!exists) {
        if (status.authorization !== 'denied') return missingResult(status);
        return {
          status: 'failed', reasonCode: 'elevation_not_authorized', effectCertainty: 'none',
          content: 'The operating system did not authorize the elevated operation.',
          metadata: { elevated: false, exitCode: status.exitCode ?? null },
        };
      }
      try { return await readResult(operation.resultPath); }
      catch (error) {
        if (!['elevation_result_unavailable', 'elevation_result_invalid'].includes(error.code)) throw error;
        return missingResult(status, error.code);
      }
    } finally {
      await rm(operation.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #prepare(request) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink()
      || (process.getuid && root.uid !== process.getuid())) {
      throw new ContractError('elevation_directory_unsafe', 'elevation request directory is not owned by this process');
    }
    await chmod(this.root, 0o700);
    if (process.getuid && ((await lstat(this.root)).mode & 0o077) !== 0) {
      throw new ContractError('elevation_directory_unsafe', 'elevation request directory is not private');
    }
    const directory = await mkdtemp(join(this.root, 'request-'));
    await chmod(directory, 0o700).catch(() => undefined);
    const requestPath = join(directory, 'request.json');
    const resultPath = join(directory, 'result.json');
    const cancelPath = join(directory, 'cancel.requested');
    const record = elevationRecord(request, this.now());
    const bytes = `${JSON.stringify(record)}\n`;
    await writeFile(requestPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { directory, requestPath, resultPath, cancelPath, digest };
  }

  async #launch(operation, signal) {
    const envelope = Buffer.from(JSON.stringify({
      requestPath: operation.requestPath, resultPath: operation.resultPath,
      cancelPath: operation.cancelPath, digest: operation.digest,
    }), 'utf8').toString('base64url');
    const invocation = await elevationInvocation(this.platform, this, operation.directory, envelope);
    invocation.cancel = () => writeFile(operation.cancelPath, 'cancel\n', {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    }).catch(() => undefined);
    return waitForLauncher(this.spawnProcess, invocation, signal);
  }
}

export async function elevationInvocation(platform, broker, _directory, envelope) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) {
    throw new ContractError('elevation_platform_unsupported', `operating-system elevation is unsupported on ${platform}`);
  }
  return platform === 'win32' ? windowsInvocation(broker, envelope) : unixInvocation(broker, envelope);
}

function elevationRecord(request, now) {
  return Object.freeze({
    version: '1.1', request_id: request.id, issued_at: now,
    executable: request.args.executable, args: request.args.args, cwd: request.args.cwd,
    timeout_ms: request.args.timeout_ms, expected_effect: request.args.expected_effect,
  });
}

export function elevationNotice(request) {
  const command = [request.args.executable, ...request.args.args].map((item) => JSON.stringify(item)).join(' ');
  return [
    `Command: ${command}`,
    `Working directory: ${request.args.cwd}`,
    `Expected effect: ${request.args.expected_effect}`,
    'Authenticate only if this exactly matches the operation you approved.',
  ].join('\n');
}

function unixInvocation(broker, envelope) {
  return {
    executable: '/usr/bin/sudo',
    args: ['--', broker.nodePath, broker.helperPath, '--envelope', envelope],
    options: { stdio: 'inherit', shell: false, windowsHide: false },
  };
}

function windowsInvocation(broker, envelope) {
  const script = windowsLauncherScript(broker.nodePath, broker.helperPath, envelope);
  // Security: pass launcher code as an argument so a writable temporary file
  // cannot be replaced before PowerShell starts the elevated helper.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  return {
    executable: join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    options: { stdio: 'inherit', shell: false, windowsHide: true },
  };
}

function windowsLauncherScript(nodePath, helperPath, envelope) {
  const argumentsList = [helperPath, '--envelope', envelope].map(windowsCommandLineArgument).join(' ');
  return [
    '$ErrorActionPreference = \'Stop\'',
    `$arguments = ${psLiteral(argumentsList)}`,
    `$process = Start-Process -FilePath ${psLiteral(nodePath)} -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru`,
    'exit $process.ExitCode',
    '',
  ].join('\r\n');
}

function psLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function windowsCommandLineArgument(value) {
  const text = String(value);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

function waitForLauncher(spawnProcess, invocation, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(invocation.executable, invocation.args, invocation.options);
    let forceTimer = null;
    const abort = () => {
      Promise.resolve(invocation.cancel?.()).finally(() => {
        forceTimer = setTimeout(() => child.kill('SIGTERM'), 5_000);
        forceTimer.unref?.();
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', (error) => finish(() => reject(new ContractError(
      'elevation_launcher_unavailable', `operating-system elevation launcher failed: ${error.code ?? 'spawn_failed'}`,
    ))));
    child.once('exit', (code, exitSignal) => finish(() => resolve({
      cancelled: code !== 0 || exitSignal !== null, exitCode: code, signal: exitSignal,
    })));
    if (signal.aborted) abort();
    function finish(operation) {
      signal.removeEventListener('abort', abort); clearTimeout(forceTimer); operation();
    }
  });
}

async function readResult(path) {
  let source;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    throw new ContractError('elevation_result_unavailable', 'elevated helper result is unreadable', { cause: error });
  }
  let result;
  try { result = JSON.parse(source); } catch {
    throw new ContractError('elevation_result_invalid', 'elevated helper returned an invalid result');
  }
  if (!validResult(result)) throw new ContractError('elevation_result_invalid', 'elevated helper returned an invalid result');
  const content = JSON.stringify({
    exit_code: result.exit_code, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
  }, null, 2);
  return result.status === 'succeeded'
    ? { content, metadata: { elevated: true, exitCode: result.exit_code } }
    : { status: 'failed', reasonCode: result.reason_code, content, metadata: { elevated: true, exitCode: result.exit_code } };
}

function validResult(value) {
  return value && typeof value === 'object' && ['succeeded', 'failed'].includes(value.status)
    && (value.exit_code === null || Number.isSafeInteger(value.exit_code))
    && (value.signal === null || typeof value.signal === 'string')
    && typeof value.stdout === 'string' && typeof value.stderr === 'string'
    && (value.status === 'succeeded' || typeof value.reason_code === 'string');
}

function missingResult(status, reasonCode = 'elevation_result_unavailable') {
  return { status: 'failed', reasonCode, effectCertainty: 'unknown',
    content: 'The elevated operation may have run, but its result could not be verified.',
    metadata: { elevated: null, exitCode: status.exitCode ?? null } };
}

async function resultExists(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new ContractError('elevation_result_invalid', 'elevated helper result is not a regular file');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    if (error.code === 'elevation_result_invalid') throw error;
    throw new ContractError('elevation_result_unavailable', 'elevated helper result could not be checked', { cause: error });
  }
}
