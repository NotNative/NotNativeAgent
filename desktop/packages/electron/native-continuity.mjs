// SPDX-License-Identifier: Apache-2.0
/** Presentation caches stay untrusted; this copies no cookies, credentials, grants or engine state. */
export async function captureNativeContinuity(contents, runtime) {
  if (!contents || contents.isDestroyed()) throw new Error('native-continuity-unavailable');
  const source = `(() => {
    const runtime = ${JSON.stringify(runtime)};
    const drafts = JSON.parse(localStorage.getItem('nnd.draft.v1') || '{}');
    const last = JSON.parse(localStorage.getItem('nnd.lastSession.v1') || '{"version":1,"runtimes":{}}');
    const selected = Object.fromEntries(Object.entries(drafts).filter(([key]) => key.startsWith(runtime+'\\n')));
    if (Object.keys(selected).length > 512) throw new Error('Too many draft records');
    return { runtime, drafts: JSON.stringify(selected),
      lastSession: JSON.stringify({ version: 1, runtimes: last.runtimes?.[runtime] ? { [runtime]: last.runtimes[runtime] } : {} }) };
  })()`;
  let value;
  try { value = await contents.executeJavaScript(source); }
  catch { throw new Error('native-continuity-unavailable'); }
  if (!value || value.runtime !== runtime || typeof value.drafts !== 'string' || typeof value.lastSession !== 'string') throw new Error('native-continuity-unavailable');
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new Error('native-continuity-too-large');
  return value;
}
