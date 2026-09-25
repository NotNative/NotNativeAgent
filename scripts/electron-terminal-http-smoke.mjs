// SPDX-License-Identifier: Apache-2.0
/** Exercise the packaged server's terminal HTTP + WebSocket path in Electron. */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = path.join(root, 'dist-electron', 'win-unpacked');
const executable = path.join(packaged, 'NotNativeDesktop.exe');
const serverBundle = path.join(packaged, 'resources', 'dist-server', 'server.mjs');
const webDist = path.join(packaged, 'resources', 'web-dist');
const marker = 'NND_PACKAGED_HTTP_TERMINAL_OK';
const requireWeb = createRequire(path.join(root, 'packages', 'web', 'package.json'));
const { WebSocket } = requireWeb('ws');

if (process.platform !== 'win32') throw new Error('packaged terminal HTTP smoke requires Windows');
for (const file of [executable, serverBundle, webDist]) {
  if (!existsSync(file)) throw new Error(`packaged artifact missing: ${file}`);
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'nnd-packaged-http-'));
const port = await unusedLoopbackPort();
const probe = `
  (async () => {
    const { pathToFileURL } = require('node:url');
    const { startServer } = await import(pathToFileURL(${JSON.stringify(serverBundle)}).href);
    const server = await startServer();
    console.log('NND_HTTP_READY ' + server.port);
    process.stdin.on('data', (data) => {
      if (!String(data).includes('STOP')) return;
      server.dispose();
      setTimeout(() => process.exit(0), 300).unref();
    });
    process.stdin.resume();
  })().catch((error) => { console.error(error); process.exit(1); });
`;
const child = spawn(executable, ['-e', probe], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NOTNATIVE_HOST: '127.0.0.1',
    NOTNATIVE_PORT: String(port),
    NOTNATIVE_HARNESS: 'mock',
    NOTNATIVE_DATA_DIR: dataDir,
    NOTNATIVE_DIST_DIR: webDist,
    NOTNATIVE_RUNTIME: 'desktop',
  },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
let childError = null;
child.on('error', (error) => { childError = error; });
child.stdin.on('error', () => {}); // The server may exit before the STOP write.
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

try {
  await until(() => stdout.includes(`NND_HTTP_READY ${port}`), 10_000, 'packaged server did not start');
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3_000) });
  if (!health.ok) throw new Error(`packaged health returned ${health.status}`);

  const createdResponse = await fetch(`${base}/api/terminal/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: root, mode: 'command', command: `echo ${marker}` }),
    signal: AbortSignal.timeout(5_000),
  });
  const created = await createdResponse.json();
  if (!createdResponse.ok || typeof created.sessionId !== 'string') {
    throw new Error(`packaged terminal create failed: ${createdResponse.status} ${JSON.stringify(created)}`);
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws`);
  let socketError = null;
  socket.on('error', (error) => { socketError = error; });
  try {
    await until(() => {
      if (socketError) throw socketError;
      if (socket.readyState === WebSocket.CLOSED) throw new Error('terminal WebSocket closed before opening');
      return socket.readyState === WebSocket.OPEN;
    }, 3_000, 'packaged terminal WebSocket did not open');
    const frames = [];
    let frameError = null;
    socket.on('message', (data) => {
      try {
        const bytes = Buffer.from(data);
        if (bytes[0] === 1) frames.push(JSON.parse(bytes.subarray(1).toString('utf8')));
      } catch (error) {
        frameError = error;
      }
    });
    socket.send(Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify({ v: 3, t: 'attach', s: created.sessionId }))]));
    await until(() => {
      if (socketError) throw socketError;
      if (frameError) throw frameError;
      if (socket.readyState === WebSocket.CLOSED) throw new Error('terminal WebSocket closed before exit frame');
      return frames.some((frame) => frame.t === 'snapshot') && frames.some((frame) => frame.t === 'exit');
    },
      8_000, 'packaged terminal did not send snapshot and exit frames');
    const output = frames.map((frame) => `${frame.history ?? ''}${frame.d ?? ''}`).join('');
    const exit = frames.find((frame) => frame.t === 'exit');
    if (!output.includes(marker) || exit.exitCode !== 0) {
      throw new Error(`packaged terminal output/exit mismatch: ${JSON.stringify(frames).slice(-1000)}`);
    }
  } finally {
    socket.terminate();
  }
  console.log('packaged Electron terminal HTTP/WebSocket flow passed');
} catch (error) {
  throw new Error(`${error.message}; stdout=${stdout.slice(-1000)}; stderr=${stderr.slice(-1000)}`, { cause: error });
} finally {
  const closed = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', resolve);
  });
  if (child.stdin.writable && !child.stdin.destroyed) child.stdin.end('STOP\n');
  await Promise.race([closed, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([closed, delay(2_000)]);
  }
  rmSync(dataDir, { recursive: true, force: true });
}

async function unusedLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const result = address.port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function until(check, timeoutMs, message) {
  const start = Date.now();
  while (!check()) {
    if (childError) throw childError;
    if (child.exitCode !== null || child.signalCode !== null || Date.now() - start > timeoutMs) throw new Error(message);
    await delay(25);
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
