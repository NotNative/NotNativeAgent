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
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupBrowserProbe } from './installed-setup-probe.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';
import { writeRunState } from './f7-run-report.mjs';

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
  return { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'nnd_browser', arguments: JSON.stringify(args) } }] };
}

/** Drives the whole nnd_browser chain from the model side; the setup turn
 * gets a plain reply, the F7 prompt walks open/snapshot/inspect/click/type/
 * capture and then summarizes what actually reached the model. */
function startBrowserToolProvider(fixtureUrl) {
  const state = { toolResults: [], notes: [], issued: [] };
  const server = createServer((request, response) => {
    void (async () => {
      // The setup probe streams its live UI observations here so a failed run
      // keeps the evidence even when the page context dies mid-probe.
      if (request.method === 'POST' && request.url === '/probe-note') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        state.notes.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(204); response.end(); return;
      }
      // Provider health probes are GET .../models (the profile endpoint ends in /v1).
      if (request.method === 'GET' && /^\/(?:v1\/)?models$/u.test(String(request.url).split('?')[0])) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'test' }, { id: 'test-alt' }] }));
        return;
      }
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
      // The semantic reviewer sends its policy as the system message; answer
      // with one schema-valid approve decision so the governed chain proceeds.
      if (messages.some((message) => message.role === 'system'
        && String(message.content ?? '').includes('tool-permission decision'))) {
        state.issued.push('review-approve');
        return sse(response, { role: 'assistant', content: JSON.stringify({ outcome: 'approve', confidence: 0.9,
          reason_code: 'stub_reviewer_loopback_approve', authority_anchors: [1], effect_assessment: 'read_only' }) }, false);
      }
      if (userText.includes('Installed setup text')) {
        state.toolResults.push({ setupTools: (body.tools ?? []).map((tool) => tool.function?.name).join(',') });
        state.issued.push('setup-turn');
        return sse(response, { role: 'assistant', content: 'Setup turn complete.' }, false);
      }
      state.toolResults.push({ user: userText.slice(-140), tools: (body.tools ?? []).map((tool) => tool.function?.name).join(','),
        roles: messages.slice(-8).map((m) => m.role + (m.tool_call_id ? ':' + String(m.tool_call_id).slice(0, 14) : '') + (m.tool_calls ? '->tc' : '')) });
      // NNA's canonical lifecycle set (src/tools/tool-result-contract.js)
      // has no 'completed': a successful envelope reads 'succeeded'.
      const okSnap = (raw) => { try { return JSON.parse(raw).tool_lifecycle_status === 'succeeded' ? raw : null; } catch { return null; } };
      const issue = (id, args) => { state.issued.push(id); return sse(response, toolCall(id, args), true); };
      // A snapshot can 409 while the opened page is still settling; each
      // snapshot stage retries before the chain proceeds.
      const snapStage = (base) => {
        const ids = [base, `${base}_r1`, `${base}_r2`, `${base}_r3`];
        const missing = ids.find((id) => content(id) === null);
        if (missing !== undefined) return issue(missing, { action: 'snapshot' });
        return null;
      };
      const lastOkSnapId = (bases) => {
        const ids = bases.flatMap((b) => [b, `${b}_r1`, `${b}_r2`, `${b}_r3`]);
        for (let k = ids.length - 1; k >= 0; k--) if (okSnap(content(ids[k])) !== null) return ids[k];
        return null;
      };
      const snapUrl = (id) => { try { return JSON.parse(JSON.parse(content(id)).content).url; } catch { return 'about:blank#stale'; } };
      if (content('f7_open') === null) return issue('f7_open', { action: 'open', url: fixtureUrl });
      if (lastOkSnapId(['f7_snap']) === null) { const retry = snapStage('f7_snap'); if (retry) return retry; }
      const seen = content('f7_capture');
      if (seen !== null) {
        state.toolResults.push({ open: content('f7_open'), snapshot: content(lastOkSnapId(['f7_snap', 'f7_snap2', 'f7_snap3']) ?? 'f7_snap'), capture: seen });
        let marker = 'MISSING';
        try {
          // NNA projects results as 'full' or 'receipt'; a receipt has no
          // .text but its excerpt keeps the marker text, so search the raw
          // envelope content instead of a fixed projection shape.
          const rawSnap = String(content(lastOkSnapId(['f7_snap', 'f7_snap2', 'f7_snap3']) ?? 'f7_snap') ?? '');
          marker = rawSnap.includes(PAGE_MARKER) ? 'FOUND' : 'ABSENT';
        } catch { /* stays MISSING */ }
        state.issued.push('summary');
        return sse(response, { role: 'assistant', content: 'F7 browser-only summary: page marker [' + marker
          + ']; open [' + String(content('f7_open')).slice(0, 500) + ']; capture outcome [' + seen.slice(0, 1200) + ']; snapshot [' + String(content(lastOkSnapId(['f7_snap', 'f7_snap2', 'f7_snap3']) ?? 'f7_snap')).slice(0, 900) + ']' }, false);
      }
      // Each mutating action (click/type) invalidates the observation, so the
      // stub re-snapshots before the next expectedUrl-anchored action.
      if (content('f7_inspect') === null) {
        return issue('f7_inspect', { action: 'inspect', selector: '[data-testid="status"]' });
      }
      if (content('f7_click') === null) {
        return issue('f7_click', { action: 'click', selector: '#go',
          expectedUrl: snapUrl(lastOkSnapId(['f7_snap']) ?? 'f7_snap') });
      }
      if (lastOkSnapId(['f7_snap2']) === null) { const retry = snapStage('f7_snap2'); if (retry) return retry; }
      if (content('f7_type') === null) {
        return issue('f7_type', { action: 'type', selector: '#field',
          text: 'F7 typed value', expectedUrl: snapUrl(lastOkSnapId(['f7_snap2']) ?? 'f7_snap2') });
      }
      if (lastOkSnapId(['f7_snap3']) === null) { const retry = snapStage('f7_snap3'); if (retry) return retry; }
      return issue('f7_capture', { action: 'capture',
        expectedUrl: snapUrl(lastOkSnapId(['f7_snap3']) ?? 'f7_snap3') });
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

export function f7Probe(providerPort, fixturePort) {
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
    + 'let proxyCheck=null;try{const r=await fetch(\'/api/preview-proxy/' + Number(fixturePort ?? 0) + '/\');'
    + 'const t=await r.text();proxyCheck={status:r.status,bridge:t.includes(\'__nndBrowserBridgePerform\'),start:t.slice(0,140)}}'
    + 'catch(e){proxyCheck={error:String(e)}}'
    + 'if(!proxyCheck||proxyCheck.status!==200||proxyCheck.bridge!==true)'
    + 'throw Error(\'preview proxy check failed: \'+JSON.stringify(proxyCheck));'
    + 'const domState=()=>{const s=document.querySelector(\'[data-testid="operator-browser"]\');const g=document.querySelector(\'iframe[title="Sandboxed browser preview"],webview\');const a=document.querySelector(\'input[aria-label="Preview address"]\');const hidden=[];for(let el=s;el&&el!==document.body;el=el.parentElement){if(el.classList.contains(\'hidden\'))hidden.push(el.tagName+\'-hidden\')}if(g&&!g.dataset.watch){g.dataset.watch=\'1\';g.addEventListener(\'load\',()=>{g.dataset.loaded=\'1\'});g.addEventListener(\'error\',()=>{g.dataset.loadErr=\'1\'})}return {rail:!!document.querySelector(\'button[aria-label="Browser"]\'),pane:!!s,visible:!!s&&s.offsetParent!==null,hiddenChain:hidden,address:a?a.value:null,guest:!!g,guestSrc:g?g.src:null,guestLoaded:g?(g.dataset.loaded||g.dataset.loadErr||\'loading\'):null,waiting:/Waiting for local server|Local server did not answer/.test(document.body.innerText.slice(0,20000)),surface:[...Object.keys(localStorage)].filter(k=>/surface/i.test(k)).map(k=>k+\'=\'+localStorage.getItem(k)).join(\',\')||null,executor:((document.querySelector(\'[data-testid="browser-executor-status"]\')||{}).textContent||null),alerts:[...document.querySelectorAll(\'[role="alert"]\')].map(x=>x.textContent?.slice(0,120)).slice(0,5)}};fetch(\'http://127.0.0.1:' + String(providerPort ?? 0) + '/probe-note\',{method:\'POST\',mode:\'no-cors\',headers:{\'content-type\':\'text/plain\'},body:JSON.stringify({phase:\'f7-dom-before\',...domState()})}).catch(()=>{});setInterval(()=>{fetch(\'http://127.0.0.1:' + String(providerPort ?? 0) + '/probe-note\',{method:\'POST\',mode:\'no-cors\',headers:{\'content-type\':\'text/plain\'},body:JSON.stringify({phase:\'f7-dom\',...domState()})}).catch(()=>{});},3000);const rail=document.querySelector(\'button[aria-label="Browser"]\');'
    + 'let channel=false;await fetch(\'http://127.0.0.1:' + String(providerPort ?? 0) + '/probe-note\',{method:\'POST\',mode:\'no-cors\',headers:{\'content-type\':\'text/plain\'},body:JSON.stringify({phase:\'f7-entered\'})}).then(()=>{channel=true}).catch(()=>{});'
    + 'if(!rail)throw Error(\'browser rail item missing\');rail.click();'
    + 'let exec=null;for(let i=0;i<150;i++){exec=(document.querySelector(\'[data-testid="browser-executor-status"]\')||{}).textContent||null;if(exec===\'registered\')break;await delay(100)}'
    + 'if(exec!==\'registered\')throw Error(\'browser executor did not register: \'+String(exec));'
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
    + 'return {session:id,summary:final,discovered:servers,channel};'
    + '})()';
}

async function installFixture(fixture, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts], { cwd: fixture.root, env: fixture.env, timeout: 900000,
    outputFiles: { stdout: join(fixture.root, label + '-stdout.log'),
      stderr: join(fixture.root, label + '-stderr.log') } });
}


/** Post-mortem: dump the manifest transaction state the failed setup left behind. */
async function postMortem(fixture) {
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const config = join(fixture.data, 'config');
    const entries = await readdir(config, { recursive: true }).catch(() => []);
    process.stderr.write('F7 config dir: ' + JSON.stringify(entries.filter((e) => !e.includes('node_modules'))) + '\n');
    try {
      const manifest = await readFile(join(config, 'manifest.json'), 'utf8');
      process.stderr.write('F7 manifest.json: ' + manifest.slice(0, 300) + '\n');
    } catch { process.stderr.write('F7 manifest.json: ABSENT\n'); }
    const { DatabaseSync } = await import('node:sqlite');
    for (const dir of (await readdir(config)).filter((n) => n.startsWith('.nna-manifest-'))) {
      const db = new DatabaseSync(join(config, dir, 'receipts.sqlite'));
      const rows = db.prepare('SELECT id,state,staged,before_hash,after_hash,created_at FROM operations ORDER BY rowid').all();
      process.stderr.write('F7 receipts ' + dir.slice(0, 18) + ': ' + JSON.stringify(rows) + '\n');
      db.close();
    }
  } catch (error) {
    process.stderr.write('F7 post-mortem failed: ' + (error instanceof Error ? error.message : error) + '\n');
  }
}

async function runJourney(fixture, provider, fixtureServer, stage) {
  try {
    return await runJourneyInner(fixture, provider, fixtureServer, stage);
  } finally {
    // Evidence goes to a node-written file: pwsh console reflow corrupts long
    // JSON written through shell redirection.
    try {
      const { tmpdir } = await import('node:os');
      await writeFile(join(tmpdir(), 'f7-evidence.json'),
        JSON.stringify({ notes: provider.state.notes, tool_results: provider.state.toolResults,
          issued: provider.state.issued }));
    } catch { /* stderr still carries the summary */ }
    process.stderr.write('F7 provider saw: ' + JSON.stringify(provider.state.toolResults) + '\n'
      + 'F7 probe notes: ' + JSON.stringify(provider.state.notes) + '\n');
  }
}
/** A reused fixture's manifest still points at the previous run's stub
 * provider; retarget every loopback URL before the service reads it. */
async function retargetManifestProvider(fixture, port) {
  const manifestPath = join(fixture.data, 'config', 'manifest.json');
  const swap = (value) => typeof value === 'string'
    ? value.replace(/127\.0\.0\.1:\d+/gu, '127.0.0.1:' + port)
    : Array.isArray(value) ? value.map(swap)
      : (value && typeof value === 'object')
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swap(item)]))
        : value;
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify(swap(manifest)));
    process.stderr.write('F7 manifest retargeted to provider 127.0.0.1:' + port + '\n');
  } catch (error) {
    process.stderr.write('F7 manifest retarget skipped: ' + String(error?.message ?? error) + '\n');
  }
}

async function runJourneyInner(fixture, provider, fixtureServer, stage) {
  if (stage === 'chain') await retargetManifestProvider(fixture, provider.port);
  await cli(fixture, 'start');
  const status = await cli(fixture, 'status');
  if (stage === 'chain') {
    assert.equal(status.service_state, 'ready',
      'chain stage requires a configured fixture; service_state=' + status.service_state
      + ' (run --stage=all first, then iterate with --stage=chain --fixture=last)');
  } else {
    assert.equal(status.service_state, 'setup_required', 'fresh install must require setup');
    const setupTicket = (await cli(fixture, 'ui-ticket')).ticket;
    let setupResult;
    try {
      setupResult = await shell(fixture, 'browser', status.endpoint, setupTicket, [],
        setupBrowserProbe(fixture.root, provider.port, 'missing', null, true));
    } catch (error) {
      process.stderr.write('F7 probe notes: ' + JSON.stringify(provider.state.notes) + '\n');
      await postMortem(fixture);
      throw error;
    }
    assert.equal(setupResult.setup_after, 'ready', 'native setup did not reach ready');
  }
  if (stage === 'setup') return 'setup leg reached ready';
  const journeyTicket = (await cli(fixture, 'ui-ticket')).ticket;
  let result;
  try {
    result = await shell(fixture, 'browser', status.endpoint, journeyTicket, [], f7Probe(provider.port, fixtureServer.port));
  } catch (error) {
    process.stderr.write('F7 provider saw: ' + JSON.stringify(provider.state.toolResults) + '\n'
    + 'F7 probe notes: ' + JSON.stringify(provider.state.notes) + '\n');
    throw error;
  }
  assert.ok(!('probe_error' in result),
    'probe crashed: ' + String(result.probe_error).slice(0, 500));
  assert.ok('channel' in result && 'summary' in result,
    'probe returned the reload stub instead of a journey result: ' + JSON.stringify(result).slice(0, 300));
  assert.equal(result.channel, true,
    'evidence channel down: the probe-note fetch never reached the provider; refusing to judge the chain');
  try {
assert.ok(result.summary.includes('page marker [FOUND]'),
    'the model never saw the proxied page content: ' + result.summary);
  } catch (error) {
    process.stderr.write('F7 provider saw: ' + JSON.stringify(provider.state.toolResults) + '\n'
    + 'F7 probe notes: ' + JSON.stringify(provider.state.notes) + '\n');
    throw error;
  }
  // The chain entry lands after the per-request generic pushes, so find it.
  const chainEntry = provider.state.toolResults.find((entry) => typeof entry.capture === 'string');
  assert.ok(/Raster capture is unavailable/iu.test(chainEntry?.capture ?? ''),
    'capture was not honestly refused: ' + (chainEntry?.capture ?? ''));
  assert.ok(result.discovered.includes(fixtureServer.port), 'fixture dev server was not discovered');
  return result.summary;
}

/** Newest installed-accept-* fixture under the disposable base (reuse target). */
async function latestFixture(base) {
  const entries = await readdir(base, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory() && /^installed-accept-[0-9a-f]{16}$/u.test(entry.name));
  assert.ok(candidates.length > 0, 'no reusable installed-accept fixture exists yet; run --stage=all first');
  const mtimes = await Promise.all(candidates.map(async (entry) => (await stat(join(base, entry.name))).mtimeMs));
  const newest = candidates[mtimes.indexOf(Math.max(...mtimes))];
  return join(base, newest.name);
}

/** Resolve and validate the run's fixture root (fresh or reused). */
async function resolveFixtureRoot(base, opts) {
  if (opts.fixture) {
    const root = opts.fixture === 'last' ? await latestFixture(base) : resolve(opts.fixture);
    assert.ok(root.startsWith(base + sep), 'fixture must stay inside the disposable base: ' + root);
    assert.ok(existsSync(join(root, 'NND')), 'fixture has no installed NND tree: ' + root);
    await privateDirectory(root, base);
    if (opts.stage === 'setup') {
      // Fresh-install semantics on a reused fixture: purge service data and the
      // per-run probe shells; install.ps1 still refreshes the code.
      await rm(join(root, 'data'), { recursive: true, force: true });
      for (const entry of await readdir(root)) {
        if (/^(?:browser|desktop)-(?:profile|probe|ticket|phase|stdout|stderr)-/u.test(entry)) {
          await rm(join(root, entry), { recursive: true, force: true });
        }
      }
    }
    return root;
  }
  assert.notEqual(opts.stage, 'chain',
    '--stage=chain requires --fixture=<path|last> pointing at a configured install');
  const fresh = join(base, 'installed-accept-' + globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 16));
  await privateDirectory(fresh, base);
  return fresh;
}

/** Install the code and assert NNA selected the same package version. */
async function installAndVerify(fixture) {
  await installFixture(fixture, 'installer');
  const { realpath } = await import('node:fs/promises');
  const packageRoot = await realpath(fixture.nnd);
  const packageVersion = (await readFile(join(packageRoot, 'VERSION'), 'utf8')).trim();
  const registered = await selectedPackage(fixture);
  assert.equal(registered.registered, true, 'The installed NND package must be selected in NNA');
  assert.equal(registered.valid, true, 'The selected NND package must validate');
  assert.equal(registered.version, packageVersion, 'NNA selected a different NND package version');
}

/** Structured run state plus the one stderr report line the runner parses. */
function reportRun(opts, root, accepted, lastError, startedAt, provider) {
  const statePath = writeRunState({
    stage: opts.stage, verdict: accepted ? 'PASS' : 'FAIL', fixture: root,
    error: lastError ? String(lastError.message ?? lastError).slice(0, 600) : null,
    started_at: startedAt, ended_at: new Date().toISOString(),
    notes: provider.state.notes.length, tool_results: provider.state.toolResults.length,
    log: process.env.NND_ACCEPTANCE_CHILD_LOG ?? null,
  });
  process.stderr.write('F7 REPORT: stage=' + opts.stage + ' verdict=' + (accepted ? 'PASS' : 'FAIL')
    + ' state=' + statePath + '\n');
}

async function main(nnaSource, opts) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  assert.ok(['all', 'setup', 'chain'].includes(opts.stage), 'unknown stage ' + opts.stage);
  const base = join(homedir(), 'nnd-installed-acceptance-fixtures');
  await mkdir(base, { recursive: true });
  const root = await resolveFixtureRoot(base, opts);
  const fixture = await prepare(nnaSource, root);
  const fixtureServer = await startFixtureServer();
  const provider = await startBrowserToolProvider(fixtureServer.url);
  const startedAt = new Date().toISOString();
  let lastError = null;
  // Watchdog: a hung child must still leave structured evidence behind.
  const heartbeat = setInterval(() => {
    writeRunState({ stage: opts.stage, verdict: 'RUNNING', fixture: root, heartbeat: new Date().toISOString(),
      started_at: startedAt, notes: provider.state.notes.length, tool_results: provider.state.toolResults.length,
      log: process.env.NND_ACCEPTANCE_CHILD_LOG ?? null });
  }, 60000);
  heartbeat.unref();
  let serviceStopped = false;
  let accepted = false;
  try {
    await installAndVerify(fixture);
    const summary = await runJourney(fixture, provider, fixtureServer, opts.stage);
    await cli(fixture, 'stop');
    await waitStopped(fixture);
    serviceStopped = true;
    accepted = true;
    process.stdout.write(opts.stage === 'setup'
      ? 'F7 setup stage passed: ' + summary + '.\n'
      : 'F7 browser-only journey passed: nnd_browser open/snapshot/inspect/click/type ran with '
      + 'the browser tab as executor and the desktop surface never launched; the model saw the proxied page '
      + '(' + PAGE_MARKER + ') and capture was refused honestly.\n');
  } catch (error) {
    lastError = error;
    throw error;
  } finally {
    clearInterval(heartbeat);
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
    reportRun(opts, root, accepted, lastError, startedAt, provider);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = 'usage: installed-browser-only-journey.mjs ABSOLUTE_NNA_SOURCE '
    + '[--stage=all|setup|chain] [--fixture=path|last]';
  const opts = { stage: 'all', fixture: null };
  let nnaSource = null;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--stage=')) opts.stage = arg.slice('--stage='.length);
    else if (arg.startsWith('--fixture=')) opts.fixture = arg.slice('--fixture='.length);
    else if (arg.startsWith('--')) throw new Error(usage);
    else if (nnaSource === null) nnaSource = arg;
    else throw new Error(usage);
  }
  if (nnaSource === null) throw new Error(usage);
  await main(resolve(nnaSource), opts);
}
