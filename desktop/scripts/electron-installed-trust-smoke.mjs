// SPDX-License-Identifier: Apache-2.0
import { mkdir, readdir } from 'node:fs/promises';
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';
const root = 'D:/ProjectRepo/NotNativeAgent/.tmp/trust-acceptance-empty';
await mkdir(root, { recursive: true });
if ((await readdir(root)).length) throw new Error('Trust acceptance requires an empty disposable directory');

async function trustScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000; while (Date.now() < deadline) {
    const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 50)); } throw new Error(`Trust acceptance timed out: ${label}`); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async text => (await wait(() => button(text) && !button(text).matches(':disabled') && button(text), text)).click();
  const change = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  const read = async () => { const response = await fetch('/api/v1/nnd/configuration/trust'); if (!response.ok) throw new Error('Trust read failed'); return response.json(); };
  const target = 'D:/ProjectRepo/NotNativeAgent/.tmp/trust-acceptance-empty', normalized = value => value.replaceAll('\\', '/').toLowerCase();
  const before = await read(), rows = view => view.workspaces.map(row => normalized(row.root)).sort();
  if (rows(before).includes(normalized(target))) throw new Error('Test root is already trusted; refusing to change it');
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click(); await click('Trust and secrets');
  await wait(() => document.querySelector('[data-testid="trust-draft"]'), 'Trust form');
  change(document.querySelector('[data-testid="trust-draft"]'), target); await click('Review grant'); await click('Cancel trust change');
  if (JSON.stringify(rows(await read())) !== JSON.stringify(rows(before))) throw new Error('Cancel changed trust');
  let granted = false;
  try {
    change(document.querySelector('[data-testid="trust-draft"]'), target); await click('Review grant'); await click('Confirm grant');
    await wait(() => document.querySelector('[data-testid="trust-receipt"]')?.textContent.includes('Granted'), 'grant receipt'); granted = true;
    const after = await read(); if (!rows(after).includes(normalized(target))) throw new Error('Grant not persisted');
    change(document.querySelector('[aria-label="Filter trusted roots"]'), target);
    await wait(() => document.querySelectorAll('[data-testid="trust-row"]').length === 1, 'filtered root');
    const row = document.querySelector('[data-testid="trust-row"]'); if (!normalized(row.textContent).includes(normalized(target))) throw new Error('Wrong filtered trust owner');
    (await wait(() => { const target = document.querySelector('[data-testid="trust-row"] button'); return target && !target.matches(':disabled') && target; }, 'revoke enabled')).click(); await click('Confirm revoke');
    await wait(() => document.querySelector('[data-testid="trust-receipt"]')?.textContent.includes('Revoked'), 'revoke receipt');
    if (JSON.stringify(rows(await read())) !== JSON.stringify(rows(before))) throw new Error('Trust restoration failed'); granted = false;
  } finally { if (granted || rows(await read()).includes(normalized(target))) { const response = await fetch('/api/v1/nnd/configuration/trust/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: target }) });
    if (!response.ok || JSON.stringify(rows(await read())) !== JSON.stringify(rows(before))) throw new Error('Disposable grant cleanup failed'); } }
  await click('Secrets'); await wait(() => document.querySelector('[data-testid="secret-roster"]'), 'Secrets'); await click('Refresh');
  await click('MCP credentials'); await wait(() => document.querySelector('[data-testid="mcp-status"]'), 'MCP'); await click('Refresh');
  await click('Credential diagnostics'); await wait(() => document.querySelector('[data-testid="secrets-status"]') && document.querySelector('[data-testid="legacy-credentials-receipt"]'), 'Diagnostics');
  if (document.querySelector('[role="tabpanel"]').querySelector('[role="alert"]')) throw new Error('Credential diagnostic failed');
  await click('Advanced'); if (document.querySelector('[data-settings-item="native-secret-actions.settings"]') || document.querySelector('[data-testid="trust-draft"]')) throw new Error('Trust controls still duplicated in Advanced');
  await click('Trust and secrets'); await wait(() => document.querySelector('[data-testid="trust-list"]'), 'Final trust list');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', fourTabs: true, cancelNoWrite: true, grantRevoke: true, existingGrantsPreserved: true, advancedDeduplicated: true };
}
await runInstalledUiAcceptance(trustScenario, 'NNA_INSTALLED_TRUST_OK');
