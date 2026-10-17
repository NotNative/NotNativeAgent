// SPDX-License-Identifier: Apache-2.0
import { runInstalledLifecycleAcceptance } from './installed-lifecycle-fixture.mjs';
import { reconnectedScenario } from './electron-installed-general-smoke.mjs';

async function continuityScenario(fixture) {
  const wait = async (read, label) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) {
    const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Continuity acceptance timed out: ${label}`); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async text => (await wait(() => button(text) && !button(text).disabled && button(text), text)).click();
  await wait(() => window.__notnativeAppReady === true && location.search.includes(fixture.sessionId), 'initial draft ready');
  const editor = await wait(() => new URLSearchParams(location.search).get('session') === fixture.sessionId && !document.querySelector('[data-testid="chat-draft-landing"]') && document.querySelector('[data-testid="composer-editor"]'), 'editor').catch(error => { throw new Error(`${error.message}; search=${location.search}; expected=${fixture.sessionId}; continuity=${document.querySelector('[data-native-continuity]')?.getAttribute('data-native-continuity')}; landing=${!!document.querySelector('[data-testid="chat-draft-landing"]')}`); });
  if (editor.value) throw new Error('Acceptance requires an empty isolated existing-session composer');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Installed lifecycle continuity verification');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await click('Settings'); await click('General');
  await wait(() => document.querySelector('select[aria-label="NNA shortcut opens"]') && !document.querySelector('select[aria-label="NNA shortcut opens"]').disabled, 'host ready');
  await click('Restart NNA'); await click('Confirm restart');
  return { nativeShell: true, awaitReconnect: true };
}

await runInstalledLifecycleAcceptance(continuityScenario, 'NNA_INSTALLED_CONTINUITY_OK', reconnectedScenario);
