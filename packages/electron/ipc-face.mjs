// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal desktop invoke face (doc 09 §11.1 v1 + D-09-3). Extracted from
 * main.mjs for file-cap hygiene: sender framing + the command allowlist
 * (desktop_open_external / desktop_get_boot_info). Unknown commands never
 * throw raw — every path answers { ok, error }.
 */
import { ipcMain, shell } from 'electron';

export function senderFrameUrls(event) {
  const urls = [];
  for (const frame of event.frames ?? []) {
    if (frame && typeof frame.url === 'string') urls.push(frame.url);
  }
  const own = event.senderFrame && typeof event.senderFrame.url === 'string' ? event.senderFrame.url : '';
  if (!urls.includes(own) && own) urls.push(own);
  return urls;
}

function stringifyError(error) {
  try { return error instanceof Error ? `${error.stack ?? error.message}` : String(error); } catch { return '[unstringifiable]'; }
}

export function createInvokeFace(input) {
  function isLocalSender(event) {
    const origin = `${input.origin()}/`;
    const appPrefix = input.appPathPrefix();
    const urls = senderFrameUrls(event);
    if (urls.length === 0) return false;
    return urls.some((url) => (
      url.startsWith(origin) || url === origin.replace(/\/$/u, '')
      || url.startsWith('data:text/html') // our own splash document
      || url.startsWith(appPrefix)
    ));
  }

  function runInvokeCommand(command, payload) {
    if (command === 'desktop_open_external') {
      const target = payload && typeof payload.url === 'string' ? payload.url : '';
      try {
        const parsed = new URL(target);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'url-must-be-http-or-https' };
        shell.openExternal(parsed.href).catch(() => { /* browser open is best-effort */ });
        return { ok: true };
      } catch { return { ok: false, error: 'invalid-url' }; }
    }
    if (command === 'desktop_get_boot_info') {
      return { ok: true, result: input.bootInfo() };
    }
    return { ok: false, error: 'unknown-command' }; // never throws raw (§11.1)
  }

  return {
    /** Wire the ipcMain listener exactly once. */
    register() {
      ipcMain.on('nnd:desktop-invoke', (event, envelope) => {
        const seq = envelope && typeof envelope.seq === 'number' ? envelope.seq : -1;
        const reply = (result) => {
          try { event.sender.send('nnd:desktop-reply', { seq, ...result }); } catch { /* frame gone */ }
        };
        let result;
        try {
          if (!isLocalSender(event)) {
            console.warn(`[shell] invoke rejected for sender: ${JSON.stringify(senderFrameUrls(event))}`);
            result = { ok: false, error: 'sender-not-allowed' };
          } else {
            result = runInvokeCommand(String(envelope?.command ?? ''), envelope?.payload);
          }
        } catch (error) {
          result = { ok: false, error: stringifyError(error) };
        }
        reply(result);
      });
    },
  };
}
