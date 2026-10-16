// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function credentialsScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000; while (Date.now() < deadline) {
    const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 50)); } throw new Error(`Credential acceptance timed out: ${label}`); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
  const click = async text => (await wait(() => button(text) && !button(text).matches(':disabled') && button(text), text)).click();
  const input = (testId, value) => { const node = document.querySelector(`[data-testid="${testId}"]`); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  const read = async () => { const response = await fetch('/api/v1/nnd/configuration/mcp-credentials'); if (!response.ok) throw new Error('MCP credential read failed'); return response.json(); };
  const before = await read(), refs = view => view.credentials.map(row => row.reference).sort(), serverId = 'nna-disposable-' + Date.now(); let reference;
  const marker = 'NNA_MCP_MANAGED_' + serverId.toUpperCase().replace(/[^A-Z0-9]/gu, '_') + '_';
  try {
    (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click(); await click('Trust and secrets'); await click('MCP credentials');
    await wait(() => document.querySelector('[data-testid="mcp-status"]'), 'credential state');
    input('mcp-server', serverId); input('mcp-token', 'not-a-real-token-for-disposable-verification'); await click('Stage the credential'); await click('Discard stage');
    if (JSON.stringify(refs(await read())) !== JSON.stringify(refs(before))) throw new Error('Discard saved a credential');
    input('mcp-server', serverId); input('mcp-token', 'not-a-real-token-for-disposable-verification'); await click('Stage the credential'); await click('Save credential');
    await wait(() => document.querySelector('[data-testid="mcp-status"]')?.textContent.includes('references: ' + (before.count + 1)), 'saved reference');
    reference = refs(await read()).find(value => value.startsWith(marker) && !refs(before).includes(value)); if (!reference) throw new Error('Missing new reference');
    const row = [...document.querySelectorAll('[data-testid="mcp-list"] li')].find(node => node.textContent.includes(reference));
    (await wait(() => row?.querySelector('button') && !row.querySelector('button').matches(':disabled') && row.querySelector('button'), 'delete ready')).click();
    await click('Discard delete'); if (!refs(await read()).includes(reference)) throw new Error('Discard delete removed reference');
    row.querySelector('button').click(); await click('Delete credential');
    await wait(async () => JSON.stringify(refs(await read())) === JSON.stringify(refs(before)), 'credential cleanup'); reference = null;
    return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', stageDiscard: true, saveUnboundReference: true, cancelDelete: true, deleteDisposableOnly: true, existingReferencesPreserved: true };
  } finally { const view = await read(); reference ??= refs(view).find(value => value.startsWith(marker) && !refs(before).includes(value));
    if (reference) { const response = await fetch('/api/v1/nnd/configuration/mcp-credentials/credentials/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installation_id: view.installation_id, data_id: view.data_id, scope: 'user', operation_id: crypto.randomUUID(), reference }) }); if (!response.ok) throw new Error('Disposable reference cleanup failed'); } }
}
await runInstalledUiAcceptance(credentialsScenario, 'NNA_INSTALLED_TRUST_CREDENTIALS_OK');
