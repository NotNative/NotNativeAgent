// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from '../ids.js';
import { WindowsClipboardBroker } from './clipboard-broker.js';

const MAX_CLIPBOARD_BYTES = 100_000;
const TIMEOUT_MS = 10_000;

export function nativeClipboard(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32' && !options.runner && !options.imageRunner && !options.imageProcessRunner) {
    return new WindowsClipboardBroker(options);
  }
  const runner = options.runner ?? runClipboardProcess;
  const commands = clipboardCommands(platform);
  return Object.freeze({
    async read() {
      const value = normalizeClipboardRead(await tryCommands(commands.read, runner), platform);
      if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_BYTES) {
        throw new ContractError('clipboard_content_too_large', `clipboard content exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
      }
      return value;
    },
    async write(value) {
      const text = String(value);
      if (Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_BYTES) {
        throw new ContractError('clipboard_content_too_large', `clipboard content exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
      }
      await tryCommands(commands.write, runner, text);
      return { copied: true, bytes: Buffer.byteLength(text, 'utf8') };
    },
    async readImage(path, maxBytes) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        await readClipboardImage(platform, path, maxBytes, options.imageRunner, options.imageProcessRunner);
        const details = await stat(path);
        if (!details.isFile() || details.size === 0 || details.size > maxBytes) {
          throw new ContractError('clipboard_image_size_invalid', 'clipboard image is empty or exceeds the attachment limit');
        }
        const signature = await readFile(path);
        if (!isPng(signature)) throw new ContractError('clipboard_image_invalid', 'clipboard image could not be encoded as PNG');
        return { path, mime_type: 'image/png', size: details.size };
      } catch (error) {
        await rm(path, { force: true }).catch(() => undefined);
        if (error instanceof ContractError) throw error;
        throw new ContractError('clipboard_image_unavailable', 'the clipboard does not contain a readable image', { cause: error });
      }
    },
  });
}

async function readClipboardImage(platform, path, maxBytes, injected, processRunner = runImageProcess) {
  if (injected) return injected(path, maxBytes, platform);
  if (platform === 'win32') {
    const script = '$p=[Environment]::GetEnvironmentVariable("NNA_CLIPBOARD_IMAGE_PATH"); '
      + 'Add-Type -AssemblyName System.Drawing; '
      + '$i=Get-Clipboard -Format Image -ErrorAction SilentlyContinue; if($null -eq $i) { exit 3 }; '
      + 'try { $i.Save($p,[Drawing.Imaging.ImageFormat]::Png) } finally { $i.Dispose() }';
    return processRunner(
      'powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], path, maxBytes, false,
      { NNA_CLIPBOARD_IMAGE_PATH: path },
    );
  }
  if (platform === 'darwin') return processRunner('pngpaste', [path], path, maxBytes, false);
  try { return await processRunner('wl-paste', ['--no-newline', '--type', 'image/png'], path, maxBytes, true); }
  catch { return processRunner('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], path, maxBytes, true); }
}

function runImageProcess(command, args, path, maxBytes, captureStdout, extraEnv = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    if (captureStdout) child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill(); else chunks.push(chunk);
    });
    child.on('error', finish(reject, timer));
    child.on('close', async (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > maxBytes) return reject(new Error(`clipboard image process failed (${code ?? 'terminated'})`));
      try {
        if (captureStdout) await import('node:fs/promises').then(({ writeFile }) => writeFile(path, Buffer.concat(chunks), { mode: 0o600 }));
        resolve();
      } catch (error) { reject(error); }
    });
  });
}

function isPng(value) {
  return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function clipboardCommands(platform) {
  if (platform === 'win32') return {
    read: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', 'Get-Clipboard -Raw -Format Text']]],
    write: [['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', windowsClipboardWriteCommand()]]],
  };
  if (platform === 'darwin') return { read: [['pbpaste', []]], write: [['pbcopy', []]] };
  return {
    read: [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-out']], ['xsel', ['--clipboard', '--output']]],
    write: [['wl-copy', []], ['xclip', ['-selection', 'clipboard', '-in']], ['xsel', ['--clipboard', '--input']]],
  };
}

function normalizeClipboardRead(value, platform) {
  if (platform !== 'win32') return value;
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function windowsClipboardWriteCommand() {
  return '$value=[Console]::In.ReadToEnd(); if($value.Length -eq 0) '
    + '{ Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear() } '
    + 'else { Set-Clipboard -Value $value }';
}

async function tryCommands(commands, runner, input = undefined) {
  let failure;
  for (const [command, args] of commands) {
    try { return await runner(command, args, input); } catch (error) { failure = error; }
  }
  throw new ContractError('clipboard_unavailable', 'the operating-system clipboard is unavailable', { cause: failure });
}

export function runClipboardProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CLIPBOARD_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', finish(reject, timer));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > MAX_CLIPBOARD_BYTES) reject(new Error(`clipboard process failed (${code ?? 'terminated'})`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input, 'utf8');
  });
}

function finish(reject, timer) {
  return (error) => { clearTimeout(timer); reject(error); };
}
