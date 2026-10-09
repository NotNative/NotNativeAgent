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
import { attachmentBrowserProbe, setupBrowserProbe, desktopSetupProbe, setupReloadComposerProbe, reviewBrowserProbe, reviewUiProbe, restartedAttachmentBrowserProbe, startAttachmentProvider, TEXT_MARKER, IMAGE, UI_TEXT_MARKER, UI_IMAGE, REVIEW_ALLOWED_FILE, REVIEW_DENIED_FILE, REVIEW_ALLOWED_CONTENT } from './installed-attachment-probe.mjs';

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
    { cwd: fixture.root, env: fixture.env, timeout: action === 'start' || action === 'stop' ? 120000 : 45000 });
  return JSON.parse(output.trim());
}
export async function selectedPackage(fixture) {
  const output = await run(process.execPath, [fixture.cli, 'nnd', 'package', 'status'],
    { cwd: fixture.root, env: fixture.env, timeout: 45000 });
  return JSON.parse(output.trim());
}
function chromiumScript(origin, mode, mainUrl, browserProbeExpression, browserScenarioModule, browserProbeTimeoutMs) {
  return `import {app,BrowserWindow,dialog} from 'electron';
import {appendFileSync} from 'node:fs';
const phase=value=>appendFileSync(${JSON.stringify(mainUrl.debugPath)},value+'\\n');
phase('module_loaded');
dialog.showErrorBox=(_title,message)=>{phase('startup_error:'+String(message).slice(0,160))};
app.setPath('userData',${JSON.stringify(mainUrl.userData)});
let done=false;const timer=setTimeout(()=>{process.stderr.write('acceptance Chromium timeout\\n');app.exit(1)},${browserProbeExpression ? browserProbeTimeoutMs : mode === 'desktop' ? 150000 : browserScenarioModule ? 360000 : 45000});
function finish(ok){if(done)return;done=true;clearTimeout(timer);if(ok)process.stdout.write('NND_INSTALLED_${mode === 'browser' ? 'BROWSER' : 'DESKTOP'}_OK\\n');app.exit(ok?0:1)}
app.whenReady().then(async()=>{
try{
phase('app_ready');
${mode === 'browser' ? `const {readFile,unlink}=await import('node:fs/promises');
const ticketPath=${JSON.stringify(mainUrl.ticketPath)};
const ticket=(await readFile(ticketPath,'utf8')).trim();await unlink(ticketPath);
if(ticket.length!==43)throw Error('Native ticket handoff length '+ticket.length);
const win=new BrowserWindow({show:false,webPreferences:{partition:'temp:nnd-accept-browser',nodeIntegration:false,contextIsolation:true,sandbox:true}});
${browserScenarioModule ? `win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{let blocked=false;try{blocked=['/api/global/event/ws','/api/event'].includes(new URL(details.url).pathname)}catch{}callback({cancel:blocked})});` : ''}
win.webContents.on('console-message',(...args)=>{for(const value of args.slice(1)){const message=typeof value==='string'?value:value?.message;if(typeof message==='string'&&message.startsWith('NND_PROBE_STEP:'))phase(message)}});
await win.loadURL(${JSON.stringify(origin)});
win.show();win.focus();
let inputReady=false;for(let i=0;i<100;i++){inputReady=await win.webContents.executeJavaScript('Boolean(document.getElementById("native-bootstrap-code"))');if(inputReady)break;await new Promise(r=>setTimeout(r,100))}
if(!inputReady)throw Error('Native code form did not authenticate: input_missing');
await win.webContents.executeJavaScript('document.getElementById("native-bootstrap-code").focus()');
for(const key of ticket)win.webContents.sendInputEvent({type:'char',keyCode:key});
await new Promise(r=>setTimeout(r,100));
if(await win.webContents.executeJavaScript('document.getElementById("native-bootstrap-code")?.value.length===0'))await win.webContents.insertText(ticket);
const accepted=await win.webContents.executeJavaScript('(async()=>{let button;for(let j=0;j<100;j++){button=document.querySelector("[data-testid=gate-native-bootstrap] button");if(button&&!button.disabled)break;await new Promise(r=>setTimeout(r,100))}if(!button||button.disabled){const input=document.getElementById("native-bootstrap-code");return "button_disabled_length_"+(input?.value.length||0)+"_focused_"+(document.activeElement===input)}button.click();let code=0;for(let j=0;j<100;j++){const response=await fetch("/auth/session");code=response.status;const status=await response.json();if(code===200&&status.authenticated===true)return "ok";await new Promise(r=>setTimeout(r,100))}return "session_"+code+"_"+(document.querySelector("[role=alert]")?.textContent||"").slice(0,80)})()');
if(accepted!=='ok')throw Error('Native code form did not authenticate: '+accepted);
phase('auth_accepted');
${browserScenarioModule ? `let appMounted=false;for(let i=0;i<100;i++){try{appMounted=await win.webContents.executeJavaScript('Boolean(document.querySelector("[data-testid=connection-pill]"))')}catch{}if(appMounted)break;await new Promise(r=>setTimeout(r,100))}if(!appMounted)throw Error('Authenticated app shell did not mount');phase('app_mounted');` : ''}
${browserProbeExpression ? `phase('probe_start');const nextLoad=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
const probe=await win.webContents.executeJavaScript(${JSON.stringify(browserProbeExpression)});
if(probe.ui_activation_started){await Promise.race([nextLoad,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('native activation did not reload the browser')),60000))]);
const activation=await win.webContents.executeJavaScript('(async()=>{const auth=await(await fetch("/auth/session")).json();const response=await fetch("/api/v1/nnd/setup/status");return{authenticated:auth.authenticated,status:response.status,setup:await response.json()}})()');
if(activation.authenticated!==true||activation.status!==200||activation.setup.service_state!=='ready'||activation.setup.execution_state!=='ready')
throw Error('native activation reload was not ready '+JSON.stringify(activation));probe.setup_after=activation.setup.service_state;
probe.same_tab_turn=await win.webContents.executeJavaScript(${JSON.stringify(setupReloadComposerProbe())});}
phase('probe_complete');process.stdout.write('NND_BROWSER_PROBE='+JSON.stringify(probe)+'\\n');` : ''}
${browserScenarioModule ? `phase('scenario_start');const {runNativeReplayGapBrowser}=await import(${JSON.stringify(pathToFileURL(browserScenarioModule).href)});const replay=await runNativeReplayGapBrowser(win,phase);if(!replay.priorCursorPresent||!replay.nativeGap||!replay.sidebarRecovered||!replay.activityGapVisible||!replay.cursorReset)throw Error('Installed native replay gap evidence missing');phase('scenario_complete');process.stdout.write('NND_INSTALLED_REPLAY_GAP_OK\\n');` : ''}
const other=new BrowserWindow({show:false,webPreferences:{partition:'temp:nnd-accept-other',nodeIntegration:false,contextIsolation:true,sandbox:true}});
phase('isolation_window_created');
await other.loadURL(${JSON.stringify(origin)});
phase('isolation_loaded');
const isolated=await other.webContents.executeJavaScript('(async()=>{const response=await fetch("/auth/session");const workspace=await fetch("/api/v1/nnd/workspaces/admissions");return {status:response.status,body:await response.json(),workspaceStatus:workspace.status}})()');
if(isolated.status!==401||isolated.body.authenticated!==false||isolated.workspaceStatus!==401)throw Error('Independent browser partition did not retain the unauthenticated workspace contract');
phase('isolation_verified');
finish(true);` : `app.on('browser-window-created',(_event,win)=>{phase('window_created');
win.webContents.on('console-message',(...args)=>{for(const value of args.slice(1)){const message=typeof value==='string'?value:value?.message;if(typeof message==='string'&&message.startsWith('NND_PROBE_STEP:'))phase(message)}});
win.webContents.on('did-finish-load',async()=>{if(done||!win.webContents.getURL().startsWith(${JSON.stringify(origin)}))return;
phase('window_loaded');
try{const result=await win.webContents.executeJavaScript('(async()=>{const response=await fetch("/auth/session");return {status:response.status,authenticated:(await response.json()).authenticated,token:window.__NOTNATIVE_CLIENT_TOKEN__||"",headers:window.__NOTNATIVE_RUNTIME_HEADERS__||{}}})()');
if(result.status!==200||result.authenticated!==true||result.token||Object.keys(result.headers).length)throw Error('Desktop attach missing or bearer exposed');
const ipc=await win.webContents.executeJavaScript('(async()=>{const invoke=window.__NOTNATIVE_DESKTOP_INVOKE__;const commands=["desktop_read_file","desktop_hosts_get","desktop_ssh_instances_get","desktopSshConfig","desktopSshReadConfig","desktopSshRefreshStatuses","desktop_open_mini_chat","desktop_local_client_token_get"];const results=[];for(const command of commands){const reply=await invoke(command,command==="desktop_read_file"?{path:"outside.txt"}:undefined);results.push({command,ok:reply.ok,error:reply.error})}return results})()');
if(ipc.some(item=>item.ok!==false||item.error!=='native-alpha-desktop-action-unavailable'))throw Error('Native alpha desktop IPC exposed legacy local reads '+JSON.stringify(ipc));
phase('native_ipc_reads_refused');
${browserProbeExpression ? `phase('desktop_probe_start');const probe=await win.webContents.executeJavaScript(${JSON.stringify(browserProbeExpression)});phase('desktop_probe_complete');process.stdout.write('NND_DESKTOP_PROBE='+JSON.stringify(probe)+'\\n');` : ''}
finish(true)}catch(e){process.stderr.write(String(e));finish(false)}})});
phase('import_start');await import(${JSON.stringify(mainUrl.main)});phase('import_returned');`}
}catch(error){process.stderr.write(error?.stack||error?.message||JSON.stringify(error)||String(error));finish(false)} });`;
}
export async function shell(fixture, mode, origin, ticket, extraArgs = [], browserProbeExpression = '', browserScenarioModule = null,
  browserProbeTimeoutMs = mode === 'desktop' ? 360000 : 900000) {
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
      main: pathToFileURL(join(fixture.nnd, 'packages/electron/main.mjs')).href, ticketPath, debugPath }, browserProbeExpression, browserScenarioModule, browserProbeTimeoutMs));
    // Desktop native attach can consume multiple bounded CLI attempts before
    // the renderer loads; keep the acceptance watchdog outside that budget.
    output = await run(electron, [wrapper, '--hidden', ...extraArgs], { cwd: fixture.root, env,
      timeout: mode === 'desktop' ? browserProbeExpression ? browserProbeTimeoutMs + 15000 : 165000 : browserProbeExpression ? browserProbeTimeoutMs + 15000 : browserScenarioModule ? 375000 : 60000, outputFiles });
  }
  finally { if (ticketPath) await unlink(ticketPath).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  if (outputFiles) output = await readOutputTail(outputFiles.stdout);
  assert.match(output, new RegExp(`NND_INSTALLED_${mode.toUpperCase()}_OK`, 'u'));
  if (browserScenarioModule) assert.match(output, /NND_INSTALLED_REPLAY_GAP_OK/u);
  if (browserProbeExpression) {
    const match = new RegExp(`^NND_${mode.toUpperCase()}_PROBE=(.+)$`, 'mu').exec(output);
    assert.ok(match, `Authenticated ${mode} probe result is missing`);
    return JSON.parse(match[1]);
  }
}
export async function prepare(nnaSource, root) {
  const nna = join(root, 'NNA'), data = join(root, 'data'), nnd = join(root, 'NND');
  const payload = join(nna, 'installed');
  await mkdir(payload, { recursive: true }); await mkdir(join(data, 'config'), { recursive: true });
  for (const item of ['src', 'resources', 'docs', 'package.json', 'VERSION'])
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
async function writeProbeManifest(fixture, durable, providerPort) {
  await writeFile(join(fixture.data, 'config', 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: durable ? 'durable' : 'ephemeral', workspace_root: fixture.root,
    providers: [{ id: 'smoke', display_name: 'Disposable smoke', endpoint: `http://127.0.0.1:${providerPort ?? 9}/v1`,
      model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'smoke', model: 'test' } },
  }));
}
function assertInstalledAttachmentDelivery(result, requests) {
  assert.equal(result.turn_status, 'completed');
  assert.equal(result.duplicate_rows, 1);
  assert.equal(result.ui_turn_status, 'completed');
  assert.notEqual(result.ui_session_id, result.session_id);
  assert.ok(requests.some((request) => JSON.stringify(request.messages).includes(IMAGE.toString('base64'))),
    'installed image bytes did not reach the observation provider');
  assert.ok(requests.some((request) => request.messages?.some((message) =>
    typeof message.content === 'string' && message.content.includes(TEXT_MARKER)
      && message.content.includes('Untrusted attachment observation'))),
  'installed text bytes did not reach the primary provider');
  assert.ok(requests.some((request) => JSON.stringify(request.messages).includes(UI_IMAGE.toString('base64'))),
    'composer image bytes did not reach the observation provider');
  assert.ok(requests.some((request) => request.messages?.some((message) =>
    typeof message.content === 'string' && message.content.includes(UI_TEXT_MARKER)
      && message.content.includes('Untrusted attachment observation'))),
  'composer text bytes did not reach the primary provider');
}
async function restartAttachmentService(fixture, prior, result, requests) {
  await cli(fixture, 'stop'); await waitStopped(fixture);
  const restarted = await cli(fixture, 'start');
  assert.equal(restarted.installation_id, prior.installation_id);
  assert.equal(restarted.data_id, prior.data_id);
  assert.notEqual(restarted.instance_id, prior.instance_id);
  const requestCount = requests.length;
  const ticket = (await cli(fixture, 'ui-ticket')).ticket;
  const recovered = await shell(fixture, 'browser', restarted.endpoint, ticket, [],
    restartedAttachmentBrowserProbe(result.session_id, result.ui_session_id));
  assert.equal(recovered.retry_status, 204);
  assert.equal(recovered.recovered.length, 2);
  assert.equal(requests.length, requestCount, 'restarted retry must not call the provider');
  return restarted;
}
async function runRemovalJourney(fixture) {
  const sourceManifest = join(fixture.data, 'config', 'manifest.json');
  const nativeDescriptor = join(fixture.nna, 'install.json');
  const nativeCli = fixture.cli;
  const desktopData = join(fixture.root, '.notnative-desktop');
  await mkdir(desktopData, { recursive: true });
  const retainedData = join(desktopData, 'uninstall-preservation.txt');
  await writeFile(retainedData, 'NND data stays unless purge is explicit\n');
  const before = await Promise.all([readFile(sourceManifest), readFile(nativeDescriptor), readFile(nativeCli)]);
  for (const location of ['Desktop', 'StartMenu']) {
    assert.equal((await lstat(join(fixture.shortcuts, location, 'NotNativeDesktop.lnk'))).isFile(), true);
  }
  await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts, '-Uninstall'], { cwd: fixture.root, env: fixture.env,
      timeout: 180000, outputFiles: { stdout: join(fixture.root, 'uninstaller-stdout.log'),
        stderr: join(fixture.root, 'uninstaller-stderr.log') } });
  await waitStopped(fixture);
  assert.deepEqual(await selectedPackage(fixture), { registered: false });
  await assert.rejects(lstat(fixture.nnd), { code: 'ENOENT' });
  for (const location of ['Desktop', 'StartMenu']) {
    await assert.rejects(lstat(join(fixture.shortcuts, location, 'NotNativeDesktop.lnk')), { code: 'ENOENT' });
  }
  for (const [index, path] of [sourceManifest, nativeDescriptor, nativeCli].entries()) {
    assert.deepEqual(await readFile(path), before[index], `${path} changed during NND removal`);
  }
  assert.equal(await readFile(retainedData, 'utf8'), 'NND data stays unless purge is explicit\n');
}
async function newFixture(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  await mkdir(base, { recursive: true });
  assert.equal((await lstat(base)).isSymbolicLink(), false, 'Fixture base cannot be a link');
  assert.equal(await realpath(base), resolve(base), 'Fixture base must not redirect');
  const root = join(base, `installed-accept-${randomUUID().replaceAll('-', '').slice(0, 16)}`);
  await privateDirectory(root);
  return prepare(nnaSource, root);
}
async function runBrowserJourney(fixture, status, { nativeReplayGap, nativeAttachments, nativeSetupTurn, malformedSource, attachmentProvider }) {
  if (nativeSetupTurn) {
    const desktopSetup = await shell(fixture, 'desktop', status.endpoint, null, [], desktopSetupProbe());
    assert.deepEqual(desktopSetup, { service_state: 'setup_required', execution_state: 'unavailable',
      execution_status: 503, repair_visible: true, ipc_fenced: true });
    assert.equal((await cli(fixture, 'status')).instance_id, status.instance_id,
      'pre-configuration desktop exit must leave the native service alive');
  }
  const ticket = (await cli(fixture, 'ui-ticket')).ticket;
  const scenarioModule = nativeReplayGap ? join(fixture.root, 'native-replay-gap-browser.mjs') : null;
  if (scenarioModule) await cp(join(source, 'scripts/electron-native-replay-gap-browser.mjs'), scenarioModule);
  const setupResult = nativeSetupTurn ? await shell(fixture, 'browser', status.endpoint, ticket, [],
    setupBrowserProbe(fixture.root, attachmentProvider.port, malformedSource ? 'invalid' : 'missing')) : null;
  if (setupResult) {
    assert.equal(setupResult.setup_before, 'setup_required');
    assert.equal(setupResult.setup_receipt, 'saved');
    assert.equal(setupResult.setup_after, 'ready');
    assert.equal(setupResult.same_tab_turn?.status, 'completed');
    assert.equal(resolve(setupResult.same_tab_turn?.directory), fixture.root,
      'first GUI text turn must bind to the installed fixture workspace');
  }
  if (nativeSetupTurn) {
    const reviewTicket = (await cli(fixture, 'ui-ticket')).ticket;
    const reviewResult = await shell(fixture, 'browser', status.endpoint, reviewTicket, [], reviewBrowserProbe());
    assert.deepEqual(reviewResult.reviews.map(item => item.tool_status), ['completed', 'failed']);
    assert.ok(attachmentProvider.reviews.some(item => item.mode === 'allow' && item.approved),
      'native reviewer did not approve the exact fixture write');
    assert.ok(attachmentProvider.reviews.some(item => item.mode === 'deny' && !item.approved),
      'native reviewer did not deny the mismatched fixture write');
    const uiReviewTicket = (await cli(fixture, 'ui-ticket')).ticket;
    const browserUiReview = await shell(fixture, 'browser', status.endpoint, uiReviewTicket, [], reviewUiProbe());
    assert.deepEqual(browserUiReview.reviews.map(item => item.tool_status), ['completed', 'failed']);
    assert.ok(browserUiReview.reviews.every(item => item.activity_visible),
      'browser did not render both native review outcomes');
    assert.ok(browserUiReview.reviews.every(item => !reviewResult.reviews.some(prior => prior.session_id === item.session_id)),
      'browser UI review reused an API-created session');
    assert.equal(await readFile(join(fixture.root, REVIEW_ALLOWED_FILE), 'utf8'), REVIEW_ALLOWED_CONTENT);
    await assert.rejects(readFile(join(fixture.root, REVIEW_DENIED_FILE)), { code: 'ENOENT' });
  }
  const chatTicket = nativeSetupTurn ? (await cli(fixture, 'ui-ticket')).ticket : ticket;
  const browserResult = await shell(fixture, 'browser', status.endpoint, chatTicket, [],
    nativeAttachments || nativeSetupTurn ? attachmentBrowserProbe() : '', scenarioModule);
  if (nativeAttachments || nativeSetupTurn) assertInstalledAttachmentDelivery(browserResult, attachmentProvider.requests);
  const desktopStatus = nativeAttachments || nativeSetupTurn
    ? await restartAttachmentService(fixture, status, browserResult, attachmentProvider.requests) : status;
  const desktopResult = await shell(fixture, 'desktop', desktopStatus.endpoint, null, [],
    nativeSetupTurn ? reviewUiProbe() : '', null, 900000);
  if (nativeSetupTurn) {
    assert.deepEqual(desktopResult.reviews.map(item => item.tool_status), ['completed', 'failed']);
    assert.ok(desktopResult.reviews.every(item => item.activity_visible),
      'desktop did not render both native review outcomes');
    for (const mode of ['allow', 'deny']) assert.ok(attachmentProvider.reviews.filter(item =>
      item.mode === mode && item.approved === (mode === 'allow')).length >= 3,
    `desktop-originated ${mode} write did not receive a native reviewer decision`);
    await assert.rejects(readFile(join(fixture.root, REVIEW_DENIED_FILE)), { code: 'ENOENT' });
  }
  const after = await cli(fixture, 'status');
  assert.equal(after.instance_id, desktopStatus.instance_id, 'Desktop exit must not stop or replace native service');
}
async function main(nnaSource, nativeReplayGap = false, nativeAttachments = false, nativeSetupTurn = false,
  malformedSource = false, nativeRemoval = false) {
  const fixture = await newFixture(nnaSource); const root = fixture.root;
  let serviceStopped = false; let accepted = false;
  let attachmentProvider;
  try {
    if (nativeAttachments || nativeSetupTurn) attachmentProvider = await startAttachmentProvider();
    if (nativeReplayGap || nativeAttachments || nativeRemoval) await writeProbeManifest(fixture,
      nativeAttachments || nativeRemoval, attachmentProvider?.port);
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
    if (malformedSource) {
      await cli(fixture, 'stop'); await waitStopped(fixture);
      await writeFile(join(fixture.data, 'config', 'manifest.json'), '{malformed native source');
      await cli(fixture, 'start');
    }
    const status = await cli(fixture, 'status');
    assert.equal(status.installation_id, selected.installation_id);
    assert.equal(status.data_id, selected.data_id);
    assert.ok(['ready', 'setup_required'].includes(status.service_state));
    if (nativeSetupTurn) assert.equal(status.service_state, 'setup_required');
    assert.equal(status.package_state, 'ready');
    assert.equal(status.package_version, packageVersion);
    await runBrowserJourney(fixture, status, { nativeReplayGap, nativeAttachments, nativeSetupTurn,
      malformedSource, attachmentProvider });
    if (nativeRemoval) await runRemovalJourney(fixture);
    else { await cli(fixture, 'stop'); await waitStopped(fixture); }
    serviceStopped = true;
    accepted = true;
    process.stdout.write(`Real disposable source install, Native code Chromium UI${nativeSetupTurn ? `, ${malformedSource ? 'malformed-source repair' : 'fresh native setup'} and first turn` : ''}${nativeAttachments || nativeSetupTurn ? ', file-only composer delivery and service restart recovery' : ''}${nativeRemoval ? ', native-owned removal and preserved state' : ''}, desktop attach and service lifetime passed.\n`);
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write(`Native state uncertain; preserved fixture at ${root}\n`); }
    }
    if (attachmentProvider) {
      const closed = new Promise((resolve) => attachmentProvider.server.close(resolve));
      attachmentProvider.server.closeAllConnections(); await closed;
    }
    if (accepted && serviceStopped && !childUncertain) await rm(await checkedFixturePath(root), { recursive: true, force: true, maxRetries: 5 });
    else process.stderr.write(`Acceptance evidence preserved at ${root}\n`);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (![3, 4].includes(process.argv.length) || process.argv.length === 4
    && !['--native-replay-gap', '--native-attachments', '--native-setup-turn', '--native-malformed-setup-turn', '--native-removal'].includes(process.argv[3]))
    throw new Error('usage: node scripts/installed-source-acceptance.mjs ABSOLUTE_NNA_SOURCE [--native-replay-gap|--native-attachments|--native-setup-turn|--native-malformed-setup-turn|--native-removal]');
  await main(resolve(process.argv[2]), process.argv[3] === '--native-replay-gap', process.argv[3] === '--native-attachments',
    ['--native-setup-turn', '--native-malformed-setup-turn'].includes(process.argv[3]),
    process.argv[3] === '--native-malformed-setup-turn', process.argv[3] === '--native-removal');
}
