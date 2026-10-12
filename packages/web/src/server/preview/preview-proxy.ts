// SPDX-License-Identifier: Apache-2.0
/**
 * Same-origin preview proxy (F7 scoped capability): serves an admitted dev
 * server through the NND origin so the operator's browser tab can inspect,
 * annotate, and DOM-capture the preview without Electron. Only ports that
 * dev-server discovery currently reports are proxied; loopback only, no
 * operator credentials forwarded.
 */
import type { Context, Hono } from 'hono';

const MAX_HTML_BUFFER_BYTES = 2_000_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/** In-page bridge for the F7 scoped capability: executes broker actions on
 * the proxied document with page-level authority only (no privileged IPC,
 * no secrets); results travel back by postMessage to the hosting app tab. */
const BRIDGE_SCRIPT = '<script>(function(){'
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
  + 'event.source.postMessage({nndBridgeReply:true,requestId:data.requestId,result:outcome},"*")})})()</' + 'script>';

function injectBridge(html: string): string {
  const closing = html.toLowerCase().lastIndexOf('</body>');
  if (closing >= 0) return html.slice(0, closing) + BRIDGE_SCRIPT + html.slice(closing);
  return html + BRIDGE_SCRIPT;
}

export interface PreviewProxyOptions {
  allowedPorts: () => Promise<readonly number[]>;
  fetcher?: typeof fetch;
}

function suffixTarget(port: number, suffix: string, query: string): string | null {
  const rest = suffix.replace(/^\/+/u, '');
  try {
    return new URL('http://127.0.0.1:' + port + '/' + rest + query).href;
  } catch { return null; }
}

/** Drop framing denials so the app tab may host the preview same-origin;
 * keep every other response byte untouched. */
function framingHeaders(headers: Headers): Headers {
  const outgoing = new Headers();
  let sawCsp = false;
  for (const [key, value] of headers) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'x-frame-options') continue;
    if (lower === 'content-security-policy') {
      sawCsp = true;
      const directives = value.split(';').filter((directive) => {
        const name = directive.trim().split(/\s+/u)[0]?.toLowerCase();
        return name !== 'frame-ancestors' && name !== 'sandbox' && directive.trim() !== '';
      });
      directives.push("frame-ancestors 'self'");
      outgoing.set(key, directives.join('; '));
      continue;
    }
    outgoing.set(key, value);
  }
  if (!sawCsp) outgoing.set('content-security-policy', "frame-ancestors 'self'");
  return outgoing;
}

async function proxyThrough(context: Context, port: number, suffix: string,
  options: PreviewProxyOptions): Promise<Response> {
  const allowed = await options.allowedPorts();
  if (!allowed.includes(port)) return context.body('That port is not an available dev server', 403);
  const incoming = context.req.raw;
  const queryIndex = incoming.url.indexOf('?');
  const target = suffixTarget(port, suffix, queryIndex >= 0 ? incoming.url.slice(queryIndex) : '');
  if (!target) return context.body('Invalid preview proxy target', 400);
  const headers = new Headers(incoming.headers);
  for (const key of ['cookie', 'authorization', 'x-nnd-browser-token']) headers.delete(key);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(target, {
      method: incoming.method, headers,
      body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : incoming.body,
      redirect: 'manual', signal: AbortSignal.timeout(30_000), duplex: 'half',
    } as RequestInit);
  } catch {
    return context.body('Preview proxy target unreachable', 502);
  }
  const outgoing = framingHeaders(response.headers);
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) {
    return new Response(response.body, { status: response.status, headers: outgoing });
  }
  const buffered = await response.arrayBuffer();
  if (buffered.byteLength > MAX_HTML_BUFFER_BYTES) {
    return context.body('Preview document exceeds the proxy buffer', 502);
  }
  return new Response(injectBridge(Buffer.from(buffered).toString('utf8')),
    { status: response.status, headers: outgoing });
}

export function registerPreviewProxyRoutes(app: Hono, options: PreviewProxyOptions): void {
  app.all('/api/preview-proxy/:port/*', (c) =>
    proxyThrough(c, Number(c.req.param('port')), c.req.param('0') ?? '/', options));
  app.all('/api/preview-proxy/:port', (c) => proxyThrough(c, Number(c.req.param('port')), '/', options));
}
