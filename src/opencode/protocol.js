// SPDX-License-Identifier: Apache-2.0
// Pure OpenCode wire helpers: SSE write/parity, JSON body reads with bounds,
// Basic auth parsing, and URL targeting. Nothing here imports engine code.
import { MAX_REQUEST_BODY_BYTES } from './version.js';

export function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body, 'utf8')) });
  res.end(body);
}

export function sendEmpty(res, status) {
  // Why: observed gold OpenCode returns empty-bodied 401/404; a JSON envelope
  // here would be a wire deviation OpenChamber would render differently.
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

export async function readJsonBody(req, maximumBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maximumBytes) return { error: 'body_too_large' };
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return { value: {} };
  try { return { value: JSON.parse(text) }; } catch { return { error: 'malformed_json' }; }
}

export function matchesBasicAuthorization(header, username, password) {
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded;
  try {
    const token = header.slice('Basic '.length);
    if (/[^A-Za-z0-9+/_=]/u.test(token)) return false;
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch { return false; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  return decoded.slice(0, separator) === username && decoded.slice(separator + 1) === password;
}

export function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

export function sseOpen(res, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive',
    ...extraHeaders,
  });
  res.flushHeaders?.();
}

export function sseFrame(res, frame = {}) {
  if (res.writableEnded) return false;
  const lines = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  for (const dataLine of String(frame.data ?? '').split('\n')) lines.push(`data: ${dataLine}`);
  res.write(`${lines.join('\n')}\n\n`);
  return true;
}

export function sseClose(res) {
  if (!res.writableEnded) res.end();
}

export function parseTarget(url) {
  const parsed = new URL(url, 'http://127.0.0.1');
  const directory = parsed.searchParams.get('directory');
  return { pathname: parsed.pathname, query: Object.fromEntries(parsed.searchParams), directory: directory ?? undefined };
}
