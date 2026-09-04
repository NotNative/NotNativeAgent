// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { ContractError } from './ids.js';
import { windowsAdminSource } from './windows-admin-worker.js';
import { operationalEnvironment } from './tools/process.js';
import { shellDiagnosticVisibility } from './reliability/host-environment.js';

export class WindowsAdministrator {
  constructor(options = {}) {
    this.spawn = options.spawn ?? spawn;
    this.root = options.root ?? tmpdir();
    this.node = options.node ?? process.execPath;
    this.systemRoot = options.systemRoot ?? 'C:\\Windows';
    this.output = options.output ?? (async () => {});
  }

  async execute(request, signal) {
    if (signal.aborted) return notApproved();
    const systemRoot = trustedWindowsSystemRoot(this.systemRoot);
    const directory = await mkdtemp(join(this.root, 'nna-admin-'));
    const bytes = JSON.stringify(request.args);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const envelope = { directory, digest, powershell, taskkill: win32.join(systemRoot, 'System32', 'taskkill.exe') };
    try {
      await writeFile(join(directory, 'request.json'), bytes, { flag: 'wx' });
      await this.output({ request, phase: 'awaiting_authorization' });
      const code = await this.launch(envelope, signal, request);
      return await this.result(envelope, code, request.args);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  launch(envelope, signal, request) {
    const script = administratorLauncher(this.node, envelope);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    if (encoded.length > 30000) throw new ContractError('elevation_launcher_unavailable', 'Administrator launcher exceeds the Windows command-line bound');
    return new Promise((resolve, reject) => {
      const child = this.spawn(envelope.powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { shell: false, windowsHide: true, stdio: 'ignore', env: operationalEnvironment() });
      let cancellationTimer, commandTimer, announced = false, checking = false, finished = false, aborting = false;
      const progress = setInterval(async () => {
        if (announced || checking) return;
        checking = true;
        try {
          await stat(join(envelope.directory, 'started'));
          if (finished) return;
          announced = true;
          commandTimer = setTimeout(abort, request.args.timeout_ms + 5000);
          await this.output({ request, phase: 'executing_administrator' });
        } catch (error) {
          if (error.code !== 'ENOENT' && !finished) abort();
        } finally { checking = false; }
      }, 250);
      const abort = () => {
        if (finished || aborting) return;
        aborting = true;
        // Security: the worker checks this before launch and throughout execution.
        writeFile(join(envelope.directory, 'cancel'), 'cancel', { flag: 'wx' }).catch((error) => {
          if (error.code !== 'EEXIST') child.kill();
        });
        cancellationTimer = setTimeout(() => { child.kill(); finish(() => resolve(null)); }, 4500);
      };
      const finish = (operation) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', abort); clearTimeout(cancellationTimer);
        clearTimeout(commandTimer); clearInterval(progress); operation();
      };
      child.once('error', () => finish(() => reject(new ContractError('elevation_launcher_unavailable', 'Windows administrator launcher is unavailable'))));
      child.once('close', (code) => finish(() => resolve(code)));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async result(envelope, code, args) {
    let result;
    try {
      if (code !== 0) throw new Error('launcher_failed');
      const path = join(envelope.directory, 'result.json');
      if ((await stat(path)).size > 2097152) throw new Error('result_bound');
      result = JSON.parse(await readFile(path, 'utf8'));
      if (!validResult(result, envelope.digest, args)) throw new Error('result_invalid');
    } catch {
      if (code === 1223 && !await hasStarted(envelope)) return notApproved();
      return { status: 'unknown_effect', effectCertainty: 'unknown', reasonCode: 'elevation_result_unavailable',
        content: 'Administrator execution returned no valid result. Inspect the target before retrying.' };
    }
    return { status: result.status, reasonCode: result.reasonCode, effectCertainty: result.effectCertainty,
      content: JSON.stringify({ exit_code: result.exitCode ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
        ...(result.stderr ? { diagnostic_outcome: 'stderr_present' } : {}) }),
      metadata: { elevated: result.effectCertainty !== 'none', exitCode: result.exitCode ?? null,
        reboot_required: result.rebootRequired === true, output_truncated: result.outputTruncated === true,
        ...(result.stderr ? { diagnosticOutcome: 'stderr_present', stderrBytes: Buffer.byteLength(result.stderr) } : {}),
        ...(shellDiagnosticVisibility(args.script) ? { diagnosticVisibility: shellDiagnosticVisibility(args.script) } : {}),
        verification_required: true } };
  }
}

function trustedWindowsSystemRoot(value) {
  if (typeof value !== 'string' || value.split(/[\\/]/u).includes('..')) {
    throw new ContractError('elevation_launcher_unavailable', 'Windows system root is not trusted');
  }
  const normalized = win32.normalize(value);
  if (!/^C:\\Windows$/iu.test(normalized)) {
    throw new ContractError('elevation_launcher_unavailable', 'Windows system root is not trusted');
  }
  return normalized;
}

function notApproved() {
  return { status: 'denied', effectCertainty: 'none', reasonCode: 'elevation_not_authorized',
    content: 'Windows did not authorize this operation. Do not retry elevation without new user direction.' };
}

export function administratorLauncher(node, envelope) {
  const source = windowsAdminSource(envelope);
  const args = ['--input-type=commonjs', '-e', source].map(windowsArgument).join(' ');
  return [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $job = Start-Process -FilePath ${literal(node)} -Verb RunAs -WindowStyle Hidden -ArgumentList ${literal(args)} -Wait -PassThru`,
    '  exit $job.ExitCode',
    '} catch {',
    '  if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { exit 1223 }',
    '  exit 1',
    '}',
  ].join('\n');
}

function validResult(result, digest, args) {
  return result && result.requestDigest === digest
    && ['succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'unknown_effect'].includes(result.status)
    && ['none', 'completed', 'unknown'].includes(result.effectCertainty)
    && [result.stdout, result.stderr].every((value) => value === undefined || typeof value === 'string')
    && (result.reasonCode == null || typeof result.reasonCode === 'string')
    && (result.status !== 'denied' || result.effectCertainty === 'none')
    && (result.status !== 'succeeded' || (result.effectCertainty === 'completed'
      && Number.isInteger(result.exitCode) && args.accepted_exit_codes.includes(result.exitCode)
      && result.signal == null && result.outputTruncated !== true));
}

async function hasStarted(envelope) {
  try { await stat(join(envelope.directory, 'started')); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

function literal(text) { return `'${text.replaceAll("'", "''")}'`; }
function windowsArgument(text) { return `"${text.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`; }
