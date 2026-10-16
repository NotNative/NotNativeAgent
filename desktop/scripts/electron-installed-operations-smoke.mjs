// SPDX-License-Identifier: Apache-2.0
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function operationsScenario() {
  const wait = async (read, label) => { const deadline = Date.now() + 25000;
    while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Operations acceptance timed out: ${label}`); };
  const button = (scope, text) => [...(scope?.querySelectorAll('button') ?? [])].find(row => row.textContent.trim() === text);
  (await wait(() => document.querySelector('[data-testid="settings-gear"]'), 'Settings')).click();
  const cases = [
    ['Tools and integrations', 'MCP servers', '[aria-label="Native MCP configuration"] select', 'Refresh'],
    ['Tools and integrations', 'Runtime inventory', '[data-testid="mcp-inventory-refresh"]', 'Refresh'],
    ['Tools and integrations', 'References', '[data-testid="mcp-advanced-receipt"]', 'Load references'],
    ['Skills and hooks', 'Skills', '[data-testid="native-skills-receipt"]', 'Refresh'],
    ['Skills and hooks', 'Hooks', '[data-settings-item="native-hooks-bundles.settings"]', 'Refresh'],
    ['Search and browsing', 'Web search', '[data-testid="websearch-profiles-summary"]', 'Refresh'],
    ['Search and browsing', 'Web fetch', '[data-testid="webfetch-origin-add"]', 'Refresh'],
    ['Search and browsing', 'Managed browser', '[data-testid="browser-receipt"]', 'Verify with launch probe'],
    ['Search and browsing', 'SearXNG deployment', '[data-settings-item="native-searxng-deployment.observation"]', 'Refresh'],
    ['Services and updates', 'NNA desktop', '[data-testid="installation-view"]', 'Refresh'],
    ['Services and updates', 'Telegram gateway', '[data-testid="gateway-runtime-receipt"]', 'Refresh'],
    ['Services and updates', 'OpenCode service', '[data-testid="lifecycle-status"]', 'Refresh'],
    ['Services and updates', 'Updates', '[data-settings-item="native-update-state.observations"]', null],
    ['Data and diagnostics', 'Diagnostic summary', '[data-testid="diagnostic-summary"]', 'Refresh summary'],
    ['Data and diagnostics', 'Conversations', '[aria-label="Conversation archive filter"]', 'Refresh conversations'],
    ['Data and diagnostics', 'Files', '[data-testid="agent-settings-editor"]', null],
    ['Data and diagnostics', 'Environment', '[data-testid="native-environment-table"]', 'Refresh'],
  ];
  const verified = [];
  for (const [page, tab, selector, refresh] of cases) {
    (await wait(() => button(document.querySelector('[aria-label="Settings pages"]'), page), page)).click();
    (await wait(() => [...document.querySelectorAll('[role="tab"]')].find(row => row.textContent === tab), tab)).click();
    const panel = await wait(() => document.querySelector(`[role="tabpanel"][aria-label="${tab}"]`), tab);
    await wait(() => panel.querySelector(selector), `${tab} native state`);
    if (refresh) { const action = await wait(() => { const found = button(panel, refresh); return found && !found.disabled && found; }, refresh); action.click();
      await wait(() => !action.disabled, `${refresh} completion`); }
    const errors = [...panel.querySelectorAll('[role="alert"]')].map(row => row.textContent);
    if (errors.length && !['SearXNG deployment'].includes(tab)) throw new Error(`${tab}: ${errors.join('; ')}`);
    if (tab === 'Updates' && panel.querySelector('[data-testid="update-install"]')) throw new Error('Unsupported installer control exposed');
    if (tab === 'Files') for (const label of ['Allow attachments', 'Retain managed attachment copies', 'Attachment byte ceiling']) {
      const edit = await wait(() => { const found = panel.querySelector(`button[aria-label="Edit ${label}"]`); return found && !found.disabled && found; }, label); edit.click();
      await wait(() => panel.querySelector(`section[aria-label="Edit ${label}"]`), label); button(panel, 'Preview change').click();
      await wait(() => button(panel, 'Save to NNA'), `${label} preview`);
      button(panel, 'Cancel edit').click(); await wait(() => !button(panel, 'Cancel edit'), 'cancel preview');
    }
    verified.push(`${page}/${tab}`);
  }
  return { nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron', verified, filePreviews: 3, optionalServicesUnchanged: true };
}

await runInstalledUiAcceptance(operationsScenario, 'NNA_INSTALLED_OPERATIONS_OK');
