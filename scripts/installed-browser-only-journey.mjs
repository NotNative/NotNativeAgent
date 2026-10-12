// SPDX-License-Identifier: Apache-2.0
/**
 * F7 browser-only journey: a governed nnd_browser tool chain (open, snapshot,
 * inspect, click, type, capture) runs against a fixture dev-server page with
 * the desktop surface never launched — the plain browser tab is the executor
 * through the same-origin preview proxy and postMessage bridge. Capture is
 * expected to be refused honestly (a browser tab cannot rasterize).
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupBrowserProbe } from './installed-attachment-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const F7_TITLE = 'F7 browser-only journey';
const PAGE_MARKER = 'F7 fixture paragraph marker';

const FIXTURE_HTML = '<!doctype html><html><head><title>F7 fixture</title></head><body>'
  + '<p data-testid="status">' + PAGE_MARKER + '</p>'
  + '<input id="field" /><button id="go">Go</button><div id="echo"></div>'
  + '<script>document.getElementById("go").addEventListener("click",function(){'
  + 'document.getElementById("echo").textContent="clicked";})</script>'
  + '</body></html>';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(FIXTURE_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: 'http://127.0.0.1:' + port + '/', port });
    });
  });
}

function sse(response, delta, toolCall) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: toolCall ? 'tool_calls' : 'stop' }] })
    + '\n\ndata: [DONE]\n\n');
}

function toolCall(id, args) {
  return { delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'nnd_browser', arguments: JSON.stringify(args) } }] } };
}

/** Drives the whole nnd_browser chain from the model side; the setup turn
 * gets a plain reply, the F7 prompt walks open/snapshot/inspect/click/type/
 * capture and then summarizes what actually reached the model. */
function startBrowserToolProvider(fixtureUrl) {
  const state = { toolResults: [] };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const messages = body.messages ?? [];
      const content = (id) => {
        const found = messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
        return found ? String(found.content ?? '') : null;
      };
      const userText = messages.filter((message) => message.role === 'user')
        .map((message) => String(message.content ?? '')).join(' ');
      if (userText.includes('Installed setup text')) {
        state.toolResults.push({ setupTools: (body.tools ?? []).map((tool) => tool.function?.name).join(',') });
        return sse(response, { role: 'assistant', content: 'Setup turn complete.' }, false);
      }
      state.toolResults.push({ user: userText.slice(-140), tools: (body.tools ?? []).map((tool) => tool.function?.name).join(',') });
      const snapshot = content('f7_snap');
      if (snapshot === null) return sse(response, toolCall('f7_open', { action: 'browser.open', url: fixtureUrl }), true);
      const seen = content('f7_capture');
      if (seen !== null) {
        state.toolResults.push({ snapshot, capture: seen });
        const parsed = JSON.parse(snapshot);
        return sse(response, { role: 'assistant', content: 'F7 browser-only summary: page text ['
          + String(parsed.text ?? '').slice(0, 80) + ']; capture outcome [' + seen.slice(0, 140) + ']' }, false);
      }
      const expected = { action: 'browser.inspect', selector: '[data-testid="status"]' };
      if (content('f7_inspect') === null) return sse(response, toolCall('f7_inspect', expected), true);
      const inspected = content('f7_inspect');
      if (inspected !== null && content('f7_click') === null) {
        return sse(response, toolCall('f7_click', { action: 'browser.click', selector: '#go',
          expectedUrl: JSON.parse(snapshot).url }), true);
      }
      if (content('f7_type') === null) {
        return sse(response, toolCall('f7_type', { action: 'browser.type', selector: '#field',
          text: 'F7 typed value', expectedUrl: JSON.parse(snapshot).url }), true);
      }
      return sse(response, toolCall('f7_capture', { action: 'browser.capture',
        expectedUrl: JSON.parse(snapshot).url }), true);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, port, url: 'http://127.0.0.1:' + port + '/v1', state });
    });
  });
}

export function f7Probe() {
  return '(async()=>{'
    + "const post=async(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});"
    + "const delay=ms=>new Promise(r=>setTimeout(r,ms));"
    + "const getMessages=async id=>{const r=await fetch('/api/session/'+id+'/message');"
    + "if(r.status!==200)throw Error('message read '+r.status);return r.json();};"
    + 'let servers=null;for(let i=0;i<150;i++){'
    + 'const listed=await fetch(\'/api/dev-servers\');'
    + 'if(listed.status===200){const view=await listed.json();'
    + 'servers=(view.servers??[]).map(item=>item.port);break}await delay(200)}'
    + 'if(!servers)throw Error(\'dev-server discovery unavailable\');'
    + 'const rail=document.querySelector(\'button[aria-label="Browser"]\');'
    + 'if(!rail)throw Error(\'browser rail item missing\');rail.click();'
    + "const made=await post('/api/session',{title:" + JSON.stringify(F7_TITLE) + '});'
    + 'if(made.status!==201)throw Error(\'create \'+made.status+\': \'+await made.text());'
    + 'const id=(await made.json()).id;'
    + "const sent=await post('/api/session/'+id+'/prompt_async',{messageID:'f7p1',agent:'nna',"
    + "parts:[{type:'text',text:'Use the nnd_browser tool against the local fixture dev server: open the page, snapshot it, inspect it, click, type, and attempt a capture.'}]});"
    + 'if(sent.status!==204)throw Error(\'submit \'+sent.status+\': \'+await sent.text());'
    + 'let final=null;const deadline=Date.now()+300000;'
    + 'while(Date.now()<deadline&&final===null){const list=await getMessages(id);'
    + 'const assistant=list.filter(m=>m.info?.role===\'assistant\');'
    + 'for(const item of assistant){const text=(item.parts??[]).map(p=>p.text??\'\').join(\' \');'
    + 'if(text.includes(\'F7 browser-only summary\'))final=text}'
    + 'if(final===null)await delay(500)}'
    + 'if(final===null){const activity=await fetch(\'/api/session/\'+id+\'/activity\');'
    + 'const events=activity.status===200?await activity.json():[];'
    + 'throw Error(\'F7 tool chain never summarized: \'+JSON.stringify({discovered:servers,'
    + 'messages:(await getMessages(id)).map(m=>String(m.info&&m.info.role)+\':\'+(m.parts||[]).map(p=>String(p.text||\'\')).join(\'|\')).join(\'|\'),'
    + 'activity:events.slice(-5).map(e=>String(e.summary||\'\').slice(0,300)||JSON.stringify(e).slice(0,300))}));}'
    + 'return {session:id,summary:final,discovered:servers};'
    + '})()';
}

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}

async function runJourney(fixture, provider, fixtureServer) {
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
  const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
  const setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
    setupBrowserProbe(fixture.root, provider.port));
  assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  const journeyTicket = (await cli(fixture, 'ui-ticket')).ticket;
  let result;
  try {
    result = await shell(fixture, 'browser', status.endpoint, journeyTicket, [], f7Probe());
  } catch (error) {
    process.stderr.write('F7 provider saw: ' + JSON.stringify(provider.state.toolResults) + '\n');
    throw error;
  }
  assert.ok(result.summary.includes(PAGE_MARKER),
    'the model never saw the proxied page content: ' + result.summary);
  assert.ok(/Raster capture is unavailable/iu.test(provider.state.toolResults[0]?.capture ?? ''),
    'capture was not honestly refused: ' + (provider.state.toolResults[0]?.capture ?? ''));
  assert.ok(result.discovered.includes(fixtureServer.port), 'fixture dev server was not discovered');
  return result.summary;
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = join(base, 'installed-accept-' + globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  const fixtureServer = await startFixtureServer();
  const provider = await startBrowserToolProvider(fixtureServer.url);
  let serviceStopped = false;
  let accepted = false;
  try {
    await installFixture(fixture, 'installer');
    const { realpath } = await import('node:fs/promises');
    const packageRoot = await realpath(fixture.nnd);
    const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
    const registered = await selectedPackage(fixture);
    assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
    assert.equal(registered.valid, true, 'The selected NND package must validate');
    assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
    const summary = await runJourney(fixture, provider, fixtureServer);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write('F7 browser-only journey passed: nnd_browser open/snapshot/inspect/click/type ran with '
      + 'the browser tab as executor and the desktop surface never launched; the model saw the proxied page '
      + '(' + PAGE_MARKER + ') and capture was refused honestly.\n');
  } finally {
    if (!serviceStopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); serviceStopped = true; }
      catch { process.stderr.write('Native state uncertain; preserved fixture at ' + root + '\n'); }
    }
    fixtureServer.server.close();
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
  if (process.argv.length !== 3) throw new Error('usage: installed-browser-only-journey.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
