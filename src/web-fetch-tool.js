// SPDX-License-Identifier: Apache-2.0
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { VERSION } from './product.js';
import { pinnedHttpRequest } from './pinned-http.js';
import { loadWebFetchConfig } from './web-fetch-config.js';

const MAX_BYTES = 1_048_576;
const MAX_REDIRECTS = 5;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const TOOL_TIMEOUT_MS = 20_000;
const PROVIDER_TEXT_BYTES = 16_384;

export function webFetchDefinition(options = {}) {
  const policy = options.policy ?? new WebFetchDestinationPolicy(options.configPath);
  const client = options.client ?? new WebFetchClient({ policy });
  return {
    name: 'web.fetch', version: 1,
    purpose: 'Fetch bounded HTTP(S) text from a public URL or an explicitly trusted private origin without browser execution. Use this to read an authoritative source found through web.search before making a detailed current factual claim. If this tool fails for a verified exact URL, do not retry it; use web.browse navigate on that same URL when available.',
    sideEffect: 'read_only', scope: 'network', cancellation: true, timeoutMs: TOOL_TIMEOUT_MS,
    maxOutputBytes: PROVIDER_TEXT_BYTES,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['url'], properties: {
        url: { type: 'string', minLength: 1, maxLength: 4096, description: 'Required complete HTTP(S) URL without embedded credentials.' },
      },
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).length !== 1 || typeof args.url !== 'string') throw invalid();
      const url = normalizeUrl(args.url);
      const destination = await policy.classify(url);
      return { args: { url: url.href }, resolved: { destination, host: url.hostname, origin: url.origin } };
    },
    executor: async (request, signal) => {
      const result = await client.fetchText(request.args.url, signal);
      const urlRef = options.references?.remember('url', result.url, 'web_fetch');
      const content = providerReadableText(result.text, result.contentType);
      return { content, metadata: {
        finalUrl: result.url, status: result.status, contentType: result.contentType, bytes: result.bytes,
        responseSha256: createHash('sha256').update(result.text, 'utf8').digest('hex'),
        providerTextCompacted: content !== result.text,
        ...(urlRef ? { url_ref: urlRef.id } : {}),
      } };
    },
  };
}

function providerReadableText(text, contentType) {
  if (contentType !== 'text/html') return text;
  const title = text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? '';
  const body = text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1] ?? text;
  const readable = body
    .replace(/<(?:script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|svg|template)>/giu, ' ')
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|div|li|section|article|header|footer|h[1-6]|tr)>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ');
  const decoded = decodeHtml(`${title ? `Title: ${title}\n\n` : ''}${readable}`)
    .replace(/[\t\f\v ]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
  return decoded || '[The page contained no readable text.]';
}

function decodeHtml(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[name.toLowerCase()] ?? match;
  });
}

export class WebFetchClient {
  constructor(options = {}) {
    this.transport = options.transport ?? pinnedHttpRequest;
    this.resolve = options.resolve ?? resolveHost;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new ContractError('web_fetch_timeout_invalid', 'WebFetch timeout must be a positive integer');
    }
    this.policy = options.policy ?? new WebFetchDestinationPolicy(options.configPath);
  }

  async fetchText(input, signal) {
    let url = normalizeUrl(input);
    let redirectCount = 0;
    while (true) {
      const destination = await this.policy.classify(url);
      const addresses = await allowedWebAddresses(url, this.resolve, destination);
      const response = await this.transport(url, addresses[0], {
        method: 'GET', redirect: 'manual', signal: combinedSignal(signal, this.timeoutMs),
        headers: { accept: 'text/plain, text/html, application/json, application/xml, text/xml, text/markdown', 'user-agent': `NotNativeAgent/${VERSION}` },
      });
      if (isRedirect(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new ContractError('web_fetch_redirect_invalid', 'WebFetch redirect did not include a location');
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw new ContractError('web_fetch_redirect_invalid', 'WebFetch redirect bound was exceeded');
        }
        redirectCount += 1;
        url = normalizeUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) throw new ContractError('web_fetch_http_error', `WebFetch returned HTTP ${response.status}`, response.status >= 500);
      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
      if (!textType(contentType)) throw new ContractError('web_fetch_type_rejected', `WebFetch does not admit ${contentType || 'unknown content'}`);
      const bytes = await readBounded(response);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
        throw new ContractError('web_fetch_encoding_invalid', 'WebFetch response was not valid UTF-8');
      }
      return Object.freeze({ url: url.href, status: response.status, contentType, bytes: bytes.length, text });
    }
  }
}

export class WebFetchDestinationPolicy {
  constructor(configPath = null) { this.configPath = configPath; }
  async classify(url) {
    if (this.configPath) {
      const config = await loadWebFetchConfig(this.configPath);
      if (config.trusted_origins.includes(url.origin)) return 'trusted_private_origin';
    }
    if (isPrivateDestination(url)) throw blocked();
    return 'public_network';
  }
}

function normalizeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  url.hash = '';
  return url;
}

export async function allowedWebAddresses(url, resolver = resolveHost, destination = 'public_network') {
  const hostname = networkHostname(url.hostname);
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) throw blocked();
  if (destination === 'public_network' && addresses.some(privateAddress)) throw blocked();
  if (destination === 'reviewable_loopback_origin' && addresses.some((address) => !loopbackAddress(address))) throw blocked();
  return addresses;
}

function isPrivateDestination(url) {
  const hostname = networkHostname(url.hostname);
  if (hostname.toLowerCase() === 'localhost') return true;
  if (isIP(hostname)) return privateAddress(hostname);
  return false;
}

function networkHostname(value) {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

async function resolveHost(host) {
  return (await lookup(host, { all: true, verbatim: true })).map((item) => item.address);
}

function privateAddress(address) {
  const value = address.toLowerCase();
  if (value === '::' || value === '::1' || value === '0.0.0.0' || value.startsWith('fe80:')
    || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff') || value.startsWith('2001:db8:')) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : null);
  if (!ipv4) return false;
  const [a, b, c] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && [0, 2].includes(c)) || (a === 100 && b >= 64 && b <= 127)
    || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

function loopbackAddress(address) {
  const value = address.toLowerCase();
  if (value === '::1') return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : null);
  return ipv4?.startsWith('127.') === true;
}

async function readBounded(response) {
  if (!response.body) throw new ContractError('web_fetch_response_invalid', 'WebFetch response had no body');
  const output = Buffer.allocUnsafe(MAX_BYTES);
  let length = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (length + bytes.byteLength > MAX_BYTES) {
      throw new ContractError('web_fetch_response_too_large', 'WebFetch response exceeded 1 MiB');
    }
    bytes.copy(output, length);
    length += bytes.byteLength;
  }
  return output.subarray(0, length);
}

function combinedSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function textType(value) {
  return value.startsWith('text/') || ['application/json', 'application/xml'].includes(value) || value.endsWith('+json') || value.endsWith('+xml');
}

function isRedirect(status) { return [301, 302, 303, 307, 308].includes(status); }
function invalid() { return new ContractError('tool_schema_invalid', 'web.fetch requires one HTTP(S) URL without embedded credentials'); }
function blocked() { return new ContractError('web_fetch_destination_blocked', 'WebFetch destination is private or reserved and its exact origin is not trusted'); }

