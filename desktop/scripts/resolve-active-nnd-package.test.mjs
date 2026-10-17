// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { writeNnaSelection } from './write-nna-selection.mjs';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { writeInstalledServiceManifest } from './installed-service-package.mjs';
import { launchSelectedDesktop } from './launch-selected-desktop.mjs';
import { EventEmitter } from 'node:events';
import { saveLaunchPreferences } from './launch-preferences.mjs';

const windows = { skip: process.platform !== 'win32' };
const version = '20261003-17';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-resolve-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const install = join(base, 'nna'), data = join(base, 'data'), selected = join(base, 'nnd');
  await mkdir(join(install, 'installed', 'src'), { recursive: true });
  await mkdir(data); await mkdir(selected);
  const descriptor = { product: 'NotNativeAgent', version: '20261003-5', install_root: install,
    data_root: data, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]) };
  await writeFile(join(install, 'install.json'), JSON.stringify(descriptor));
  await writeFile(join(install, 'installed', 'package.json'), JSON.stringify({ name: 'not-native-agent', nna_version: descriptor.version, type: 'module' }));
  await writeFile(join(install, 'installed', 'VERSION'), descriptor.version);
  const cli = `import{readFileSync}from'node:fs';import{join}from'node:path';
    if(process.argv.slice(2).join(' ')!=='nnd package status'||!process.env.NNA_HOME||process.env.NODE_OPTIONS)process.exit(10);
    const status=JSON.parse(readFileSync(join(process.env.NNA_HOME,'status.json')));
    console.log(JSON.stringify(status));`;
  await writeFile(join(install, 'installed', 'src', 'cli.js'), cli);
  const runtime = readSelectedNativeRuntime(install);
  await writeNnaSelection(selected, install, runtime.installation_id, runtime.data_id);
  return { base, install, data, selected, descriptor, selection: join(selected, 'nna-service-selection.json') };
}
async function slot(f) {
  const files = new Map([
    ['package.json', JSON.stringify({ name: 'notnative-desktop', type: 'module', nnd_version: version,
      version: version.replace('-', '.0.') })], ['VERSION', version],
    ['packages/electron/main.mjs', 'console.log("shell")'],
    ['packages/electron/node_modules/electron/dist/electron.exe', Buffer.from('MZ fixture')],
  ]);
  const manifest = { schema_version: '1.0', version, platform: 'win32', architecture: 'x64',
    files: [...files].map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
  const bytes = Buffer.from(JSON.stringify(manifest)), hash = digest(bytes);
  const root = join(f.data, 'runtime', 'nnd', 'install-slots', 'versions', `${version}-${hash}`);
  await mkdir(root, { recursive: true });
  for (const [path, content] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'NND_PAYLOAD.json'), bytes);
  await writeFile(join(f.data, 'status.json'), JSON.stringify({ registered: true, valid: true, root, version }));
  return { root, hash };
}
test('selected native registration resolves only a sealed immutable slot', windows, async t => {
  const f = await fixture(t), s = await slot(f);
  const result = await resolveActiveNndPackage(f.selection);
  assert.equal(result.root, s.root); assert.equal(result.payloadSha256, s.hash);
  assert.equal(result.nnaInstallRoot, f.install);
  assert.equal(result.executable, join(s.root, 'packages/electron/node_modules/electron/dist/electron.exe'));
});

test('stable resolver accepts only the pinned fresh-source installation', windows, async t => {
  const f = await fixture(t);
  for (const folder of ['scripts', 'packages/electron/dist-server', 'packages/electron/node_modules/electron/dist', 'packages/web/dist']) {
    await mkdir(join(f.selected, folder), { recursive: true });
  }
  await writeFile(join(f.selected, 'package.json'), JSON.stringify({ name: 'notnative-desktop',
    version: version.replace('-', '.0.'), nnd_version: version }));
  await writeFile(join(f.selected, 'VERSION'), version);
  for (const file of ['scripts/serve-installed.mjs', 'packages/electron/dist-server/server.mjs',
    'packages/electron/main.mjs', 'packages/electron/node_modules/electron/dist/electron.exe',
    'packages/web/dist/index.html']) await writeFile(join(f.selected, file), 'source fixture');
  await writeInstalledServiceManifest(f.selected);
  await writeFile(join(f.data, 'status.json'), JSON.stringify({ registered: true, valid: true,
    root: f.selected, version }));
  const plan = await resolveActiveNndPackage(f.selection, f.selected);
  assert.equal(plan.root, f.selected);
  assert.equal(plan.payloadSha256, null);
  const runtime = readSelectedNativeRuntime(f.install);
  let invocationCount = 0;
  const spawnShell = (executable, args, options) => {
    invocationCount += 1;
    return { unref: () => { throw new Error('unexpected spawn wait'); } };
  };
  await assert.rejects(launchSelectedDesktop(f.selected, spawnShell, async selection => {
    assert.equal(selection.installRoot, f.install);
    assert.equal(selection.installation_id, runtime.installation_id);
    assert.equal(selection.data_id, runtime.data_id);
    throw new Error('nnd_service_not_running');
  }), /nnd_service_not_running/u);
  assert.equal(invocationCount, 0);
  let invoked;
  let startupAttempts = 0;
  const launched = await launchSelectedDesktop(f.selected, (executable, args, options) => {
    invoked = { executable, args, options };
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }, async selection => {
    assert.equal(selection.installRoot, f.install);
    assert.equal(selection.installation_id, runtime.installation_id);
    assert.equal(selection.data_id, runtime.data_id);
    return { generation: `fixture-generation-${++startupAttempts}` };
  });
  assert.equal(launched.root, f.selected);
  assert.equal(launched.version, version);
  assert.equal(launched.generation, 'fixture-generation-1');
  assert.equal(startupAttempts, 1);
  assert.equal(invoked.executable, plan.executable);
  assert.deepEqual(invoked.args, [join(f.selected, 'packages/electron/main.mjs'),
    '--nna-install-root', f.install, '--nnd-selection-file', f.selection,
    '--nnd-controller-generation', 'fixture-generation-1']);
  saveLaunchPreferences(join(f.data, 'config', 'desktop-launch.json'), { revision: 'absent', target: 'browser' });
  let browsers = 0, desktops = 0;
  const launch = () => { desktops += 1; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; };
  const probe = async () => ({ generation: 'current', origin: 'http://127.0.0.1:12345', ticket: 'one-use' });
  const browser = async (_anchor, action, ports) => { browsers += 1; assert.equal(action, 'browser'); assert.equal((await ports.attach()).generation, 'current'); };
  assert.equal((await launchSelectedDesktop(f.selected, launch, probe, { browser })).target, 'browser');
  assert.equal(browsers, 1); assert.equal(desktops, 0);
  await launchSelectedDesktop(f.selected, launch, probe, { forceDesktop: true, browser });
  assert.equal(desktops, 1); assert.equal(browsers, 1);
  await writeFile(join(f.selected, 'packages/electron/dist-server/server.mjs'), 'tampered');
  await assert.rejects(resolveActiveNndPackage(f.selection, f.selected), /incompatible/u);
});
test('pin change, inactive registration and source registration fail closed', windows, async t => {
  const f = await fixture(t), s = await slot(f), status = join(f.data, 'status.json');
  await writeFile(status, JSON.stringify({ registered: false }));
  await assert.rejects(resolveActiveNndPackage(f.selection), /inactive/u);
  await writeFile(status, JSON.stringify({ registered: true, valid: true, root: f.base, version }));
  await assert.rejects(resolveActiveNndPackage(f.selection));
  await writeFile(status, JSON.stringify({ registered: true, valid: true, root: s.root, version }));
  const other = join(f.base, 'other'); await mkdir(other);
  await writeFile(join(f.install, 'install.json'), JSON.stringify({ ...f.descriptor, data_root: other }));
  await assert.rejects(resolveActiveNndPackage(f.selection), /identity-changed/u);
});
test('tampered payload and selected-native command failure never yield a launch plan', windows, async t => {
  const f = await fixture(t), s = await slot(f);
  await writeFile(join(s.root, 'packages/electron/main.mjs'), 'tampered');
  await assert.rejects(resolveActiveNndPackage(f.selection), /source-changed/u);
  await writeFile(join(f.data, 'status.json'), '{bad');
  await assert.rejects(resolveActiveNndPackage(f.selection), /status-unavailable/u);
  assert.equal((await readFile(join(s.root, 'packages/electron/main.mjs'), 'utf8')), 'tampered');
});
test('selected NNA data identity changing during status verification cannot yield a stale plan', windows, async t => {
  const f = await fixture(t); await slot(f);
  const nextData = join(f.base, 'next-data'); await mkdir(nextData);
  await writeFile(join(f.install, 'switch.json'), JSON.stringify({ ...f.descriptor, data_root: nextData }));
  await writeFile(join(f.install, 'installed', 'src', 'cli.js'), `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const counter = join(process.env.NNA_HOME, 'status-count');
    const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
    writeFileSync(counter, String(count));
    if (count === 2) writeFileSync(join(process.cwd(), 'install.json'), readFileSync(join(process.cwd(), 'switch.json')));
    console.log(readFileSync(join(process.env.NNA_HOME, 'status.json'), 'utf8'));
  `);
  await assert.rejects(resolveActiveNndPackage(f.selection), /identity-changed/u);
});
