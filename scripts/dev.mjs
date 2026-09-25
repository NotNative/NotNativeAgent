#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop dev launcher (doc 01 §15.1 equivalent).
 * Spawns the API server (Node, --watch) + Vite UI dev server, kills children on exit.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const API_PORT = process.env.NOTNATIVE_HMR_API_PORT ?? '3902';
const UI_PORT = process.env.NOTNATIVE_HMR_UI_PORT ?? '5180';
const HOST = process.env.NOTNATIVE_HMR_HOST ?? '127.0.0.1';

const children = [];
let closing = false;

function launch(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  const tag = `[${name}]`;
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) target.write(`${tag} ${line.trimEnd ? line.replace(/\r$/, '') : line}\n`);
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (closing) return;
    console.log(`${tag} exited (${code}); shutting down`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  closing = true;
  for (const c of children) {
    try { c.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

console.log(`NotNativeDesktop dev — API :${API_PORT} · UI :${UI_PORT}`);

launch('api', 'node', ['--watch', 'packages/web/src/server/index.ts'], {
  // Development remains self-contained unless an operator explicitly chooses
  // an NNA integration. Packaged/product boot defaults to the managed NNA child.
  env: { NOTNATIVE_PORT: API_PORT, NODE_ENV: 'development', NOTNATIVE_HARNESS: process.env.NOTNATIVE_HARNESS ?? 'mock' },
});

launch('ui', 'pnpm', ['--filter', '@notnative/web', 'exec', 'vite', '--host', HOST, '--port', UI_PORT, '--strictPort'], {
  env: { NOTNATIVE_HMR_API_PORT: API_PORT },
});
