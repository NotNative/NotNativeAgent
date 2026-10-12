// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-tab browser-control executor (F7 scoped capability): executes
 * broker actions in a proxied preview page through a postMessage bridge
 * with Electron never launched. The page runs sandboxed (no same-origin
 * privilege); raster capture is refused honestly because a browser tab
 * cannot produce a JPEG screenshot.
 */
export type BridgeOutcome = { ok: true; data: unknown } | { ok: false; error: string };

export interface BrowserObservation { url: string; title: string; text: string; nodeCount: number;
  observationRevision: number; observationId: string }

export function previewProxyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null;
    const rest = parsed.pathname === '/' ? '' : parsed.pathname.replace(/^\/+/u, '');
    return '/api/preview-proxy/' + parsed.port + (rest ? '/' + rest : '') + parsed.search;
  } catch { return null; }
}

/** The bridge source is embedded by the preview proxy into proxied HTML;
 * this mirror drives the same contract from tests. */
export function bridgeHandlerSource(): string {
  return '(function(){'
    + 'function textOf(){return (document.body&&document.body.innerText||document.body&&document.body.textContent||"").slice(0,20000)}'
    + 'function perform(action,parameters){'
    + 'if(action==="browser.snapshot")return {title:document.title||"",text:textOf(),nodeCount:document.getElementsByTagName("*").length};'
    + 'if(action==="browser.inspect"){var selector=String(parameters.selector||"");if(!selector||selector.length>500)throw Error("A bounded CSS selector is required.");'
    + 'var element=document.querySelector(selector);return element?{count:1,html:element.outerHTML.slice(0,150000)}:{count:0,html:""}}'
    + 'if(action==="browser.click"){var target=document.querySelector(String(parameters.selector||""));'
    + 'if(!(target instanceof HTMLElement))throw Error("The click target was not found on the observed page.");target.click();return {clicked:true}}'
    + 'if(action==="browser.type"){var text=String(parameters.text||"");if(text.length>2000)throw Error("Bounded text is required.");'
    + 'var field=document.querySelector(String(parameters.selector||""));'
    + 'if(!(field instanceof HTMLInputElement||field instanceof HTMLTextAreaElement))throw Error("The type target is not a text field on the observed page.");'
    + 'var descriptor=Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,"value");'
    + 'descriptor.set.call(field,text);field.dispatchEvent(new Event("input",{bubbles:true}));field.dispatchEvent(new Event("change",{bubbles:true}));return {typed:true}}'
    + 'if(action==="browser.scroll"){var view=window;var direction=String(parameters.direction||"");'
    + 'if(direction==="up")view.scrollBy(0,-view.innerHeight*0.8);else if(direction==="down")view.scrollBy(0,view.innerHeight*0.8);'
    + 'else if(direction==="top")view.scrollTo(0,0);else if(direction==="bottom")view.scrollTo(0,document.documentElement.scrollHeight);'
    + 'else throw Error("Unknown scroll direction.");return {scrolled:true}}'
    + 'if(action==="browser.history"){if(parameters.direction==="back")history.back();else if(parameters.direction==="forward")history.forward();'
    + 'else throw Error("Unknown history direction.");return {navigated:true}}'
    + 'throw Error("Unsupported browser action: "+action)}'
    + 'window.__nndBrowserBridgePerform=perform;'
    + 'window.addEventListener("message",function(event){var data=event.data;'
    + 'if(!data||data.nndBridge!==true||typeof data.requestId!=="string")return;'
    + 'var outcome;try{outcome={ok:true,data:perform(String(data.action),data.parameters||{})}}'
    + 'catch(error){outcome={ok:false,error:String(error&&error.message||error).slice(0,300)}}'
    + 'event.source.postMessage({nndBridgeReply:true,requestId:data.requestId,result:outcome},"*")})})()';
}

interface Observation { url: string; revision: number; id: string }

export interface ExecutorDeps { getFrame: () => HTMLIFrameElement | null;
  currentUrl: () => string | undefined; onOpen?: (url: string) => void;
  onStatus?: (status: string) => void; random?: () => string }

export interface BrowserTabExecutorHandle { close(): void }

interface ExecutorState { revision: number; observation: Observation | null;
  pending: Map<string, (outcome: BridgeOutcome) => void> }

function bridgeAsk(frame: HTMLIFrameElement | null, action: string, parameters: Record<string, unknown>,
  state: ExecutorState, random: () => string): Promise<BridgeOutcome> {
  return new Promise((resolve) => {
    const target = frame?.contentWindow;
    if (!target) { resolve({ ok: false, error: 'Open a page in the browser preview pane first.' }); return; }
    const requestId = 'bridge-' + random();
    const timer = setTimeout(() => {
      if (state.pending.delete(requestId)) resolve({ ok: false, error: 'The preview page did not answer the action.' });
    }, 15_000);
    state.pending.set(requestId, (outcome) => { clearTimeout(timer); resolve(outcome); });
    target.postMessage({ nndBridge: true, requestId, action, parameters }, '*');
  });
}

function requireObserved(state: ExecutorState, input: Record<string, unknown>, deps: ExecutorDeps): void {
  const { expectedUrl, observationRevision, observationId } = input;
  if (typeof expectedUrl !== 'string' || expectedUrl !== deps.currentUrl()
    || !Number.isSafeInteger(observationRevision) || observationRevision !== state.observation?.revision
    || typeof observationId !== 'string' || observationId !== state.observation?.id) {
    throw new Error('The page changed; take a new snapshot first.');
  }
}

async function runAction(action: string, rawParameters: unknown, frame: HTMLIFrameElement | null,
  state: ExecutorState, deps: ExecutorDeps, random: () => string): Promise<BridgeOutcome> {
  const input = (rawParameters ?? {}) as Record<string, unknown>;
  try {
    if (action === 'browser.open') {
      const requested = String(input.url ?? '');
      if (!previewProxyUrl(requested)) {
        return { ok: false, error: 'Browser-only preview opens only loopback dev-server pages through the '
          + 'same-origin preview proxy.' };
      }
      state.observation = null;
      deps.onOpen?.(requested);
      return { ok: true, data: { url: requested, opened: true, settled: false } };
    }
    if (action === 'browser.snapshot') {
      const outcome = await bridgeAsk(frame, 'browser.snapshot', {}, state, random);
      if (!outcome.ok) return outcome;
      const page = outcome.data as { title?: unknown; text?: unknown; nodeCount?: unknown };
      state.revision += 1;
      state.observation = { url: deps.currentUrl() ?? '', revision: state.revision, id: random() };
      return { ok: true, data: { url: state.observation.url, title: page.title ?? '', text: page.text ?? '',
        nodeCount: page.nodeCount ?? 0, observationRevision: state.observation.revision,
        observationId: state.observation.id } };
    }
    if (action === 'browser.inspect') {
      return await bridgeAsk(frame, 'browser.inspect', { selector: String(input.selector ?? '') }, state, random);
    }
    requireObserved(state, input, deps);
    if (action === 'browser.click') {
      return await bridgeAsk(frame, 'browser.click', { selector: String(input.selector ?? '') }, state, random);
    }
    if (action === 'browser.type') {
      return await bridgeAsk(frame, 'browser.type', { selector: String(input.selector ?? ''),
        text: String(input.text ?? '') }, state, random);
    }
    if (action === 'browser.scroll') {
      return await bridgeAsk(frame, 'browser.scroll', { direction: String(input.direction ?? '') }, state, random);
    }
    if (action === 'browser.history') {
      return await bridgeAsk(frame, 'browser.history', { direction: String(input.direction ?? '') }, state, random);
    }
    if (action === 'browser.capture') {
      return { ok: false, error: 'Raster capture is unavailable in a browser-only tab; no capture was produced. '
        + 'Use a connected desktop for viewport capture.' };
    }
    return { ok: false, error: 'Unsupported browser action: ' + action };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Browser action failed.' };
  }
}

export function connectBrowserTabExecutor(origin: string, deps: ExecutorDeps): BrowserTabExecutorHandle {
  const socket = new WebSocket(origin.replace(/^http/u, 'ws') + '/api/browser-control/ws');
  let closed = false;
  const random = deps.random ?? (() => crypto.randomUUID());
  const state: ExecutorState = { revision: 0, observation: null, pending: new Map() };
  const request = (payload: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };
  window.addEventListener('message', (event) => {
    const data = event.data as { nndBridgeReply?: unknown; requestId?: unknown; result?: unknown } | null;
    if (!data || data.nndBridgeReply !== true || typeof data.requestId !== 'string') return;
    const resolve = state.pending.get(data.requestId);
    if (!resolve) return;
    state.pending.delete(data.requestId);
    const result = data.result as { ok?: unknown; data?: unknown; error?: unknown } | null;
    if (result && result.ok === true) resolve({ ok: true, data: result.data });
    else resolve({ ok: false, error: String(result?.error ?? 'The preview action failed.').slice(0, 300) });
  });
  socket.onopen = () => deps.onStatus?.('registered');
  socket.onclose = () => deps.onStatus?.('disconnected');
  socket.onerror = () => deps.onStatus?.('error');
  socket.onmessage = (event) => {
    let message: { type?: unknown; requestId?: unknown; action?: unknown; parameters?: unknown };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type !== 'request' || typeof message.requestId !== 'string'
      || typeof message.action !== 'string') return;
    request({ type: 'claim', requestId: message.requestId });
    void runAction(String(message.action), message.parameters, deps.getFrame(), state, deps, random)
      .then((result) => request({ type: 'result', requestId: message.requestId, result }));
  };
  return {
    close(): void {
      if (closed) return;
      closed = true;
      try { socket.close(); } catch { /* already closing */ }
    },
  };
}
