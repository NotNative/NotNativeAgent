// SPDX-License-Identifier: Apache-2.0
/** Node entrypoint for a future NNA-supervised, shell-independent GUI door. */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function configureInstalledService(args, options = {}) {
  if (args.length !== 2 || args[0] !== '--port' || !/^[1-9]\d{0,4}$/u.test(args[1])) {
    throw new Error('usage: serve-installed.mjs --port 1..65535');
  }
  const port = Number(args[1]);
  if (port > 65_535) throw new Error('service port must be between 1 and 65535');
  const root = realpathSync(options.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(root, 'nna-integration', 'nnd-local', 'integration.json'), 'utf8'));
  const bundle = join(root, 'packages', 'electron', 'dist-server', 'server.mjs');
  const dist = join(root, 'packages', 'web', 'dist');
  if (manifest.id !== 'nnd-local' || manifest.ownership !== 'nnd' || manifest.scope !== 'local-gui'
    || manifest.nna_integration_protocol !== '1.0' || manifest.version !== packageInfo.nnd_version
    || !existsSync(bundle) || !existsSync(join(dist, 'index.html'))) {
    throw new Error('installed NND package is incomplete or incompatible');
  }
  const environment = options.environment ?? process.env;
  environment.NOTNATIVE_HOST = '127.0.0.1';
  environment.NOTNATIVE_PORT = String(port);
  environment.NOTNATIVE_DIST_DIR = dist;
  environment.NOTNATIVE_RUNTIME = 'service';
  environment.NOTNATIVE_APP_VERSION = packageInfo.version;
  environment.NOTNATIVE_HARNESS = 'nna';
  environment.NOTNATIVE_NNA_MODE = 'managed';
  environment.NNA_NND_INSTALL_ROOT = root;
  // In this standalone process there is no Electron guest or IPC controller.
  // Do not advertise a browser tool whose requests can never be fulfilled.
  environment.NOTNATIVE_BROWSER_BRIDGE = 'disabled';
  return { port, root, version: manifest.version, bundle };
}

export async function runInstalledService(args = process.argv.slice(2)) {
  const configured = configureInstalledService(args);
  // Invariant: stdout is protocol-only. Hono/terminal/relay diagnostics go to
  // stderr, so an NNA supervisor never mistakes logging for a readiness frame.
  console.log = console.info = console.debug = (...parts) => console.error(...parts);
  const { startServer } = await import(pathToFileURL(configured.bundle).href);
  const handle = await startServer();
  if (handle.port !== configured.port) {
    handle.dispose();
    throw new Error('NND service bound an unexpected port');
  }
  process.stdout.write(`${JSON.stringify({ type: 'ready', protocol: '1.0',
    endpoint: `http://127.0.0.1:${configured.port}`, version: configured.version })}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runInstalledService().catch((error) => {
    console.error(`NND installed service failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
