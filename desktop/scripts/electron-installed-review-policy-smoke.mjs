// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function reviewPolicyScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Review policy acceptance timed out: ${label}`); };
  const button = text => [...document.querySelectorAll('button')].find(row => row.textContent.trim() === text);
  const read = async id => { const response = await fetch(`/api/v1/nnd/sessions/${encodeURIComponent(id)}/review-mode`); return response.ok ? response.json() : null; };
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  (await wait(() => button('Agent policy'), 'Agent policy')).click();
  const chooser = await wait(() => document.querySelector('[aria-label="Conversation to configure"]'), 'conversation selector');
  const options = await wait(() => chooser.options.length > 1 && [...chooser.options].filter(row => row.value).slice(0, 64), 'active conversations');
  let original, session;
  for (const option of options) { const snapshot = await read(option.value); if (snapshot) { original = snapshot; session = option.value; break; } }
  if (!session) throw new Error('No owned conversation available for review policy acceptance');
  chooser.value = session; chooser.dispatchEvent(new Event('change', { bubbles: true }));
  const mode = await wait(() => document.querySelector('[data-testid="review-mode-control"] select:not(:disabled)'), 'idle review mode');
  const select = value => { mode.value = value; mode.dispatchEvent(new Event('change', { bubbles: true })); };
  const target = original.mode === 'default' ? 'auto-review' : 'default';
  let confirmed;
  try { select(target); confirmed = await wait(async () => { const result = await read(session); return result?.mode === target && result.revision > original.revision && result; }, 'native mode acknowledgement'); }
  finally {
    const current = await read(session);
    if (current?.mode === target && current.revision === (confirmed?.revision ?? original.revision + 1)) {
      await wait(() => !mode.disabled, 'save settled'); select(original.mode);
      await wait(async () => { const result = await read(session); return result?.mode === original.mode && result.revision > current.revision; }, 'original mode restored');
    } else if (current?.mode !== original.mode || current.revision !== original.revision) throw new Error('Concurrent policy edit prevents restoration');
  }
  button('Refresh permission mode').click(); await wait(() => !mode.disabled && mode.value === original.mode, 'review refresh');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', conversationScoped: true, nativeRevisionConfirmed: true, originalPolicyRestored: true, refresh: true };
}

await runInstalledUiAcceptance(reviewPolicyScenario, 'NNA_INSTALLED_REVIEW_POLICY_OK');
