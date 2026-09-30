// SPDX-License-Identifier: Apache-2.0

const MAX_SESSION_ID_LENGTH = 500;

/** Parse only the harmless focus and session actions supported by the shell. */
export function parseDesktopDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > 4_096) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'openchamber:' || url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.hostname === 'focus' && (url.pathname === '' || url.pathname === '/')) return { type: 'focus' };
  if (url.hostname !== 'session') return null;
  let sessionId;
  try { sessionId = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { return null; }
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f/\\]/u.test(sessionId)) return null;
  return { type: 'session', sessionId };
}

export function extractDesktopDeepLinks(argv) {
  if (!Array.isArray(argv)) return [];
  const links = [];
  for (const argument of argv) {
    const parsed = parseDesktopDeepLink(argument);
    if (parsed) links.push(parsed);
  }
  return links;
}
