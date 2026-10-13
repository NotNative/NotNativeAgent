// SPDX-License-Identifier: Apache-2.0
/** Prove that the packaged Windows Electron runtime can spawn a real PTY. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = path.join(root, 'dist-electron', 'win-unpacked');
const executable = path.join(packaged, 'NotNativeDesktop.exe');
const nativePackage = path.join(packaged, 'resources', 'dist-server', 'node_modules', 'node-pty');
const marker = 'NND_PACKAGED_TERMINAL_OK';

if (process.platform !== 'win32') throw new Error('packaged terminal smoke requires Windows');
for (const file of [executable, path.join(nativePackage, 'package.json')]) {
  if (!existsSync(file)) throw new Error(`packaged terminal artifact missing: ${file}`);
}

const probe = `
  const pty = require(${JSON.stringify(nativePackage)});
  let output = '';
  let finished = false;
  const terminal = pty.spawn('cmd.exe', ['/d', '/s', '/c', 'echo ${marker}'], {
    name: 'xterm-color', cols: 80, rows: 24, cwd: ${JSON.stringify(root)}, env: process.env,
  });
  const fail = (reason) => { console.error(reason); process.exit(1); };
  const complete = (code) => {
    if (finished) return;
    finished = true;
    if (code !== 0 || !output.includes('${marker}')) fail('PTY exited without expected output: code=' + code + ' output=' + output);
    console.log('${marker}');
    process.exit(0);
  };
  terminal.onData((chunk) => { output += chunk; });
  terminal.onExit(({ exitCode }) => complete(exitCode));
  setTimeout(() => fail('PTY did not exit: output=' + output), 8000);
`;

const child = spawn(executable, ['-e', probe], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
const timeout = setTimeout(() => child.kill(), 12_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code));
});
clearTimeout(timeout);
if (exitCode !== 0 || !stdout.includes(marker)) {
  throw new Error(`packaged PTY spawn failed: exit=${exitCode} stdout=${stdout.slice(-1000)} stderr=${stderr.slice(-1000)}`);
}
console.log('packaged Electron terminal spawn passed');
