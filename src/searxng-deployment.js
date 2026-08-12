// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from './ids.js';
import { SearxngClient } from './searxng-client.js';

export const MANAGED_SEARXNG_ENDPOINT = 'http://127.0.0.1:8888';
const DEFAULT_RESOURCES = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'searxng');

export class SearxngDeployment {
  constructor(options = {}) {
    this.root = options.root;
    this.resources = options.resources ?? DEFAULT_RESOURCES;
    this.run = options.run ?? runProcess;
    this.client = options.client ?? new SearxngClient({ timeoutMs: 3_000 });
    this.portAvailable = options.portAvailable ?? isPortAvailable;
  }

  async preflight() {
    await this.run('docker', ['version', '--format', '{{.Server.Version}}']);
    await this.run('docker', ['compose', 'version']);
    const platform = (await this.run('docker', ['info', '--format', '{{.OSType}}'])).stdout.trim();
    if (platform !== 'linux') throw new ContractError('docker_linux_required', 'Managed SearXNG requires Docker in Linux-container mode');
    return Object.freeze({ docker: true, compose: true, platform });
  }

  async deploy() {
    const preflight = await this.preflight();
    await this.#stage();
    const services = await this.#compose(['ps', '--status', 'running', '--services']).then((value) => value.stdout.trim(), () => '');
    const managedRunning = services.split(/\r?\n/u).includes('searxng');
    if (!managedRunning && !await this.portAvailable(8888, '127.0.0.1')) {
      throw new ContractError('web_search_port_unavailable', 'Port 8888 is already in use; configure that endpoint or free the port');
    }
    await this.#compose(['up', '-d', '--force-recreate']);
    const validation = await this.#waitUntilReady();
    return Object.freeze({ ...preflight, ...validation, managed: true, root: this.root });
  }

  async refreshIfNeeded() {
    if (await this.#managedProfileIsCurrent()) {
      return Object.freeze({ refreshed: false, skipped: true, reason: 'current', managed: true, endpoint: MANAGED_SEARXNG_ENDPOINT });
    }
    return Object.freeze({ ...await this.deploy(), refreshed: true });
  }

  async start() {
    await this.preflight();
    await this.#stage();
    await this.#compose(['up', '-d']);
    return this.#waitUntilReady();
  }

  async stop() {
    await this.preflight();
    await this.#compose(['stop']);
    return Object.freeze({ stopped: true, managed: true, endpoint: MANAGED_SEARXNG_ENDPOINT });
  }

  async remove() {
    const composePath = join(this.root, 'compose.yaml');
    let staged = true;
    try { await access(composePath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      staged = false;
    }
    if (staged) {
      await this.preflight();
      await this.#compose(['down', '--remove-orphans']);
    }
    await rm(this.root, { recursive: true, force: true });
    return Object.freeze({ removed: staged, managed: true, endpoint: MANAGED_SEARXNG_ENDPOINT });
  }

  async status() {
    const search = await this.client.test(MANAGED_SEARXNG_ENDPOINT).catch((error) => ({ ok: false, error: error.code ?? error.message }));
    let container = 'unavailable';
    try { container = (await this.#compose(['ps', '--status', 'running', '--services'])).stdout.trim() || 'stopped'; } catch {}
    return Object.freeze({ endpoint: MANAGED_SEARXNG_ENDPOINT, container, search });
  }

  async #stage() {
    await mkdir(join(this.root, 'config'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'data'), { recursive: true, mode: 0o700 });
    await copyFile(join(this.resources, 'compose.yaml'), join(this.root, 'compose.yaml'));
    await copyFile(join(this.resources, 'settings.yml'), join(this.root, 'config', 'settings.yml'));
    await copyFile(join(this.resources, 'limiter.toml'), join(this.root, 'config', 'limiter.toml'));
    await writeIfMissing(join(this.root, '.env'), `SEARXNG_SECRET=${randomBytes(32).toString('hex')}\n`);
  }

  async #managedProfileIsCurrent() {
    const pairs = [
      ['compose.yaml', 'compose.yaml'],
      ['settings.yml', join('config', 'settings.yml')],
      ['limiter.toml', join('config', 'limiter.toml')],
    ];
    for (const [source, target] of pairs) {
      if (!await filesEqual(join(this.resources, source), join(this.root, target))) return false;
    }
    return true;
  }

  #compose(arguments_) {
    return this.run('docker', ['compose', '-f', join(this.root, 'compose.yaml'), '--env-file', join(this.root, '.env'), ...arguments_]);
  }

  async #waitUntilReady() {
    let latest;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try { return await this.client.test(MANAGED_SEARXNG_ENDPOINT); } catch (error) { latest = error; }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new ContractError('web_search_health_timeout', `Managed SearXNG did not become ready: ${latest?.code ?? 'health check failed'}`);
  }
}

function runProcess(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 120_000, maxBuffer: 1_048_576 }, (error, stdout, stderr) => {
    if (error) {
      const result = new ContractError('docker_unavailable', String(stderr || error.message).trim().slice(0, 1024));
      result.cause = error;
      reject(result);
    } else resolve({ stdout: String(stdout), stderr: String(stderr) });
  }));
}

function isPortAvailable(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

async function writeIfMissing(path, content) {
  try { await writeFile(path, content, { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

async function filesEqual(left, right) {
  try {
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
    return leftContent.equals(rightContent);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
