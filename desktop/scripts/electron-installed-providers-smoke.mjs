// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function providerScenario() {
  async function wait(read, label) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Provider acceptance timed out: ${label}`);
  }
  const button = (scope, text) => [...(scope?.querySelectorAll('button') ?? [])].find(row => row.textContent.trim() === text);
  const read = async path => { const response = await fetch(path); if (!response.ok) throw new Error(`Read failed: ${response.status}`); return response.json(); };
  const input = (node, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); };
  const before = await read('/api/ui-preferences');
  const originalProfile = (await read('/api/v1/provider-profiles')).profiles[0];
  const verificationName = `${originalProfile.display_name || originalProfile.profile_id} [UI verification]`;
  async function editName(value) {
    document.querySelector('[data-testid="provider-profile"] [data-testid="provider-profile-toggle"]').click();
    const form = await wait(() => document.querySelector('dialog[open]'), 'profile editor');
    input(form.querySelector('[data-testid="provider-profile-name"]'), value); form.querySelector('[data-testid="provider-profile-save"]').click();
    await wait(() => !document.querySelector('dialog[open]'), 'profile save');
    await wait(async () => (await read('/api/v1/provider-profiles')).profiles.find(row => row.profile_id === originalProfile.profile_id)?.display_name === value, 'profile confirmation');
  }
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  (await wait(() => button(document.querySelector('[aria-label="Settings pages"]'), 'Providers and models'), 'Providers')).click();
  const card = await wait(() => document.querySelector('[data-testid="provider-profile"]'), 'connection card');
  card.querySelector('[data-testid="provider-profile-toggle"]').click();
  const editor = await wait(() => document.querySelector('dialog[open]'), 'native editor');
  if (!editor.querySelector('[data-testid="provider-profile-credential-source"]')) throw new Error('Credential binding control missing');
  editor.querySelector('[aria-label="Close provider editor"]').click();
  await wait(() => !document.querySelector('dialog[open]'), 'editor close');
  try { await editName(verificationName); }
  finally {
    const profile = (await read('/api/v1/provider-profiles')).profiles.find(row => row.profile_id === originalProfile.profile_id);
    if (profile.display_name === verificationName) await editName(originalProfile.display_name || originalProfile.profile_id);
    else if (profile.display_name !== originalProfile.display_name) throw new Error('Concurrent provider edit prevents restoration');
  }
  const currentCard = document.querySelector('[data-testid="provider-profile"]'); currentCard.querySelector('[data-testid="provider-test"]').click();
  await wait(() => !currentCard.querySelector('[data-testid="provider-test"]').disabled && (currentCard.querySelector('[role="status"]') || currentCard.querySelector('[role="alert"]')), 'connection test result');
  document.querySelector('[role="tablist"]').querySelectorAll('button')[1].click();
  const group = await wait(() => document.querySelector('[aria-label^="Models from "]'), 'Models');
  group.querySelector('[data-testid="provider-discover"]').click();
  await wait(() => group.querySelector('[data-testid="provider-models"]') || group.querySelector('[role="alert"]'), 'discovery result');
  const favorite = group.querySelector('input[aria-label^="Favorite "]');
  const oldFavorite = favorite.checked;
  try {
    favorite.click();
    await wait(async () => { const row = await read('/api/ui-preferences'); return row.revision > before.revision && JSON.stringify(row.settings.favoriteModels) !== JSON.stringify(before.settings.favoriteModels); }, 'favorite persistence');
    if (favorite.checked === oldFavorite) throw new Error('Favorite did not change');
  } finally {
    if (favorite.checked !== oldFavorite) favorite.click();
    await wait(async () => JSON.stringify((await read('/api/ui-preferences')).settings.favoriteModels) === JSON.stringify(before.settings.favoriteModels), 'favorite restore');
  }
  const search = document.querySelector('[aria-label="Search configured models"]'); input(search, 'nna-no-such-model-acceptance');
  await wait(() => !document.querySelector('input[aria-label^="Favorite "]'), 'model filtering'); input(search, '');
  await wait(() => document.querySelector('input[aria-label^="Favorite "]'), 'filter reset');
  document.querySelector('[role="tablist"]').querySelectorAll('button')[2].click();
  await wait(() => document.querySelector('[data-testid="route-binding-primary"]'), 'native role routing');
  document.querySelector('[role="tablist"]').querySelectorAll('button')[1].click();
  await wait(() => document.querySelector('[aria-label="Search configured models"]'), 'Models reopen');
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', providerCards: true, editor: true, diagnostics: true, favoritesRestored: true, search: true, routing: true };
}

await runInstalledUiAcceptance(providerScenario, 'NNA_INSTALLED_PROVIDERS_OK');
