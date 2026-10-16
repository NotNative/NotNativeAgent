// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function cohesionScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Settings cohesion acceptance timed out: ${label}`); };
  const find = (text, scope = document) => [...scope.querySelectorAll('button')].find(row => row.textContent.trim() === text || row.getAttribute('aria-label') === text);
  const click = async text => (await wait(() => { const node = find(text); return node && !node.disabled && node; }, text)).click();
  const input = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  const decision = () => document.querySelector('dialog[aria-label="Unsaved settings"][open]');
  const read = async () => { const response = await fetch('/api/v1/nnd/configuration/web-search'); if (!response.ok) throw new Error('Search observation failed'); return response.json(); };
  const before = await read();
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  await click('Search and browsing'); await wait(() => document.querySelector('[data-testid="websearch-name-add"]'), 'Search form');
  input(document.querySelector('[data-testid="websearch-name-add"]'), 'Unsaved installed verification');
  await wait(() => document.querySelector('[data-testid="websearch-name-add"]').value.includes('Unsaved'), 'draft');
  await click('Web fetch'); await wait(decision, 'tab guard'); await click('Keep editing');
  if (!document.querySelector('[data-testid="websearch-name-add"]')?.value.includes('Unsaved')) throw new Error('Keep editing lost the draft');
  await click('Appearance'); await wait(decision, 'page guard'); await click('Discard changes');
  await wait(() => find('Appearance') && document.querySelector('[data-settings-item="native.theme"]'), 'Appearance');
  await wait(() => [...document.querySelectorAll('[data-testid="settings-window"] [role="status"]')].some(node => node.textContent.includes('Interface preferences')), 'preference status');
  await click('Search and browsing'); await wait(() => document.querySelector('[data-testid="websearch-name-add"]'), 'Search reload');
  if (document.querySelector('[data-testid="websearch-name-add"]').value) throw new Error('Discarded draft returned');
  if (document.querySelector('[data-testid="settings-window"]').textContent.includes('Interface preferences saved')) throw new Error('Unrelated preference banner');
  input(document.querySelector('[data-testid="websearch-name-add"]'), 'Unsaved installed verification');
  await click('Close settings'); await wait(decision, 'close guard'); await click('Keep editing');
  input(document.querySelector('[data-settings-search] input'), 'attachment'); await wait(decision, 'search guard'); await click('Keep editing');
  await click('Refresh'); await wait(decision, 'refresh guard'); await click('Discard changes');
  await wait(() => document.querySelector('[data-testid="websearch-name-add"]')?.value === '', 'refresh discarded draft');
  const tab = [...document.querySelectorAll('[role="tab"]')].find(row => row.textContent === 'Web search');
  tab.focus(); tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await wait(() => document.querySelector('[role="tabpanel"][aria-label="Web fetch"]'), 'keyboard tab');
  if (document.activeElement?.textContent !== 'Web fetch') throw new Error('Keyboard tab focus did not follow selection');
  await click('Data and diagnostics'); await click('Files');
  await wait(() => find('Edit Allow attachments') && !find('Edit Allow attachments').disabled, 'File editor'); await click('Edit Allow attachments');
  await click('Preview change'); await wait(() => find('Save to NNA'), 'native preview');
  await click('Environment'); await wait(decision, 'preview guard'); await click('Keep editing');
  await click('Cancel edit'); await wait(() => !find('Cancel edit'), 'cancel editor'); await click('Environment');
  await wait(() => document.querySelector('[data-testid="native-environment-table"]'), 'Environment');
  if ((await read()).source_revision !== before.source_revision) throw new Error('Navigation changed native search configuration');
  await click('Diagnostic summary'); await wait(() => document.querySelector('[data-testid="diagnostic-summary"]'), 'Summary');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', tabGuard: true, pageGuard: true,
    closeGuard: true, searchGuard: true, refreshGuard: true, keyboardTabs: true, previewCancel: true, configurationUnchanged: true };
}

await runInstalledUiAcceptance(cohesionScenario, 'NNA_INSTALLED_SETTINGS_COHESION_OK');
