// SPDX-License-Identifier: Apache-2.0
/** One-off census generator: classifies the NND setup-route family (status,
 * activate, and the not-ready request guard), retiring the last census item
 * left by the NNO scoping. Kept for provenance. */
import { readFile, writeFile } from 'node:fs/promises';

const rows = [
  {
    id: 'setup_action:status',
    kind: 'operator_action',
    family: 'setup_action',
    key: 'status',
    source: { product: 'NNA', path: 'src/nnd-setup-routes.js', validator: 'dispatchNndSetupRequest' },
    store: { owner: 'NNA', path_class: 'request payload (not persisted)' },
    apply: { class: 'engine_boundary', evidence: 'GET /v1/nnd/setup/status under nnd.setup.read returns the runtime setup snapshot (execution/service state).' },
    native_endpoint: 'GET /v1/nnd/setup/status',
    native_permission: 'nnd.setup.read',
    current_gui: {
      product: 'NND', path: 'packages/ui/src/components/settings/pages/native-setup.tsx', status: 'verified',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-23 setup family)',
    state: 'open',
    notes: 'Added 20261010-23: classifies the setup status read behind the page the desktop already renders.',
  },
  {
    id: 'setup_action:activate',
    kind: 'operator_action',
    family: 'setup_action',
    key: 'activate',
    source: { product: 'NNA', path: 'src/nnd-setup-routes.js', validator: 'dispatchNndSetupRequest' },
    store: { owner: 'NNA', path_class: 'request payload (not persisted)' },
    apply: { class: 'engine_boundary', evidence: 'POST /v1/nnd/setup/activate under nnd.setup.activate runs runtime.activate(); 503 unless service_state ready.' },
    native_endpoint: 'POST /v1/nnd/setup/activate',
    native_permission: 'nnd.setup.activate',
    current_gui: {
      product: 'NND', path: 'packages/ui/src/components/settings/pages/native-setup.tsx', status: 'verified',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-23 setup family)',
    state: 'open',
    notes: 'Added 20261010-23: classifies the activation action behind the page the desktop already renders.',
  },
  {
    id: 'setup_action:not_ready_guard',
    kind: 'internal_invariant',
    family: 'setup_action',
    key: 'not_ready_guard',
    source: { product: 'NNA', path: 'src/nnd-setup-routes.js', validator: 'guardNndSetupRequest' },
    store: { owner: 'NNA', path_class: 'request payload (not persisted)' },
    apply: { class: 'engine_boundary', evidence: 'While execution_state is not ready, every request fails nnd_setup_required except an allowlist: secret create/update/status/audit writes and provider-profile/provider-route configuration.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/nnd-setup-routes.js:guardNndSetupRequest',
      justification: 'The not-ready guard is an NNA-side request firewall with a deliberate narrow allowlist (credential and provider configuration only, never secret reads or probes); the desktop cannot and should not mirror a server-side firewall, and its surfaces (setup page, provider editor) are already classified, so the guard itself is an invariant, not a control.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-23 setup family)',
    state: 'open',
    notes: 'Added 20261010-23: classifies the pre-activation request guard; the allowlist deliberately permits only configuration writes.',
  },
];

const path = 'docs/build/EXECUTION/settings-coverage.json';
const census = JSON.parse(await readFile(path, 'utf8'));
const existing = new Set(census.rows.map((entry) => entry.id));
let added = 0;
for (const entry of rows) {
  if (existing.has(entry.id)) continue;
  census.rows.push(entry);
  added += 1;
}
const item = 'NND setup-route families not yet rowed.';
census.remaining_census = census.remaining_census.filter((entry) => entry !== item);
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows; remaining ${census.remaining_census.length}`);
