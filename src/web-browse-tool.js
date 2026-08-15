// SPDX-License-Identifier: Apache-2.0
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { loadManagedPlaywright } from './playwright-runtime.js';
import { WebFetchDestinationPolicy, allowedWebAddresses } from './web-fetch-tool.js';

const ACTIONS = new Set(['navigate', 'inspect', 'click', 'fill', 'fill_secret', 'press', 'screenshot', 'close']);
const MAX_TEXT = 65_536;
const MAX_ELEMENTS = 100;

export function webBrowseDefinition(options = {}) {
  const manager = options.manager ?? new BrowserSessionManager(options);
  const definition = {
    name: 'web.browse', version: 1,
    purpose: 'Operate an ephemeral Chromium session. Navigate and inspect pages, click controls, fill non-secret values, inject a named secret field without exposing it to the model, press keys, save a screenshot, or close the browser. Use inspect after navigation to obtain stable element references such as e1.',
    sideEffect: 'unknown', scope: 'browser', cancellation: true, timeoutMs: 60_000,
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'Required browser operation.' },
        url: { type: 'string', maxLength: 4096, description: 'Required complete HTTP(S) URL only for navigate.' },
        target: { type: 'string', maxLength: 1024, description: 'Element reference from inspect (for example e1) or a CSS selector.' },
        value: { type: 'string', maxLength: 20_000, description: 'Non-secret text for fill.' },
        key: { type: 'string', maxLength: 64, description: 'Keyboard key or chord required for press, for example Enter or Control+A.' },
        secret_id: { type: 'string', maxLength: 128, description: 'Configured secret-broker id required for fill_secret.' },
        secret_field: { type: 'string', maxLength: 64, description: 'Named field within secret_id required for fill_secret.' },
      },
    },
    validate: async (args) => validateBrowseArgs(args, manager),
    executor: (request, signal, execution) => manager.execute(request.args, signal, execution),
  };
  Object.defineProperty(definition, 'manager', { value: manager, enumerable: false });
  return definition;
}

export class BrowserSessionManager {
  constructor(options = {}) {
    this.root = normalizeRoot(options.root);
    this.managedPlaywrightRoot = options.managedPlaywrightRoot;
    this.loadPlaywright = options.loadPlaywright ?? loadManagedPlaywright;
    this.policy = options.policy ?? new WebFetchDestinationPolicy(options.configPath);
    this.resolveHost = options.resolveHost;
    this.secretBroker = options.secretBroker ?? null;
    this.sessionId = options.sessionId ?? 'session';
    this.browser = null; this.context = null; this.page = null; this.pagePromise = null;
    this.refs = new Map(); this.secretValues = new Set();
  }

  async classifyUrl(value) {
    const url = normalizeHttpUrl(value);
    const destination = await this.policy.classify(url);
    await allowedWebAddresses(url, this.resolveHost, destination);
    return { url, destination };
  }

  async execute(args, signal, execution = {}) {
    if (signal?.aborted) throw new ContractError('tool_cancelled', 'browser operation was cancelled');
    if (args.action === 'close') { await this.close(); return result('Browser session closed.', { action: 'close' }); }
    const page = await this.#page();
    if (args.action === 'navigate') {
      const destination = await this.classifyUrl(args.url);
      await page.goto(destination.url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      this.refs.clear();
      return result(await this.#summary(page), metadata(args.action, page, { destination: destination.destination }));
    }
    if (args.action === 'inspect') return result(await this.#inspect(page), metadata(args.action, page));
    if (args.action === 'screenshot') {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const path = join(this.root, `screenshot-${Date.now()}.png`);
      await page.screenshot({ path, fullPage: true });
      return result(`Screenshot saved: ${path}`, metadata(args.action, page, { path }));
    }
    const locator = this.#locator(page, args.target);
    if (args.action === 'click') await locator.click({ timeout: 15_000 });
    else if (args.action === 'fill') await locator.fill(args.value, { timeout: 15_000 });
    else if (args.action === 'press') await locator.press(args.key, { timeout: 15_000 });
    else if (args.action === 'fill_secret') await this.#fillSecret(locator, args, page, execution);
    this.refs.clear();
    return result(await this.#summary(page), metadata(args.action, page));
  }

  async close() {
    const context = this.context; const browser = this.browser;
    this.page = null; this.pagePromise = null; this.context = null; this.browser = null;
    this.refs.clear(); this.secretValues.clear();
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (this.root) await rm(this.root, { recursive: true, force: true }).catch(() => undefined);
  }

  async #page() {
    if (this.page) return this.page;
    if (this.pagePromise) return this.pagePromise;
    this.pagePromise = this.#openPage();
    try { return await this.pagePromise; }
    finally { this.pagePromise = null; }
  }

  async #openPage() {
    const loaded = await this.loadPlaywright(this.managedPlaywrightRoot);
    this.browser = await loaded.playwright.chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ acceptDownloads: false });
    await this.context.route('**/*', async (route) => {
      const value = route.request().url();
      if (/^(?:about:blank|data:|blob:)/u.test(value)) return route.continue();
      try { await this.classifyUrl(value); return route.continue(); }
      catch { return route.abort('blockedbyclient'); }
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  async #inspect(page) {
    const summary = await this.#summary(page);
    const elements = await page.locator('a,button,input,textarea,select,[role="button"],[role="link"]').evaluateAll((nodes, maximum) => nodes.slice(0, maximum).map((node, index) => ({
      index, tag: node.tagName.toLowerCase(), type: node.getAttribute('type'), role: node.getAttribute('role'),
      text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().slice(0, 240),
    })), MAX_ELEMENTS);
    this.refs.clear();
    const lines = elements.map((item) => {
      const ref = `e${item.index + 1}`; this.refs.set(ref, item.index);
      return `[${ref}] <${item.tag}${item.type ? ` type=${item.type}` : ''}${item.role ? ` role=${item.role}` : ''}> ${item.text}`;
    });
    return `${summary}\n\nInteractive elements (${lines.length}):\n${lines.join('\n')}`;
  }

  async #summary(page) {
    const title = await page.title();
    const text = this.#redact(String(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')).slice(0, MAX_TEXT));
    return `URL: ${page.url()}\nTitle: ${title}\n\n${text}`;
  }

  #locator(page, target) {
    const index = this.refs.get(target);
    return index === undefined
      ? page.locator(target).first()
      : page.locator('a,button,input,textarea,select,[role="button"],[role="link"]').nth(index);
  }

  async #fillSecret(locator, args, page, execution) {
    if (!this.secretBroker) throw new ContractError('secret_broker_unavailable', 'Secret Broker is unavailable for this browser session');
    const decisionId = execution.reviewerDecisionId;
    if (!decisionId) throw new ContractError('secret_review_missing', 'browser secret injection requires a committed reviewer decision');
    await this.secretBroker.withSecret(args.secret_id, {
      consumer: 'web.browse', destination: new URL(page.url()).origin,
      purpose: `Fill browser field ${args.secret_field}`, reviewerDecisionId: decisionId, sessionId: this.sessionId,
    }, async (fields) => {
      if (!(args.secret_field in fields)) throw new ContractError('secret_field_not_found', 'the requested field is not present in this secret');
      this.secretValues.add(fields[args.secret_field]);
      await locator.fill(fields[args.secret_field], { timeout: 15_000 });
    });
  }

  #redact(value) {
    let redacted = value;
    for (const secret of this.secretValues) redacted = redacted.split(secret).join('[nna-redacted:browser-secret]');
    return redacted;
  }
}

async function validateBrowseArgs(args, manager) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || !ACTIONS.has(args.action)
    || Object.keys(args).some((key) => !['action', 'url', 'target', 'value', 'key', 'secret_id', 'secret_field'].includes(key))) throw invalid();
  const limits = { url: 4096, target: 1024, value: 20_000, key: 64, secret_id: 128, secret_field: 64 };
  for (const [key, maximum] of Object.entries(limits)) {
    if (args[key] !== undefined && (typeof args[key] !== 'string' || args[key].length > maximum || /\u0000/u.test(args[key]))) {
      throw invalid(`browser argument "${key}" is invalid`);
    }
  }
  const required = { navigate: ['url'], click: ['target'], fill: ['target', 'value'], fill_secret: ['target', 'secret_id', 'secret_field'], press: ['target', 'key'] }[args.action] ?? [];
  const missing = required.find((key) => typeof args[key] !== 'string' || !args[key].length);
  if (missing) throw invalid(`browser action "${args.action}" requires argument "${missing}"`);
  const normalized = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  let destination = null; let origin = null;
  if (args.action === 'navigate') { const checked = await manager.classifyUrl(args.url); normalized.url = checked.url.href; destination = checked.destination; origin = checked.url.origin; }
  return { args: normalized, resolved: { action: args.action, destination, origin, readOnly: ['navigate', 'inspect', 'close'].includes(args.action) } };
}

function normalizeHttpUrl(value) {
  let url; try { url = new URL(value); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
  url.hash = ''; return url;
}
function normalizeRoot(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new ContractError('browser_root_invalid', 'browser session root must be absolute');
  return resolve(value);
}
function result(content, metadata) { return { content, metadata }; }
function metadata(action, page, extra = {}) { return { action, url: page.url(), ...extra }; }
function invalid(message = 'web.browse arguments do not match the requested browser action') {
  return new ContractError('tool_schema_invalid', message);
}
