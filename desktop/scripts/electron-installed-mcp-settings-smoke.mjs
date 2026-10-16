// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function mcpScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`MCP acceptance timed out: ${label}`); };
  const read = async () => { const response = await fetch('/api/v1/nnd/configuration/mcp'); if (!response.ok) throw new Error(`MCP read: ${response.status}`); return response.json(); };
  const button = text => [...document.querySelectorAll('button')].find(row => row.textContent.trim() === text);
  const id = `nna_ui_acceptance_${Date.now()}`;
  const change = (label, value) => { const node = [...document.querySelectorAll('label')].find(row => row.firstChild.textContent.trim() === label)?.querySelector('input,select,textarea');
    if (!node) throw new Error(`Missing ${label}`); if (node.tagName === 'SELECT') { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }
    else { const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); } };
  const original = await read(); if (original.project_shadowed) throw new Error('Project owns MCP configuration; acceptance cannot edit user definitions');
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  (await wait(() => button('Tools and integrations'), 'Tools')).click();
  await wait(() => document.querySelector('[aria-label="Native MCP configuration"] input'), 'native editor');
  const previewSave = async () => { button('Preview native change').click(); (await wait(() => button('Save with native revision check'), 'preview')).click();
    await wait(() => [...document.querySelectorAll('[role="status"]')].some(row => row.textContent.includes('Saved to NNA')), 'receipt'); };
  const refresh = async () => { button('Refresh').click(); await wait(() => document.querySelector('[aria-label="Native MCP configuration"] select'), 'editor refresh'); };
  let created = false;
  try {
    change('Server ID', id); change('Command', 'node'); change('Arguments, one per line', '--version'); await previewSave(); created = true;
    const added = (await read()).servers.find(row => row.id === id); if (!added || added.enabled || added.trusted) throw new Error('New server was not disabled and untrusted');
    await refresh(); change('Action', 'patch'); await wait(() => [...document.querySelectorAll('label')].some(row => row.firstChild.textContent.trim() === 'Server'), 'patch form');
    change('Server', id); change('Deadline to change', 'timeout_ms'); await wait(() => document.querySelector('input[type="number"]'), 'deadline input');
    change('Milliseconds', '5000'); await previewSave();
    if ((await read()).servers.find(row => row.id === id)?.timeout_ms !== 5000) throw new Error('MCP deadline not persisted');
  } finally {
    if (created) { await refresh(); change('Action', 'delete'); await wait(() => document.querySelector('input[type="checkbox"]'), 'delete confirmation');
      change('Server', id); await new Promise(done => setTimeout(done, 0)); document.querySelector('input[type="checkbox"]').click(); await previewSave();
      if ((await read()).servers.some(row => row.id === id)) throw new Error('Disposable MCP definition was not removed'); }
  }
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', createdDisabled: true, deadlinePatched: true, definitionRemoved: true, originalServerCount: original.servers.length };
}

await runInstalledUiAcceptance(mcpScenario, 'NNA_INSTALLED_MCP_SETTINGS_OK');
