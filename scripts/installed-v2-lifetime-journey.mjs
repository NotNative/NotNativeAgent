// SPDX-License-Identifier: Apache-2.0
/**
 * V2 lifetime journey (guide 05:39-59): browser-first turn before Electron
 * ever opens, hidden desktop attach observes the same session, explicit
 * service stop leaves the browser tab alive but offline (interface detach is
 * distinct from service stop), and restart restores the same session without
 * duplicate work. Reuses the installed acceptance scaffold end to end.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAttachmentProvider, setupBrowserProbe } from './installed-attachment-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const V2_TITLE = 'V2 browser first turn';

function browserFirstProbe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + "const made=await post('/api/session',{title:" + JSON.stringify(V2_TITLE) + '});'
    + 'if(made.status!==201)throw Error(\'create \'+made.status+\': \'+await made.text());'
    + 'const id=(await made.json()).id;'
    + "const sent=await post('/api/session/'+id+'/prompt_async',{messageID:'v2t1',agent:'nna',"
    + "parts:[{type:'text',text:'V2 browser-first governed turn.'}]});"
    + 'if(sent.status!==204)throw Error(\'submit \'+sent.status+\': \'+await sent.text());'
    + 'let list=[];for(let i=0;i<300;i++){list=await getMessages(id);if(list.length>=2)break;await delay(200);}'
    + 'if(list.length<2)throw Error(\'browser-first turn did not settle: \'+list.length);'
    + 'let rows=[];for(let i=0;i<100;i++){'
    + 'rows=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))break;await delay(100);}'
    + 'if(!rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))'
    + 'throw Error(\'browser session row missing: \'+JSON.stringify(rows));'
    + 'return {session:id,messages:list.length};'
    + '})()';
}

function desktopObserveProbe() {
  return '(async()=>{'
    + 'const delay=ms=>new Promise(r=>setTimeout(r,ms));'
    + 'let rows=[];for(let i=0;i<150;i++){'
    + 'rows=[...document.querySelectorAll(\'[data-testid="session-row"]\')].map(r=>r.textContent);'
    + 'if(rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))break;await delay(100);}'
    + 'if(!rows.some(t=>t.includes(' + JSON.stringify(V2_TITLE) + ')))'
    + 'throw Error(\'desktop window did not show the browser-created session: \'+JSON.stringify(rows));'
    + 'const pill=document.querySelector(\'[data-testid="connection-pill"]\');'
    + 'if(!pill)throw Error(\'desktop connection pill missing\');'
    + 'return {sawSession:true,pill:pill.textContent};'
    + '})()';
}

function serviceStopProbe() {
  return '(async()=>{/*STOP_OBSERVE*/'
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    // The tab loaded while the service was alive; wait for the driver's
    // delayed explicit stop to take effect, then judge the offline state.
    + 'let live=true;const deadline=Date.now()+180000;'
    + 'while(Date.now()<deadline){try{const r=await fetch(\'/api/v1/nnd/setup/status\');live=r.status===200;}'
    + 'catch(error){live=false;}if(!live)break;await delay(500);}'
    + 'if(live)throw Error(\'service never stopped under the loaded browser tab\');'
    + 'const pill=document.querySelector(\'[data-testid="connection-pill"]\');'
    + 'if(!pill)throw Error(\'browser connection pill missing while stopped\');'
    + 'let outcome;try{const r=await fetch(\'/api/v1/nnd/setup/status\');outcome={status:r.status};}'
    + 'catch(error){outcome={status:\'unreachable\'};}'
    + 'if(outcome.status===200)throw Error(\'stopped service still served status 200\');'
    + 'return {outcome,pill:pill.textContent,stillRendered:document.body.textContent.length>0};'
    + '})()';
}

function afterRestartProbe(sessionId) {
  return '(async()=>{'
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + 'const listed=await fetch(\'/api/session\');'
    + 'if(listed.status!==200)throw Error(\'session list \'+listed.status);'
    + 'const delay2=ms=>new Promise(r=>setTimeout(r,ms));'
    + 'let view=await listed.json();'
    + 'const findSession=()=>(view.recent??[]).some(item=>item.id===' + JSON.stringify(sessionId) + ');'
    + 'for(let i=0;i<120&&!findSession();i++){await delay2(500);'
    + 'const again=await fetch(\'/api/session\');if(again.status!==200)throw Error(\'session list \'+again.status);'
    + 'view=await again.json();}'
    + 'let list=[];for(let i=0;i<300;i++){list=await getMessages(' + JSON.stringify(sessionId) + ');'
    + 'if(list.length>=2)break;await delay(200);}'
    + 'if(list.length!==2)throw Error(\'restart duplicated or lost turn history: \'+list.length);'
    + 'return {recent:(view.recent??[]).length,messages:list.length};'
    + '})()';
}

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

function quote(path) {
  return '"' + path + '"';
}

async function runJourney(fixture, provider) {
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
  const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
    setupBrowserProbe(fixture.root, provider.port));
  assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  // Leg 1: a real governed turn from the browser alone; Electron never opened.
  const first = await shell(fixture, 'browser', status.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    browserFirstProbe());
  assert.ok(first.messages >= 2, 'browser-first turn did not complete');
  // Leg 2: hidden desktop attach observes the same browser-created session.
  const desktop = await shell(fixture, 'desktop', status.endpoint, null, [], desktopObserveProbe());
  assert.equal(desktop.sawSession, true, 'desktop did not observe the browser session');
  // Leg 3: explicit service stop under a loaded tab. The tab loads first;
  // a delayed detached CLI stop fires while the probe waits, so the shell
  // never needs a live origin at load time to observe the offline state.
  const stoppedTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const stopCommand = 'Start-Sleep -Seconds 25; & ' + quote(process.execPath) + ' '
    + quote(fixture.cli) + ' nnd service stop ' + quote(fixture.nna);
  const delayedStop = run(powershell, ['-NoProfile', '-NonInteractive', '-Command', stopCommand],
    { cwd: fixture.root, env: fixture.env, timeout: 180000 });
  const stopped = await shell(fixture, 'browser', status.endpoint, stoppedTicket, [],
    serviceStopProbe());
  await delayedStop;
  await waitStopped(fixture);
  assert.notEqual(stopped.outcome.status, 200, 'stopped service served the browser');
  assert.equal(stopped.stillRendered, true, 'browser tab did not survive the service stop');
  // Leg 4: restart; same session, same bounded history, no duplicate work.
  await cli(fixture, 'start');
  const restarted = await cli(fixture, 'status');
  assert.equal(restarted.service_state, 'ready', 'restart did not reach ready');
  assert.notEqual(restarted.instance_id, status.instance_id, 'restart reused the instance id');
  const after = await shell(fixture, 'browser', restarted.endpoint, (await cli(fixture, 'ui-ticket')).ticket, [],
    afterRestartProbe(first.session));
  assert.equal(after.messages, 2, 'restart changed the browser session history');
  return { session: first.session, desktopPill: desktop.pill };
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = join(base, 'installed-accept-' + globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  const provider = await startAttachmentProvider();
  let serviceStopped = false;
  let accepted = false;
  try {
    await installFixture(fixture, 'installer');
    const packageRoot = await (await import('node:fs/promises')).realpath(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    const registered = await selectedPackage(fixture);
    assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
    assert.equal(registered.valid, true, 'The selected NND package must validate');
    assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
    await runJourney(fixture, provider);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write('V2 lifetime journey passed: real governed turn from the browser alone, hidden desktop '
      + 'attach observed the same session, explicit service stop left the browser tab rendered but offline, '
      + 'restart restored the same session with unchanged history under a fresh instance id.\n');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-v2-lifetime-journey.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
