// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, open, rm } from 'node:fs/promises';
import { ContractError } from '../ids.js';

const MAX_CLIPBOARD_BYTES = 100_000;
const MAX_BROKER_RESPONSE_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class WindowsClipboardBroker {
  #child = null;
  #starting = null;
  #buffer = '';
  #pending = null;
  #ready = null;
  #serial = Promise.resolve();
  #nextId = 1;
  #closed = false;

  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async initialize() { await this.#ensureChild(); return this; }

  async read() {
    const response = await this.#enqueue('read_text');
    const text = decodeText(response.content);
    assertTextBound(text);
    return text;
  }

  async write(value) {
    const text = String(value);
    assertTextBound(text);
    await this.#enqueue('write_text', { content: Buffer.from(text, 'utf8').toString('base64') });
    return { copied: true, bytes: Buffer.byteLength(text, 'utf8') };
  }

  async readContent(path, maxBytes) {
    assertImageTarget(path, maxBytes, true);
    const temporary = path ? ownedImagePath(path) : null;
    try {
      const response = await this.#enqueue('read_content', { path: temporary, max_bytes: maxBytes });
      if (response.kind !== 'image') {
        const text = decodeText(response.content); assertTextBound(text);
        return { kind: 'text', text };
      }
      return { kind: 'image', ...await publishImage(temporary, path, maxBytes) };
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async readImage(path, maxBytes) {
    assertImageTarget(path, maxBytes);
    const temporary = ownedImagePath(path);
    try {
      const response = await this.#enqueue('read_image', { path: temporary, max_bytes: maxBytes });
      if (response.kind !== 'image') throw new ContractError('clipboard_image_unavailable', 'the clipboard does not contain an image');
      return await publishImage(temporary, path, maxBytes);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }

  async close() {
    this.#closed = true;
    await this.#serial;
    const child = this.#child;
    if (!child) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stdin.end();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 250))]);
    if (this.#child === child) child.kill();
  }

  #enqueue(operation, payload = {}) {
    const request = this.#serial.then(() => this.#request(operation, payload));
    this.#serial = request.catch(() => undefined);
    return request;
  }

  async #request(operation, payload) {
    const child = await this.#ensureChild();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#settlePending(new ContractError('clipboard_timeout', 'the clipboard broker did not respond in time'));
        child.kill();
      }, this.timeoutMs);
      this.#pending = { id, resolve, reject, timer };
      child.stdin.write(`${JSON.stringify({ id, operation, ...payload })}\n`, 'utf8', (error) => {
        if (error) this.#settlePending(new ContractError('clipboard_unavailable', 'the clipboard broker is unavailable', { cause: error }));
      });
    });
  }

  async #ensureChild() {
    if (this.#closed) throw new ContractError('clipboard_unavailable', 'the clipboard broker is closed');
    if (this.#starting) return this.#starting;
    if (this.#child) return this.#child;
    this.#starting ??= this.#start();
    try { return await this.#starting; } finally { this.#starting = null; }
  }

  #start() {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CLIPBOARD_SCRIPT,
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const failed = (error) => {
        this.#child = null;
        reject(new ContractError('clipboard_unavailable', 'the clipboard broker could not start', { cause: error }));
      };
      child.once('error', failed);
      child.once('spawn', () => {
        child.removeListener('error', failed);
        this.#child = child;
        child.stdout.on('data', (chunk) => this.#accept(chunk));
        child.on('error', (error) => this.#disconnect(child, error));
        child.on('close', () => this.#disconnect(child));
        const timer = setTimeout(() => {
          this.#settleReady(new ContractError('clipboard_timeout', 'the clipboard broker did not become ready'));
          child.kill();
        }, this.timeoutMs);
        this.#ready = { resolve: () => resolve(child), reject, timer };
      });
    });
  }

  #accept(chunk) {
    const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), 'utf8');
    if (Buffer.byteLength(this.#buffer, 'utf8') + chunkBytes > MAX_BROKER_RESPONSE_BYTES) {
      this.#settlePending(new ContractError('clipboard_protocol_invalid', 'the clipboard broker response exceeds its bound'));
      this.#child?.kill(); return;
    }
    this.#buffer += chunk.toString('utf8');
    let end;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end); this.#buffer = this.#buffer.slice(end + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { this.#settlePending(new ContractError('clipboard_protocol_invalid', 'the clipboard broker returned invalid data')); continue; }
      if (response.id === 0 && response.kind === 'ready') { this.#settleReady(); continue; }
      if (!this.#pending || response.id !== this.#pending.id) {
        this.#settlePending(new ContractError('clipboard_protocol_invalid', 'the clipboard broker returned an unexpected response'));
      } else if (response.ok !== true) {
        this.#settlePending(new ContractError(response.code ?? 'clipboard_operation_failed', 'the clipboard operation failed'));
      } else this.#settlePending(null, response);
    }
  }

  #settlePending(error, value) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null; clearTimeout(pending.timer);
    if (error) pending.reject(error); else pending.resolve(value);
  }

  #settleReady(error = null) {
    const ready = this.#ready;
    if (!ready) return;
    this.#ready = null; clearTimeout(ready.timer);
    if (error) ready.reject(error); else ready.resolve();
  }

  #disconnect(child, error = null) {
    if (this.#child !== child) return;
    this.#child = null; this.#buffer = '';
    this.#settleReady(new ContractError('clipboard_unavailable', 'the clipboard broker stopped', { cause: error }));
    this.#settlePending(new ContractError('clipboard_unavailable', 'the clipboard broker stopped', { cause: error }));
  }
}

function decodeText(value) {
  const encoded = String(value ?? '');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new ContractError('clipboard_protocol_invalid', 'the clipboard broker returned invalid text');
  }
  try { return Buffer.from(encoded, 'base64').toString('utf8'); }
  catch (error) { throw new ContractError('clipboard_protocol_invalid', 'the clipboard broker returned invalid text', { cause: error }); }
}

function assertTextBound(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_BYTES) {
    throw new ContractError('clipboard_content_too_large', `clipboard content exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
  }
}

async function validateImage(path, maxBytes) {
  let handle;
  try {
    handle = await open(path, 'r');
    const details = await handle.stat();
    if (!details.isFile() || details.size === 0 || details.size > maxBytes) throw new Error('invalid image size');
    const signature = Buffer.alloc(PNG_SIGNATURE.length);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== PNG_SIGNATURE.length || !signature.equals(PNG_SIGNATURE)) throw new Error('invalid PNG signature');
    return { path, mime_type: 'image/png', size: details.size };
  } catch (error) {
    throw new ContractError('clipboard_image_invalid', 'clipboard image could not be encoded as a bounded PNG', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishImage(temporary, path, maxBytes) {
  const image = await validateImage(temporary, maxBytes);
  try { await link(temporary, path); }
  catch (error) {
    if (error?.code === 'EEXIST') {
      throw new ContractError('clipboard_image_path_invalid', 'clipboard image destination already exists', { cause: error });
    }
    throw error;
  }
  return { path, mime_type: image.mime_type, size: image.size };
}

function ownedImagePath(path) { return `${path}.nna-clipboard-${randomUUID()}.tmp`; }

export function assertImageTarget(path, maxBytes, optional = false) {
  if ((!optional || path !== null && path !== undefined) && (typeof path !== 'string' || path.length === 0 || path.includes('\0'))) {
    throw new ContractError('clipboard_image_path_invalid', 'clipboard image destination must be a non-empty path');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new ContractError('clipboard_image_size_invalid', 'clipboard image limit must be a positive integer');
  }
}

export const WINDOWS_CLIPBOARD_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '[Console]::InputEncoding=[Text.Encoding]::UTF8',
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  "function Send($v) {[Console]::Out.WriteLine(($v|ConvertTo-Json -Compress));[Console]::Out.Flush()}",
  "Send @{id=0;ok=$true;kind='ready'}",
  'while(($line=[Console]::In.ReadLine()) -ne $null) {',
  ' try {',
  '  $r=$line|ConvertFrom-Json; $id=$r.id',
  "  if($r.operation -eq 'write_text') {$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$r.content));if($t.Length -eq 0){[Windows.Forms.Clipboard]::Clear()}else{[Windows.Forms.Clipboard]::SetText($t,[Windows.Forms.TextDataFormat]::UnicodeText)};Send @{id=$id;ok=$true};continue}",
  "  if($r.operation -eq 'read_text') {$t=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText);$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t));Send @{id=$id;ok=$true;kind='text';content=$b};continue}",
  "  if(($r.operation -eq 'read_content') -and $r.path -and [Windows.Forms.Clipboard]::ContainsImage()) {$i=[Windows.Forms.Clipboard]::GetImage();try{$i.Save([string]$r.path,[Drawing.Imaging.ImageFormat]::Png)}finally{$i.Dispose()};$s=(Get-Item -LiteralPath ([string]$r.path)).Length;if($s -gt [long]$r.max_bytes){Remove-Item -LiteralPath ([string]$r.path) -Force;throw 'image too large'};Send @{id=$id;ok=$true;kind='image';size=$s};continue}",
  "  if($r.operation -eq 'read_image') {if(-not [Windows.Forms.Clipboard]::ContainsImage()){Send @{id=$id;ok=$false;code='clipboard_image_unavailable'};continue};$i=[Windows.Forms.Clipboard]::GetImage();try{$i.Save([string]$r.path,[Drawing.Imaging.ImageFormat]::Png)}finally{$i.Dispose()};$s=(Get-Item -LiteralPath ([string]$r.path)).Length;if($s -gt [long]$r.max_bytes){Remove-Item -LiteralPath ([string]$r.path) -Force;throw 'image too large'};Send @{id=$id;ok=$true;kind='image';size=$s};continue}",
  "  if($r.operation -eq 'read_content') {$t=[Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText);$b=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t));Send @{id=$id;ok=$true;kind='text';content=$b};continue}",
  "  Send @{id=$id;ok=$false;code='clipboard_operation_invalid'}",
  " } catch {Send @{id=$id;ok=$false;code='clipboard_operation_failed'}}",
  '}',
].join(';');
