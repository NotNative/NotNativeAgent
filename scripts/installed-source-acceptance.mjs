// SPDX-License-Identifier: Apache-2.0
/** Windows-only real source installer acceptance with disposable NNA and shell profiles. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// The source installer refuses a target anywhere below its own checkout.
// Native manifest storage rejects the shared project volume's inherited ACL.
// A signed-in user's profile has the same trusted ancestor chain as NNA data.
const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
const delay = ms => new Promise(done => setTimeout(done, ms));
let childUncertain = false;
export function acceptanceEvidence() {
  return { uncertain: childUncertain };
}

export async function checkedFixturePath(path, fixtureBase = base) {
  const canonicalBase = await realpath(fixtureBase);
  const canonical = await realpath(path);
  const part = relative(canonicalBase, canonical);
  assert.match(part, /^(?:installed-accept-[a-f0-9]{16}|nnd-accept-[a-f0-9]{10})$/u);
  assert.equal(dirname(canonical), canonicalBase);
  for (const item of [canonicalBase, canonical]) assert.equal((await lstat(item)).isSymbolicLink(), false);
  return canonical;
}
export async function privateDirectory(path, fixtureBase = base) {
  const script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd();"
    + "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;"
    + "$acl=[Security.AccessControl.DirectorySecurity]::new();"
    + "$acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')"
    + "(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');"
    + '[void][IO.Directory]::CreateDirectory($p,$acl)';
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script],
    { input: path, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, 'Could not create private installed acceptance fixture');
  await checkedFixturePath(path, fixtureBase);
}
async function readOutputTail(path) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, 3000);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export async function run(executable, args, { cwd, env, timeout = 30000, outputFiles } = {}) {
  let out, err, child;
  try {
    out = outputFiles ? await open(outputFiles.stdout, 'w') : null;
    err = outputFiles ? await open(outputFiles.stderr, 'w') : null;
    child = spawn(executable, args, { cwd, env, windowsHide: true,
      stdio: ['ignore', out?.fd ?? 'pipe', err?.fd ?? 'pipe'] });
  } catch (error) {
    await Promise.allSettled([out?.close(), err?.close()]);
    throw error;
  }
  let stdout = '', stderr = '', exceeded = false;
  child.stdout?.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 131072) { exceeded = true; childUncertain = true; child.kill(); }
  });
  child.stderr?.on('data', chunk => { stderr += chunk; if (stderr.length > 131072) { exceeded = true; childUncertain = true; child.kill(); } });
  let code;
  try {
    code = await new Promise((done, reject) => {
      const timer = setTimeout(() => { childUncertain = true; child.kill(); reject(new Error('Acceptance child timed out')); }, timeout);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once(outputFiles ? 'exit' : 'close', exit => { clearTimeout(timer); done(exit); });
    });
  } finally { await Promise.all([out?.close(), err?.close()]); }
  if (outputFiles) {
    stderr = await readOutputTail(outputFiles.stderr);
    stdout = await readOutputTail(outputFiles.stdout);
  }
  assert.equal(exceeded, false, 'Acceptance child output exceeded bound');
  assert.equal(code, 0, `Acceptance child failed (${code}): ${stderr.slice(-3000)} ${stdout.slice(-3000)}`);
  return stdout;
}
export async function cli(fixture, action) {
  const output = await run(process.execPath, [fixture.cli, 'nnd', 'service', action, fixture.nna],
    { cwd: fixture.root, env: fixture.env, timeout: 45000 });
  return JSON.parse(output.trim());
}
export async function selectedPackage(fixture) {
  const output = await run(process.execPath, [fixture.cli, 'nnd', 'package', 'status'],
    { cwd: fixture.root, env: fixture.env, timeout: 45000 });
  return JSON.parse(output.trim());
}
function chromiumScript(origin, mode, mainUrl) {
  return `import {app,BrowserWindow,dialog} from 'electron';
import {appendFileSync} from 'node:fs';
const phase=value=>appendFileSync(${JSON.stringify(mainUrl.debugPath)},value+'\\n');
phase('module_loaded');
dialog.showErrorBox=(_title,message)=>{phase('startup_error:'+String(message).slice(0,160))};
app.setPath('userData',${JSON.stringify(mainUrl.userData)});
let done=false;const timer=setTimeout(()=>{process.stderr.write('acceptance Chromium timeout\\n');app.exit(1)},${mode === 'desktop' ? 150000 : 45000});
function finish(ok){if(done)return;done=true;clearTimeout(timer);if(ok)process.stdout.write('NND_INSTALLED_${mode === 'browser' ? 'BROWSER' : 'DESKTOP'}_OK\\n');app.exit(ok?0:1)}
app.whenReady().then(async()=>{
try{
phase('app_ready');
${mode === 'browser' ? `const {readFile,unlink}=await import('node:fs/promises');
const ticketPath=${JSON.stringify(mainUrl.ticketPath)};
const ticket=(await readFile(ticketPath,'utf8')).trim();await unlink(ticketPath);
if(ticket.length!==43)throw Error('Native ticket handoff length '+ticket.length);
const win=new BrowserWindow({show:false,webPreferences:{partition:'temp:nnd-accept-browser',nodeIntegration:false,contextIsolation:true,sandbox:true}});
await win.loadURL(${JSON.stringify(origin)});
win.show();win.focus();
let inputReady=false;for(let i=0;i<100;i++){inputReady=await win.webContents.executeJavaScript('Boolean(document.getElementById("native-bootstrap-code"))');if(inputReady)break;await new Promise(r=>setTimeout(r,100))}
if(!inputReady)throw Error('Native code form did not authenticate: input_missing');
await win.webContents.executeJavaScript('document.getElementById("native-bootstrap-code").focus()');
for(const key of ticket)win.webContents.sendInputEvent({type:'char',keyCode:key});
const accepted=await win.webContents.executeJavaScript('(async()=>{let button;for(let j=0;j<100;j++){button=document.querySelector("[data-testid=gate-native-bootstrap] button");if(button&&!button.disabled)break;await new Promise(r=>setTimeout(r,100))}if(!button||button.disabled){const input=document.getElementById("native-bootstrap-code");return "button_disabled_length_"+(input?.value.length||0)+"_focused_"+(document.activeElement===input)}button.click();let code=0;for(let j=0;j<100;j++){const response=await fetch("/auth/session");code=response.status;const status=await response.json();if(code===200&&status.authenticated===true)return "ok";await new Promise(r=>setTimeout(r,100))}return "session_"+code+"_"+(document.querySelector("[role=alert]")?.textContent||"").slice(0,80)})()');
if(accepted!=='ok')throw Error('Native code form did not authenticate: '+accepted);
const other=new BrowserWindow({show:false,webPreferences:{partition:'temp:nnd-accept-other',nodeIntegration:false,contextIsolation:true,sandbox:true}});
await other.loadURL(${JSON.stringify(origin)});
const isolated=await other.webContents.executeJavaScript('(async()=>{const response=await fetch("/auth/session");return {status:response.status,body:await response.json()}})()');
if(isolated.status!==401||isolated.body.authenticated!==false)throw Error('Independent browser partition did not retain the unauthenticated session contract');
finish(true);` : `app.on('browser-window-created',(_event,win)=>{phase('window_created');
win.webContents.on('did-finish-load',async()=>{if(done||!win.webContents.getURL().startsWith(${JSON.stringify(origin)}))return;
phase('window_loaded');
try{const result=await win.webContents.executeJavaScript('(async()=>{const response=await fetch("/auth/session");return {status:response.status,authenticated:(await response.json()).authenticated,token:window.__NOTNATIVE_CLIENT_TOKEN__||"",headers:window.__NOTNATIVE_RUNTIME_HEADERS__||{}}})()');
if(result.status!==200||result.authenticated!==true||result.token||Object.keys(result.headers).length)throw Error('Desktop attach missing or bearer exposed');finish(true)}catch(e){process.stderr.write(String(e));finish(false)}})});
phase('import_start');await import(${JSON.stringify(mainUrl.main)});phase('import_returned');`}
}catch(error){process.stderr.write(String(error));finish(false)} });`;
}
export async function shell(fixture, mode, origin, ticket, extraArgs = []) {
  const probeId = randomUUID().replaceAll('-', '').slice(0, 16);
  const shellData = join(fixture.root, `${mode}-profile-${probeId}`);
  await mkdir(shellData);
  const wrapper = join(fixture.root, `${mode}-probe-${probeId}.mjs`);
  const debugPath = join(fixture.root, `${mode}-phase-${probeId}.log`);
  const ticketPath = mode === 'browser' ? join(fixture.root, `browser-ticket-${probeId}.txt`) : null;
  const electron = join(fixture.nnd, 'packages/electron/node_modules/electron/dist/electron.exe');
  const env = { ...fixture.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  const outputFiles = mode === 'desktop' ? {
    stdout: join(fixture.root, `desktop-stdout-${probeId}.log`),
    stderr: join(fixture.root, `desktop-stderr-${probeId}.log`),
  } : null;
  let output;
  try {
    if (ticketPath) {
      assert.equal(typeof ticket, 'string');
      const handle = await open(ticketPath, 'wx', 0o600);
      try { await handle.writeFile(ticket); await handle.sync(); } finally { await handle.close(); }
    }
    await writeFile(wrapper, chromiumScript(origin, mode, { userData: shellData,
      main: pathToFileURL(join(fixture.nnd, 'packages/electron/main.mjs')).href, ticketPath, debugPath }));
    // Desktop native attach can consume multiple bounded CLI attempts before
    // the renderer loads; keep the acceptance watchdog outside that budget.
    output = await run(electron, [wrapper, '--hidden', ...extraArgs], { cwd: fixture.root, env,
      timeout: mode === 'desktop' ? 165000 : 60000, outputFiles });
  }
  finally { if (ticketPath) await unlink(ticketPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  if (outputFiles) output = await readOutputTail(outputFiles.stdout);
  assert.match(output, new RegExp(`NND_INSTALLED_${mode.toUpperCase()}_OK`, 'u'));
}
export async function prepare(nnaSource, root) {
  const nna = join(root, 'NNA'), data = join(root, 'data'), nnd = join(root, 'NND');
  const payload = join(nna, 'installed');
  await mkdir(payload, { recursive: true }); await mkdir(join(data, 'config'), { recursive: true });
  for (const item of ['src', 'resources', 'package.json', 'VERSION'])
    await cp(join(nnaSource, item), join(payload, item), { recursive: true });
  const version = (await readFile(join(payload, 'VERSION'), 'utf8')).trim();
  await writeFile(join(nna, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', version,
    install_root: nna, data_root: data, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]) }));
  const shortcuts = join(root, 'shortcuts'); await mkdir(shortcuts);
  await writeFile(join(shortcuts, '.nnd-disposable-shortcuts'), 'nnd-disposable-shortcuts-v1\n');
  for (const item of ['tmp', 'roaming', 'local', 'electron-cache', 'pnpm-store', 'npm-cache',
    'corepack', 'home', 'xdg-config', 'xdg-cache', 'xdg-data']) await mkdir(join(root, item));
  const overrides = { NNA_HOME: data, USERPROFILE: root, HOME: join(root, 'home'),
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'),
    TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), ELECTRON_CACHE: join(root, 'electron-cache'),
    npm_config_store_dir: join(root, 'pnpm-store'), npm_config_cache: join(root, 'npm-cache'),
    COREPACK_HOME: join(root, 'corepack'), XDG_CONFIG_HOME: join(root, 'xdg-config'),
    XDG_CACHE_HOME: join(root, 'xdg-cache'), XDG_DATA_HOME: join(root, 'xdg-data') };
  const env = { ...process.env };
  const replaced = new Set(Object.keys(overrides).map(key => key.toUpperCase()));
  for (const key of Object.keys(env)) if (replaced.has(key.toUpperCase())
    || /^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NNA_INTEGRATION_TOKEN|NNA_PRINCIPAL|NNA_HARNESS_URL|NNA_NND_.*|NND_.*|NOTNATIVE_.*)$/iu.test(key)) delete env[key];
  Object.assign(env, overrides);
  return { root, nna, data, nnd, shortcuts, env, cli: join(payload, 'src/cli.js') };
}
export async function waitStopped(fixture) {
  const module = name => import(pathToFileURL(join(fixture.nna, 'installed/src', name)).href);
  const [{ readNndServiceIdentity }, { readNndServiceDiscovery }, { acquireNndServiceLock }] = await Promise.all([
    module('nnd-service-identity.js'), module('nnd-service-discovery.js'), module('nnd-service-lock.js'),
  ]);
  const identity = await readNndServiceIdentity(fixture.nna);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await readNndServiceDiscovery(identity) === null) {
      try { const lease = await acquireNndServiceLock({ dataRoot: fixture.data }); await lease.close(); return; }
      catch (error) { if (error.code !== 'nnd_service_already_running') throw error; }
    }
    await delay(100);
  }
  throw new Error('Selected native service stop remains uncertain');
}
async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  await mkdir(base, { recursive: true });
  assert.equal((await lstat(base)).isSymbolicLink(), false, 'Fixture base cannot be a link');
  assert.equal(await realpath(base), resolve(base), 'Fixture base must not redirect');
  const root = join(base, `installed-accept-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  await privateDirectory(root);
  const fixture = await prepare(nnaSource, root);
  let serviceStopped = false;
  try {
    await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
      '-ShortcutRoot', fixture.shortcuts], { cwd: root, env: fixture.env, timeout: 900000,
        outputFiles: { stdout: join(root, 'installer-stdout.log'), stderr: join(root, 'installer-stderr.log') } });
    const selected = readSelectedNativeRuntime(fixture.nna);
    assert.equal(selected.root.toLowerCase(), (await realpath(fixture.nna)).toLowerCase());
    assert.equal(selected.dataRoot.toLowerCase(), (await realpath(fixture.data)).toLowerCase());
    const packageRoot = await realpath(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    const registered = await selectedPackage(fixture);
    assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
    assert.equal(registered.valid, true, 'The selected NND package must validate');
    assert.equal((await realpath(registered.root)).toLowerCase(), packageRoot.toLowerCase(),
      'NNA selected a different NND package root');
    assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
    const status = await cli(fixture, 'status');
    assert.equal(status.installation_id, selected.installation_id);
    assert.equal(status.data_id, selected.data_id);
    assert.ok(['ready', 'setup_required'].includes(status.service_state));
    assert.equal(status.package_state, 'ready');
    assert.equal(status.package_version, packageVersion);
    const ticket = (await cli(fixture, 'ui-ticket')).ticket;
    await shell(fixture, 'browser', status.endpoint, ticket);
    await shell(fixture, 'desktop', status.endpoint);
    const after = await cli(fixture, 'status');
    assert.equal(after.instance_id, status.instance_id, 'Desktop exit must not stop or replace native service');
    await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true;
    process.stdout.write('Real disposable source install, Native code Chromium UI, desktop attach and service lifetime passed.\n');
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write(`Native state uncertain; preserved fixture at ${root}\n`); }
    }
    if (serviceStopped && !childUncertain) await rm(await checkedFixturePath(root), { recursive: true, force: true, maxRetries: 5 });
    else process.stderr.write(`Acceptance evidence preserved at ${root}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/installed-source-acceptance.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
