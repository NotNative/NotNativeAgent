// SPDX-License-Identifier: Apache-2.0
import { runInstalledLifecycleAcceptance } from './installed-lifecycle-fixture.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function generalScenario(fixture) {
  const wait = async (read, label) => { const deadline = Date.now() + 95000; while (Date.now() < deadline) {
    const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`General acceptance timed out: ${label}`); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async text => (await wait(() => button(text) && !button(text).disabled && button(text), text)).click();
  const read = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await window.__NOTNATIVE_DESKTOP_INVOKE__('desktop_native_host', { action: 'read' });
      if (result.ok) return result.result;
      if (result.error !== 'native-host-busy') throw new Error(result.error);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Host action remained busy');
  };
  await wait(() => window.__notnativeAppReady === true, 'boot');
  const before = await read();
  const editor = await wait(() => new URLSearchParams(location.search).get('session') === fixture.sessionId && !document.querySelector('[data-testid="chat-draft-landing"]') && document.querySelector('[data-testid="composer-editor"]'), 'existing conversation editor');
  if (editor.value) throw new Error('Acceptance requires an empty isolated existing-session composer');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Installed lifecycle continuity verification');
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  await click('Settings'); await click('General');
  await wait(() => document.querySelector('select[aria-label="NNA shortcut opens"]') && !document.querySelector('select[aria-label="NNA shortcut opens"]').disabled, 'host observation');
  const select = value => { const node = document.querySelector('select[aria-label="NNA shortcut opens"]'); node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); };
  let current;
  try {
    select(before.target === 'desktop' ? 'browser' : 'desktop'); await click('Discard launch change');
    if ((await read()).revision !== before.revision) throw new Error('Discard published a launch preference');
    select(before.target === 'desktop' ? 'browser' : 'desktop'); await click('Save launch preference');
    await wait(async () => { const state = await read(); return state.target !== before.target && state; }, 'saved target');
    await click('Refresh host');
    await wait(() => !document.querySelector('select[aria-label="NNA shortcut opens"]').disabled, 'refresh');
    select(before.target); await click('Save launch preference');
    await wait(async () => (await read()).target === before.target, 'restored target');
    const login = document.querySelector('input[aria-label="Start NNA background service at Windows sign-in"]');
    await wait(() => !login.disabled, 'login ready'); login.click();
    await wait(async () => { current = await read(); return current.enabled !== before.enabled && current.enabled === current.login_installed; }, 'changed login');
    await wait(() => !login.disabled, 'login restore ready'); login.click();
    await wait(async () => { current = await read(); return current.enabled === before.enabled && current.login_installed === before.login_installed; }, 'restored login');
    await click('Restart NNA'); await click('Cancel restart');
    if ((await read()).generation !== before.generation) throw new Error('Restart cancellation changed generation');
    await click('Refresh version'); await wait(() => document.querySelector('[data-settings-item="native.about"]').textContent.includes(before.version), 'version');
    await click('Open in browser'); await wait(() => document.querySelector('[data-testid="host-receipt"]')?.textContent.includes('Opened NNA'), 'browser opened');
    if (!JSON.parse(localStorage.getItem('nnd.lastSession.v1') || '{"runtimes":{}}').runtimes[window.__NOTNATIVE_RUNTIME_KEY__]?.sessionId) throw new Error('Selected conversation was replaced during startup');
    await click('Restart NNA'); await click('Confirm restart');
    // Invariant: completion belongs to the replacement window; the old renderer can disappear before its receipt paints.
    return { nativeShell: true, awaitReconnect: true };
  } catch (error) {
    // Compatibility: recovery uses the same host owner and restores only this test's changed fields.
    current = await read();
    if (current.target !== before.target) await window.__NOTNATIVE_DESKTOP_INVOKE__('desktop_native_host', { action: 'preferences', value: { revision: current.revision, target: before.target } });
    if (current.enabled !== before.enabled) await window.__NOTNATIVE_DESKTOP_INVOKE__('desktop_native_host', { action: 'login', value: { enabled: before.enabled } });
    throw error;
  }
}

export async function reconnectedScenario(fixture) {
  const wait = async (read, label) => { const deadline = Date.now() + 25000; while (Date.now() < deadline) {
    const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Reconnect acceptance timed out: ${label}`); };
  await wait(() => window.__notnativeAppReady === true, 'boot');
  if (!Object.values(JSON.parse(localStorage.getItem('nnd.draft.v1') || '{}')).some(row => row.text === 'Installed lifecycle continuity verification')) throw new Error('Continuity cache did not contain the existing-session text');
  const editor = await wait(() => { const input = document.querySelector('[data-testid="composer-editor"]'); return input?.value === 'Installed lifecycle continuity verification' && new URLSearchParams(location.search).get('session') === fixture.sessionId && !document.querySelector('[data-testid="chat-draft-landing"]') && input; }, 'restored existing-session unsent text').catch(error => {
    const runtimes = JSON.parse(localStorage.getItem('nnd.lastSession.v1') || '{"runtimes":{}}').runtimes;
    throw new Error(`${error.message}; articles=${document.querySelectorAll('[data-chat-column] article').length}; pointer=${!!runtimes[window.__NOTNATIVE_RUNTIME_KEY__]}; landing=${!!document.querySelector('[data-testid="chat-draft-landing"]')}; continuity=${document.querySelector('[data-native-continuity]')?.getAttribute('data-native-continuity')}; session=${new URLSearchParams(location.search).get('session')}; expected=${fixture.sessionId}`);
  });
  if (new URLSearchParams(location.search).get('session') !== fixture.sessionId) throw new Error('Restart selected a different conversation');
  const boot = await window.__NOTNATIVE_DESKTOP_INVOKE__('desktop_boot_config_get');
  if (!boot.ok || boot.result.continuity) throw new Error('Continuity handoff was not acknowledged');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, ''); editor.dispatchEvent(new Event('input', { bubbles: true }));
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  await wait(() => document.querySelector('select[aria-label="NNA shortcut opens"]') && !document.querySelector('select[aria-label="NNA shortcut opens"]').disabled, 'ready host controls');
  if (document.querySelector('[data-settings-item="native.host"] [role="alert"]')) throw new Error('Reconnected host observation failed');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', newGeneration: true, desktopReconnected: true, unsentTextPreserved: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runInstalledLifecycleAcceptance(generalScenario, 'NNA_INSTALLED_GENERAL_OK', reconnectedScenario);
