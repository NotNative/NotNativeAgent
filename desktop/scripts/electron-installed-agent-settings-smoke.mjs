// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function agentSettingsScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Agent settings acceptance timed out: ${label}`); };
  const read = async () => { const response = await fetch('/api/v1/nnd/configuration'); if (!response.ok) throw new Error(`Read failed: ${response.status}`); return response.json(); };
  const button = text => [...document.querySelectorAll('button')].find(row => row.textContent.trim() === text || row.getAttribute('aria-label') === text);
  const change = (node, value) => { const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  const edit = async label => { button(`Edit ${label}`).click(); return wait(() => document.querySelector(`section[aria-label="Edit ${label}"]`), label); };
  const preview = async () => { button('Preview change').click(); await wait(() => button('Save to NNA'), 'resolved preview'); };
  const reload = async () => { const prior = document.querySelector('[data-testid="agent-settings-editor"]'); button('Reload values (discard edit)').click();
    await wait(() => { const current = document.querySelector('[data-testid="agent-settings-editor"]'); return current !== prior && current?.querySelector('fieldset button:not(:disabled)'); }, 'reloaded editable settings'); };
  const original = await read();
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  (await wait(() => button('Agent policy'), 'Agent policy')).click();
  await wait(() => document.querySelector('[data-testid="agent-settings-editor"] button:not(:disabled)'), 'editable policy');
  const verified = [];
  async function probe(label) {
    const form = await edit(label); const control = form.querySelector('textarea, input[type="number"], select, input[aria-label]');
    if (control?.type === 'checkbox') control.click();
    else if (control?.tagName === 'TEXTAREA') change(control, 'Installed UI verification instructions.');
    else if (control?.type === 'number') change(control, control.value || '0');
    else if (control?.tagName === 'SELECT') { control.value = control.value === 'durable' ? 'ephemeral' : 'durable'; control.dispatchEvent(new Event('change', { bubbles: true })); }
    await preview(); verified.push(label);
  }
  for (const label of ['Application instructions', 'Conversation persistence', 'Maximum model steps', 'Local retry limit', 'Turn time limit (ms)', 'Approval wait (ms)', 'Concurrent tools', 'Recovery actions']) await probe(label);
  async function publishAndRestore(path, label, value) {
    const before = original.fields.find(row => row.path === path); let changed = false;
    const save = async () => { await preview(); button('Save to NNA').click(); await wait(() => [...document.querySelectorAll('[role="status"]')].some(row => row.textContent.includes('User defaults saved.')), 'native saved receipt'); };
    try { const form = await edit(label); change(form.querySelector('input[type="number"]'), String(value)); await save(); changed = true;
      const observed = (await read()).fields.find(row => row.path === path); if (observed.explicit.value !== value) throw new Error(`Save did not persist ${path}`);
    } finally { if (changed) { await reload(); const current = (await read()).fields.find(row => row.path === path);
      if (current.explicit.value !== value) throw new Error(`Concurrent edit prevents restoring ${path}`);
      const form = await edit(label); if (before.explicit.present) change(form.querySelector('input[type="number"]'), String(before.explicit.value));
      else form.querySelector('input[type="checkbox"]').click(); await save(); await reload();
      if (JSON.stringify((await read()).fields.find(row => row.path === path).explicit) !== JSON.stringify(before.explicit)) throw new Error(`Restoration failed for ${path}`);
    } }
  }
  await publishAndRestore('recovery.max_model_steps', 'Maximum model steps', Number(original.fields.find(row => row.path === 'recovery.max_model_steps').effective.value) + 1);
  button('Memory and context').click(); await wait(() => button('Edit Context byte ceiling') && !button('Edit Context byte ceiling').disabled, 'context controls');
  for (const label of ['Context byte ceiling', 'First compression threshold', 'Second compression threshold', 'Third compression threshold', 'Full compaction threshold', 'Optional memory retrieval', 'Require memory', 'Memory retrieval timeout (ms)', 'Maximum retrieved items', 'Maximum retrieved bytes']) await probe(label);
  const form = await edit('Context byte ceiling'); form.querySelector('input[type="checkbox"]').click(); await preview();
  form.querySelector('input[type="checkbox"]').click(); change(form.querySelector('input[type="number"]'), '1');
  await wait(() => button('Preview change').disabled, 'invalid context bound');
  await publishAndRestore('context_limit_bytes', 'Context byte ceiling', 1048576);
  await publishAndRestore('memory.timeout_ms', 'Memory retrieval timeout (ms)', 1000);
  const details = document.querySelector('[data-settings-item="agent.context_limit_bytes"] details'); details.open = true;
  if (!details.textContent.includes('Source:')) throw new Error('Source details unavailable');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', verified, typedBounds: true, publicationsRestored: 3, sourceDetails: true };
}

await runInstalledUiAcceptance(agentSettingsScenario, 'NNA_INSTALLED_AGENT_SETTINGS_OK');
