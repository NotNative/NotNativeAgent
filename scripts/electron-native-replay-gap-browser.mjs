// SPDX-License-Identifier: Apache-2.0
/** Disposable Chromium acceptance for an authenticated native replay gap. */
import assert from 'node:assert/strict';

const UNKNOWN_CURSOR = 'evt_disposable_unknown_cursor';

function isGlobalStream(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === '/api/global/event';
  } catch { return false; }
}

function isHarnessStream(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && ['/api/global/event', '/api/event'].includes(parsed.pathname);
  } catch { return false; }
}

function isGlobalSocket(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && parsed.pathname === '/api/global/event/ws';
  } catch { return false; }
}

async function until(check, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Native replay gap smoke timed out: ${label}`);
}

async function browser(win, source) {
  return win.webContents.executeJavaScript(`(${source})()`);
}

async function createIdleSession(win, title) {
  const result = await browser(win, `async()=>{
    const response=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:${JSON.stringify(title)}})});
    return {status:response.status,body:await response.text()};
  }`);
  assert.equal(result.status, 201, `Disposable native session creation unavailable: ${result.status} ${result.body.slice(0, 300)}`);
  const record = JSON.parse(result.body);
  assert.equal(typeof record.id, 'string', 'Disposable native session response lacks an id');
  return record.id;
}

async function rowVisible(win, title) {
  return browser(win, `()=>[...document.querySelectorAll('[data-testid="session-row"]')].some(row=>row.textContent.includes(${JSON.stringify(title)}))`);
}

async function probeNativeGap(win) {
  return browser(win, `async()=>{
    const controller=new AbortController();
    const response=await fetch('/api/global/event',{headers:{'last-event-id':${JSON.stringify(UNKNOWN_CURSOR)}},signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
    if(response.status!==200||!response.body)return {status:response.status};
    const reader=response.body.getReader(),decoder=new TextDecoder();let data='';
    try{while(data.length<8192){const part=await reader.read();if(part.done)break;data+=decoder.decode(part.value,{stream:true});if(/\\r?\\n\\r?\\n/.test(data))break;}}
    finally{controller.abort();void reader.cancel().catch(()=>{});}
    const frame=data.split(/\\r?\\n\\r?\\n/)[0]||'';
    const line=frame.split(/\\r?\\n/).find(line=>line.startsWith('data:'));
    try{return {status:response.status,opener:JSON.parse(line?.slice(5).trim()||'null')}}catch{return {status:response.status,frame:frame.slice(0,300)}}
  }`);
}

function installReplayHooks(win, origin, state) {
  const request = win.webContents.session.webRequest;
  request.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isGlobalSocket(details.url, origin)) { callback({ cancel: true }); return; }
    if (isHarnessStream(details.url, origin) && !isGlobalStream(details.url, origin)) {
      callback({ cancel: true }); return;
    }
    if (state.block && isHarnessStream(details.url, origin)) {
      state.blockedGlobal += 1;
      callback({ cancel: true });
    }
    else callback({});
  });
  request.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const headers = details.requestHeaders;
    if (isGlobalStream(details.url, origin)) {
      state.globalRequests += 1;
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'last-event-id');
      if (key && typeof headers[key] === 'string' && headers[key]) state.observedCursor = headers[key];
      if (state.expectReset && (!key || !headers[key])) state.resetRequestSeen += 1;
      if (state.inject && key && typeof headers[key] === 'string' && headers[key]) {
        state.priorCursor = headers[key];
        headers[key] = UNKNOWN_CURSOR;
        state.injected += 1;
        state.inject = false;
      }
    }
    callback({ requestHeaders: headers });
  });
  return () => {
    request.onBeforeRequest({ urls: ['<all_urls>'] }, null);
    request.onBeforeSendHeaders({ urls: ['<all_urls>'] }, null);
  };
}

export async function runNativeReplayGapBrowser(win) {
  const origin = new URL(win.webContents.getURL()).origin;
  const state = { block: false, inject: false, blockedGlobal: 0, injected: 0,
    priorCursor: null, observedCursor: null, globalRequests: 0, expectReset: false, resetRequestSeen: 0 };
  const cleanup = installReplayHooks(win, origin, state);
  try {
    const first = `NND replay before ${Date.now()}`;
    const second = `NND replay after ${Date.now()}`;
    await browser(win, `()=>window.dispatchEvent(new Event('online'))`);
    await until(() => state.globalRequests > 0, 'initial Chromium global SSE request');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await createIdleSession(win, first);
    await until(() => rowVisible(win, first), 'first native session in sidebar');
    await browser(win, `()=>window.dispatchEvent(new Event('online'))`);
    await until(() => state.observedCursor, 'non-null renderer replay cursor after first event');
    const probe = await probeNativeGap(win);
    assert.equal(probe.status, 200, 'Native SSE replay probe was not admitted');
    assert.equal(probe.opener?.payload?.type, 'server.connected', 'Native SSE opener missing');
    assert.equal(probe.opener?.payload?.properties?.replayStatus, 'gap', 'Native did not report a replay gap');
    state.block = true;
    if (typeof win.webContents.session.closeAllConnections !== 'function') {
      throw new Error('Electron session cannot close existing harness streams for the replay gap smoke');
    }
    await win.webContents.session.closeAllConnections();
    await browser(win, `()=>window.dispatchEvent(new Event('online'))`);
    await until(() => state.blockedGlobal > 0, 'global SSE reconnect blocked after initial event');
    await createIdleSession(win, second);
    assert.equal(await rowVisible(win, second), false, 'Offline idle session reached sidebar before SSE recovery');
    state.block = false;
    state.inject = true;
    await browser(win, `()=>window.dispatchEvent(new Event('online'))`);
    await until(() => state.injected > 0, 'renderer reconnect with a non-null Last-Event-ID');
    assert.ok(state.priorCursor && state.priorCursor !== UNKNOWN_CURSOR, 'Renderer had no valid cursor before forced gap');
    await until(() => rowVisible(win, second), 'offline idle session recovered in Chromium sidebar', 30_000);
    await browser(win, `()=>document.querySelector('button[aria-label="Activity"]')?.click()`);
    await until(() => browser(win, `()=>!!document.querySelector('[data-testid="activity-history-gap"]')`),
      'renderer Activity notice after the explicit native gap');
    state.expectReset = true;
    await win.webContents.session.closeAllConnections();
    await browser(win, `()=>window.dispatchEvent(new Event('online'))`);
    await until(() => state.resetRequestSeen > 0, 'renderer reconnect without its invalidated replay cursor');
    return { priorCursorPresent: true, nativeGap: true, sidebarRecovered: true,
      activityGapVisible: true, cursorReset: true };
  } finally {
    cleanup();
  }
}
