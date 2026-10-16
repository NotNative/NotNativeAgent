// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function secretsScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000; while (Date.now() < deadline) {
    const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 50)); } throw new Error(`Secrets acceptance timed out: ${label}: ${[...document.querySelectorAll('[role="tabpanel"] [role="alert"]')].map(node => node.textContent).join('; ')}`); };
  const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text || node.getAttribute('aria-label') === text);
  const click = async text => (await wait(() => button(text) && !button(text).matches(':disabled') && button(text), text)).click();
  const input = (label, value) => { const node = document.querySelector(`[aria-label="${label}"]`), prototype = node.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value); node.dispatchEvent(new Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); };
  const read = async () => { const response = await fetch('/api/v1/secrets'); if (!response.ok) throw new Error('Secret read failed'); return (await response.json()).secrets; };
  const before = (await read()).map(row => row.id).sort(), label = `NNA disposable acceptance ${Date.now()}`; let created;
  const row = () => [...document.querySelectorAll('[data-testid="secret-row"]')].find(node => node.querySelector('h3')?.textContent === label || node.querySelector('h3')?.textContent === label + ' renamed');
  const action = async text => { const target = await wait(() => { const selected = row(); const found = [...(selected?.querySelectorAll('button') ?? [])].find(node => node.textContent === text);
    return found && !found.matches(':disabled') && found; }, text); target.click(); };
  const saved = async message => wait(() => document.querySelector('[data-testid="secret-receipt"]')?.textContent.includes(message) && !document.querySelector('[data-testid="secret-editor"]'), message);
  try {
    (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click(); await click('Trust and secrets'); await click('Secrets');
    await click('New secret'); input('Secret kind', 'username_password'); input('Secret label', label);
    await wait(() => document.querySelector('[aria-label="Secret value username"]'), 'two values'); input('Secret value username', 'nna-disposable-test'); input('Secret value password', 'not-a-real-password');
    await click('Create secret'); await saved('Created'); created = (await read()).find(secret => secret.label === label);
    if (!created || created.fields.join(',') !== 'password,username') throw new Error('Username/password creation failed');
    await action('Edit details'); input('Secret label', label + ' renamed'); const scopeOption = [...document.querySelector('[aria-label="Secret scope"]').options].find(option => option.value.startsWith('workspace:'));
    if (!scopeOption) throw new Error('Native workspace scope missing'); input('Secret scope', scopeOption.value);
    const metadata = [...document.querySelectorAll('[data-testid="secret-editor"] label')].find(node => node.textContent.includes('Replace metadata')).querySelector('input'); metadata.click();
    await wait(() => document.querySelector('[aria-label="Metadata name"]'), 'metadata'); input('Metadata name', 'purpose'); input('Metadata value', 'disposable-verification'); await click('Save changes'); await saved('Updated');
    const updated = (await read()).find(secret => secret.id === created.id); if (updated.scope?.kind !== 'workspace' || updated.metadata.purpose !== 'disposable-verification') throw new Error('Edit not persisted');
    await action('Rotate values'); input('Secret value username', 'nna-disposable-rotated'); input('Secret value password', 'not-a-real-rotated-password'); await click('Rotate secret'); await saved('Rotated');
    if (document.querySelector('input[type="password"]')) throw new Error('Write-only values retained');
    await action('Disable'); await click('Cancel operation'); if (!(await read()).find(secret => secret.id === created.id).enabled) throw new Error('Cancel changed enabled state');
    await action('Disable'); await click('Confirm disable'); await saved('Disabled'); await wait(() => row()?.textContent.includes('Disabled'), 'disabled roster');
    if (document.querySelector('[role="tabpanel"] [role="alert"]')) throw new Error('Disable audit refresh failed');
    await action('Enable'); await click('Confirm enable'); await saved('Enabled'); await action('Delete'); await click('Confirm delete'); await saved('Deleted');
    await wait(() => !row(), 'deleted roster');
    if (JSON.stringify((await read()).map(secret => secret.id).sort()) !== JSON.stringify(before)) throw new Error('Operator vault changed'); created = null;
    return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', createdUsernamePassword: true, scopeMetadataEdit: true, rotated: true, disableEnable: true, cancelNoWrite: true, deletedDisposableOnly: true, existingSecretsPreserved: true };
  } finally {
    const pending = created ?? (await read()).find(secret => secret.label === label || secret.label === label + ' renamed');
    if (pending && !before.includes(pending.id)) { const response = await fetch('/api/v1/secrets/' + pending.id, { method: 'DELETE' }); if (!response.ok) throw new Error('Disposable secret cleanup failed'); }
  }
}
await runInstalledUiAcceptance(secretsScenario, 'NNA_INSTALLED_SECRETS_OK');
