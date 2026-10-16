// SPDX-License-Identifier: Apache-2.0
/** Serialized Chromium-only UI acceptance; no native credential enters the renderer. */
async function waitFor(selector, predicate = () => true, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const item = document.querySelector(selector);
    if (item && predicate(item)) return item;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error(`UI control did not appear: ${selector}`);
}
function button(scope, label) {
  const item = [...scope.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label);
  if (!item || item.disabled) throw new Error(`UI action unavailable: ${label}`);
  return item;
}
function setValue(element, value) {
  const owner = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(owner, 'value').set.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function readConfiguration() {
  const response = await fetch('/api/v1/nnd/configuration');
  if (response.status !== 200) throw new Error(`Native read failed: ${response.status}`);
  return response.json();
}
async function openNativeSettings() {
  (await waitFor('[data-testid="settings-gear"]')).click();
  const nav = await waitFor('[data-testid="settings-window"] nav', node =>
    [...node.querySelectorAll('button')].some(item => item.textContent?.trim() === 'NNA configuration'));
  button(nav, 'NNA configuration').click();
  return waitFor('section[aria-label="Manage native configuration"]');
}
async function repairMissingSource(section, workspace, identity) {
  const editor = await waitFor('section[aria-label="Manage native configuration"] textarea');
  setValue(editor, JSON.stringify({ workspace_root: workspace,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' } }));
  const confirm = section.querySelector('input[type="checkbox"]');
  if (!confirm) throw new Error('Explicit repair confirmation missing');
  confirm.click();
  button(section, 'Repair selected source').click();
  await waitFor('section[aria-label="Manage native configuration"]', node =>
    node.textContent.includes('NNA operation receipt') && node.textContent.includes('saved'));
  const repaired = await readConfiguration();
  if (repaired.source_state !== 'present' || !/^[a-f0-9]{64}$/.test(repaired.source_revision)
    || repaired.installation_id !== identity.installation_id || repaired.data_id !== identity.data_id) {
    throw new Error('Repair did not publish selected source');
  }
  button(section, 'Refresh native configuration').click();
  return repaired;
}
async function saveEditorField(before) {
  const section = await waitFor('section[aria-label="Manage native configuration"]', node =>
    [...node.querySelectorAll('option')].some(item => item.value === 'memory.enabled'));
  const select = section.querySelector('select');
  if (!select) throw new Error('Native field selector missing');
  setValue(select, 'memory.enabled');
  const editor = await waitFor('section[aria-label="Manage native configuration"] input[type="checkbox"]');
  if (editor.checked) editor.click();
  await waitFor('section[aria-label="Manage native configuration"] input[type="checkbox"]', node => !node.checked);
  button(section, 'Preview change').click();
  await waitFor('section[aria-label="Manage native configuration"]', node =>
    [...node.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Save to NNA' && !item.disabled));
  button(section, 'Save to NNA').click();
  await waitFor('section[aria-label="Manage native configuration"]', node =>
    node.textContent.includes('NNA operation receipt') && node.textContent.includes('saved'));
  const id = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/.exec(section.textContent)?.[0];
  if (!id) throw new Error('Save receipt operation identity missing');
  const operation = await fetch(`/api/v1/nnd/configuration/operations/${id}`);
  const receipt = await operation.json();
  if (operation.status !== 200 || receipt.persistence !== 'saved' || receipt.operation_id !== id
    || receipt.before_revision !== before.source_revision
    || receipt.installation_id !== before.installation_id || receipt.data_id !== before.data_id
    || receipt.application !== 'not_applied') throw new Error('Saved native receipt invalid');
  return receipt;
}
async function confirmMutation(before, receipt) {
  const after = await readConfiguration();
  const field = after.fields.find(item => item.path === 'memory.enabled');
  if (after.source_revision !== receipt.persisted_revision || field?.explicit?.value !== false
    || after.installation_id !== before.installation_id || after.data_id !== before.data_id) {
    throw new Error('Saved field did not round trip');
  }
  const stale = await fetch('/api/v1/nnd/configuration/preview', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installation_id: before.installation_id,
      data_id: before.data_id, scope: 'user', expected_revision: before.source_revision,
      expected_resolution_revision: before.resolution_revision, operations: [{ op: 'set', field: 'memory.enabled', value: true }] }) });
  const rejection = await stale.json();
  if (stale.status !== 409 || rejection.error?.code !== 'manifest_revision_conflict') throw new Error('Stale source CAS was not rejected');
  return { source_revision: after.source_revision, operation_id: receipt.operation_id };
}
async function saveTuiBinding() {
  const nav = await waitFor('[data-testid="settings-window"] nav');
  button(nav, 'NNA terminal preferences').click();
  const section = await waitFor('section[aria-label="NNA terminal preferences"]', node =>
    [...node.querySelectorAll('option')].some(item => item.value === 'tui.key_bindings.submit'));
  const before = await readConfiguration();
  setValue(section.querySelector('select'), 'tui.key_bindings.submit');
  const binding = await waitFor('section[aria-label="NNA terminal preferences"] input[type="text"]');
  setValue(binding, 'ctrl+x');
  button(section, 'Preview change').click();
  await waitFor('section[aria-label="NNA terminal preferences"]', node =>
    [...node.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Save to NNA' && !item.disabled));
  button(section, 'Save to NNA').click();
  await waitFor('section[aria-label="NNA terminal preferences"]', node =>
    node.textContent.includes('NNA operation receipt') && node.textContent.includes('saved'));
  const id = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/.exec(section.textContent)?.[0];
  if (!id) throw new Error('Terminal save receipt operation identity missing');
  const operation = await fetch(`/api/v1/nnd/configuration/operations/${id}`), receipt = await operation.json();
  const after = await readConfiguration();
  const field = after.fields.find(item => item.path === 'tui.key_bindings.submit');
  if (operation.status !== 200 || receipt.persistence !== 'saved' || receipt.operation_id !== id
    || receipt.before_revision !== before.source_revision || receipt.persisted_revision !== after.source_revision
    || receipt.application !== 'not_applied' || field?.explicit?.value !== 'ctrl+x') {
    throw new Error('Terminal binding did not persist with a matching native receipt');
  }
  const stale = await fetch('/api/v1/nnd/configuration/preview', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installation_id: before.installation_id,
      data_id: before.data_id, scope: 'user', expected_revision: before.source_revision,
      expected_resolution_revision: before.resolution_revision,
      operations: [{ op: 'set', field: 'tui.key_bindings.submit', value: 'ctrl+q' }] }) });
  const rejection = await stale.json();
  if (stale.status !== 409 || rejection.error?.code !== 'manifest_revision_conflict') {
    throw new Error('Stale terminal binding CAS was not rejected');
  }
  return { source_revision: after.source_revision, operation_id: id };
}
async function saveReviewerTemperature() {
  const nav = await waitFor('[data-testid="settings-window"] nav');
  button(nav, 'Routes and model tuning').click();
  const section = await waitFor('section[aria-label="Routes and model tuning"]', node =>
    [...node.querySelectorAll('option')].some(item => item.value === 'routes.reviewer.temperature'));
  const options = [...section.querySelectorAll('option')].map(item => item.value);
  if (options.includes('routes.reviewer.provider_id') || options.includes('routes.vision.model')) {
    throw new Error('Provider/model assignment was exposed as a generic route edit');
  }
  const before = await readConfiguration();
  setValue(section.querySelector('select'), 'routes.reviewer.temperature');
  const editor = await waitFor('section[aria-label="Routes and model tuning"] textarea');
  setValue(editor, '0.35');
  button(section, 'Preview change').click();
  await waitFor('section[aria-label="Routes and model tuning"]', node =>
    [...node.querySelectorAll('button')].some(item => item.textContent?.trim() === 'Save to NNA' && !item.disabled));
  button(section, 'Save to NNA').click();
  await waitFor('section[aria-label="Routes and model tuning"]', node =>
    node.textContent.includes('NNA operation receipt') && node.textContent.includes('saved')
      && node.textContent.includes('not applied'));
  const id = /[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/.exec(section.textContent)?.[0];
  if (!id) throw new Error('Reviewer save receipt identity missing');
  const operation = await fetch(`/api/v1/nnd/configuration/operations/${id}`), receipt = await operation.json();
  const after = await readConfiguration();
  const field = after.fields.find(item => item.path === 'routes.reviewer.temperature');
  if (operation.status !== 200 || receipt.persistence !== 'saved' || receipt.operation_id !== id
    || receipt.before_revision !== before.source_revision || receipt.persisted_revision !== after.source_revision
    || receipt.application !== 'not_applied' || field?.explicit?.value !== 0.35) {
    throw new Error('Reviewer tuning did not persist with matching native receipt');
  }
  const stale = await fetch('/api/v1/nnd/configuration/preview', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installation_id: before.installation_id,
      data_id: before.data_id, scope: 'user', expected_revision: before.source_revision,
      expected_resolution_revision: before.resolution_revision,
      operations: [{ op: 'set', field: 'routes.reviewer.temperature', value: 0.45 }] }) });
  const rejection = await stale.json();
  if (stale.status !== 409 || rejection.error?.code !== 'manifest_revision_conflict') {
    throw new Error('Stale reviewer route CAS was not rejected');
  }
  return { source_revision: after.source_revision, operation_id: id };
}
async function run(workspace, installationId, dataId, tuiWrite, routeWrite) {
  const initial = await readConfiguration();
  if (initial.source_state !== 'missing' || initial.installation_id !== installationId || initial.data_id !== dataId) {
    throw new Error('Initial disposable native source mismatch');
  }
  const section = await openNativeSettings();
  const before = await repairMissingSource(section, workspace, initial);
  const receipt = await saveEditorField(before);
  const mutation = await confirmMutation(before, receipt);
  return { ...mutation, ...(tuiWrite ? { tui: await saveTuiBinding() } : {}),
    ...(routeWrite ? { route: await saveReviewerTemperature() } : {}) };
}
export function nativeConfigurationWriteExpression(workspace, installationId, dataId, tuiWrite = false, routeWrite = false) {
  return `(()=>{const waitFor=${waitFor.toString()},button=${button.toString()},setValue=${setValue.toString()},`
    + `readConfiguration=${readConfiguration.toString()},openNativeSettings=${openNativeSettings.toString()},`
    + `repairMissingSource=${repairMissingSource.toString()},saveEditorField=${saveEditorField.toString()},`
    + `confirmMutation=${confirmMutation.toString()},saveTuiBinding=${saveTuiBinding.toString()},`
    + `saveReviewerTemperature=${saveReviewerTemperature.toString()},run=${run.toString()};`
    + `return run(${JSON.stringify(workspace)},${JSON.stringify(installationId)},${JSON.stringify(dataId)},`
    + `${JSON.stringify(tuiWrite)},${JSON.stringify(routeWrite)});})()`;
}
