// SPDX-License-Identifier: Apache-2.0
/**
 * Installed timeline journey (deferred-verification installed legs): fork a
 * session from the NND timeline against the disposable installed pair and
 * confirm the child renders the inherited history and continues
 * independently, then revert/unrevert across the installed shell (NNA
 * `POST /session/:id/fork`, `/revert`, `/unrevert`). Reuses the installed
 * acceptance scaffold: real source install, native code Chromium UI, real
 * settings-UI provider configuration with a first turn, then the in-page
 * timeline probe. Fixture lands in the acceptance base and self-cleans.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { startAttachmentProvider, setupBrowserProbe } from './installed-attachment-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PARENT_TITLE = 'Installed timeline journey';

// In-page probe executed inside the installed Chromium shell (authenticated
// by the shell ticket). Plain string concatenation only: the quality-gate
// brace counter mis-lexes template literals with interpolation.
function timelineForkRevertProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const waitCount=async(id,n)=>{for(let i=0;i<300;i++){const list=await getMessages(id);"
    + 'if(list.length>=n)return list;await delay(200);}'
    + "throw Error('timeline did not settle: '+id);};"
    + "const submit=async(id,promptId)=>{const r=await post('/api/session/'+id+'/prompt_async',"
    + "{messageID:promptId,agent:'nna',parts:[{type:'text',text:'Installed timeline journey turn.'}]});"
    + "if(r.status!==204)throw Error('submit '+r.status+' '+await r.text());};"
    + "const created=await post('/api/session',{title:" + JSON.stringify(PARENT_TITLE) + '});'
    + "if(created.status!==201)throw Error('create '+created.status+' '+await created.text());"
    + 'const parent=(await created.json()).id;'
    + "await submit(parent,'t1');await waitCount(parent,2);"
    + "await submit(parent,'t2');await waitCount(parent,4);"
    + "const fork=await post('/api/session/'+parent+'/fork',{messageID:'t2'});"
    + "if(fork.status!==201)throw Error('fork '+fork.status+' '+await fork.text());"
    + 'const child=(await fork.json()).id;'
    + "if(typeof child!=='string')throw Error('fork lacked a child id');"
    + 'const childInherited=await getMessages(child);'
    + 'if(childInherited.length!==4)throw Error(\'child history \'+JSON.stringify(childInherited.map(m=>m.info.id)));'
    + "await submit(child,'t3');await waitCount(child,6);"
    + "const revert=await post('/api/session/'+child+'/revert',{messageID:'t3'});"
    + "if(revert.status!==200)throw Error('revert '+revert.status+' '+await revert.text());"
    + 'const afterRevert=await getMessages(child);'
    + 'if(afterRevert.length!==4)throw Error(\'revert did not hide the turn: \'+afterRevert.length);'
    + "const unrevert=await post('/api/session/'+child+'/unrevert',{});"
    + "if(unrevert.status!==200)throw Error('unrevert '+unrevert.status+' '+await unrevert.text());"
    + 'const restored=await getMessages(child);'
    + 'if(!(restored.length>=6&&restored.some(m=>m.info.id===\'t3\')))'
    + 'throw Error(\'unrevert did not restore: \'+restored.length);'
    + 'const parentNow=await getMessages(parent);'
    + 'if(parentNow.length!==4)throw Error(\'parent moved: \'+parentNow.length);'
    + 'let rowText=[];'
    + 'for(let i=0;i<100;i++){'
    + 'rowText=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rowText.length>=2)break;await delay(100);}'
    + 'if(rowText.length<2)throw Error(\'session rows did not render: \'+rowText.length);'
    + 'if(!rowText.some(t=>t.includes(' + JSON.stringify(PARENT_TITLE) + ')))'
    + 'throw Error(\'parent row missing: \'+JSON.stringify(rowText));'
    + 'return {parent,child,inherited:childInherited.length,restored:restored.length,rows:rowText.length};'
    + '})()';
}

// F9 installed leg: the same prompt in two sessions with different
// per-session model selections, judged through the installed shell. The
// secondary provider ships in the setup configuration document (the engine
// validates per-session routes against the boot-time configuration).
// F9 installed leg, phase 1: create the secondary provider profile through
// the installed shell's provider-profile surface (the settings editor's POST
// path). The engine validates per-session routes against the boot-time
// configuration, so the phase-2 leg runs after a canonical service restart.
function multirunProfileProbe(providerEndpoint) {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const profile=await post('/api/v1/provider-profiles',{profile_id:'secondary',display_name:'F9 secondary',"
    + 'endpoint:' + JSON.stringify(providerEndpoint) + ",model:'test-alt'});"
    + 'if(profile.status!==201)throw Error(\'profile create \'+profile.status+\': \'+await profile.text());'
    + 'const made=(await profile.json()).profile;'
    + 'if(!made||made.profile_id!==\'secondary\'||made.model!==\'test-alt\')'
    + 'throw Error(\'profile receipt \'+JSON.stringify(made));'
    + 'return {created:\'secondary\'};'
    + '})()';
}

function timelineMultirunProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const waitCount=async(id,n)=>{for(let i=0;i<300;i++){const list=await getMessages(id);"
    + 'if(list.length>=n)return list;await delay(200);}'
    + "throw Error('timeline did not settle: '+id);};"
    + "const submit=async(id,promptId,body)=>{const r=await post('/api/session/'+id+'/prompt_async',"
    + "Object.assign({messageID:promptId,agent:'nna',parts:[{type:'text',text:'F9 route observation prompt.'}]},body||{}));"
    + "if(r.status!==204)throw Error('submit '+promptId+' '+r.status+' '+await r.text());};"
    + "const madeA=await post('/api/session',{title:'F9 installed route A'});if(madeA.status!==201)throw Error('A '+madeA.status);"
    + 'const madeB=await post(\'/api/session\',{title:\'F9 installed route B\',providerID:\'secondary\',model:\'test-alt\'});'
    + "if(madeB.status!==201)throw Error('B '+madeB.status+' '+await madeB.text());"
    + 'const recordA=await madeA.json();const recordB=await madeB.json();'
    + 'const a=recordA.id;const b=recordB.id;'
    + 'const configuredB=recordB.metadata.nnd.configuredModel;'
    + 'if(JSON.stringify(configuredB)!==JSON.stringify({providerID:\'secondary\',modelID:\'test-alt\'}))'
    + 'throw Error(\'session B route \'+JSON.stringify(configuredB));'
    + "await submit(a,'f9a',{});await submit(b,'f9b',{});"
    + 'await waitCount(a,2);await waitCount(b,2);'
    + 'const override=await post(\'/api/session/\'+a+\'/prompt_async\',{messageID:\'f9x\',agent:\'nna\','
    + "parts:[{type:'text',text:'F9 route observation prompt.'}],model:{providerID:'secondary',modelID:'test-alt'}});"
    + 'if(override.status!==400)throw Error(\'override not refused: \'+override.status);'
    + 'const overrideBody=await override.json();'
    + 'if(overrideBody.error.code!==\'nnd_model_override_unsupported\')'
    + 'throw Error(\'override code \'+overrideBody.error.code);'
    + 'return {sessionA:a,sessionB:b,configuredB};'
    + '})()';
}

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

async function runJourney(fixture, packageVersion, provider) {
  const selected = readSelectedNativeRuntime(fixture.nna);
  assert.equal(selected.root.toLowerCase(), (await realpathSafe(fixture.nna)).toLowerCase());
  assert.equal(selected.dataRoot.toLowerCase(), (await realpathSafe(fixture.data)).toLowerCase());
  const registered = await selectedPackage(fixture);
  assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
  assert.equal(registered.valid, true, 'The selected NND package must validate');
  assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
  const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
    setupBrowserProbe(fixture.root, provider.port));
  assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  assert.equal(setupResult.same_tab_turn?.status, 'completed', 'first GUI turn did not complete');
  const timelineTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const result = await shell(fixture, 'browser', status.endpoint, timelineTicket, [],
    timelineForkRevertProbe());
  assert.equal(typeof result.parent, 'string', 'timeline journey lacked the parent session id');
  assert.equal(result.inherited, 4, 'child did not render the inherited history');
  assert.ok(result.restored >= 6, 'unrevert did not restore the hidden history');
  assert.ok(result.rows >= 2, 'forked child did not render as a session row');
  const profile = await shell(fixture, 'browser', status.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    multirunProfileProbe('http://127.0.0.1:' + provider.port + '/v1'));
  assert.equal(profile.created, 'secondary', 'provider profile did not persist through the installed surface');
  await cli(fixture, 'stop');
  await waitStopped(fixture);
  await cli(fixture, 'start');
  const restarted = await cli(fixture, 'status');
  assert.equal(restarted.service_state, 'ready', 'restart after profile create did not reach ready');
  const multirun = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    timelineMultirunProbe());
  assert.equal(typeof multirun.sessionA, 'string', 'multi-run journey lacked session A');
  assert.deepEqual(multirun.configuredB, { providerID: 'secondary', modelID: 'test-alt' },
    'installed session B did not hold its per-session route');
  const wiredModels = provider.requests.map((request) => request.model);
  assert.deepEqual(wiredModels.slice(-2), ['test', 'test-alt'],
    'the two installed same-prompt runs did not ride their per-session routes on the wire');
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = join(base, 'installed-accept-' + cryptoId());
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  const provider = await startAttachmentProvider();
  let serviceStopped = false;
  let accepted = false;
  try {
    await installFixture(fixture, 'installer');
    const packageRoot = await realpathSafe(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    await runJourney(fixture, packageVersion, provider);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write('Installed timeline journey passed: real source install, settings-UI setup with first turn, '
      + 'fork renders inherited history and continues independently, revert hides and unrevert restores '
      + 'across the installed shell, parent immovable, child rendered as its own session row, and the F9 '
      + 'same-prompt runs rode their per-session routes (primary/test vs secondary/test-alt) on the wire '
      + 'with the mismatched per-prompt override refused.\n');
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write('Native state uncertain; preserved fixture at ' + root + '\n'); }
    }
    const closed = new Promise((resolve) => provider.server.close(resolve));
    provider.server.closeAllConnections();
    await closed;
    if (accepted && serviceStopped && !acceptanceEvidence().uncertain) {
      try { await rm(await checkedFixturePath(root, base), { recursive: true, force: true, maxRetries: 5 }); }
      catch (cleanupError) {
        process.stderr.write('Journey passed; fixture cleanup deferred ('
          + (cleanupError?.code ?? cleanupError) + '): ' + root + '\n');
      }
    } else process.stderr.write('Journey evidence preserved at ' + root + '\n');
  }
}

function cryptoId() {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

async function realpathSafe(path) {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-timeline-journey.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
