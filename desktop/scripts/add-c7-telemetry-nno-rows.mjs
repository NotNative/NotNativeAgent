// SPDX-License-Identifier: Apache-2.0
/** One-off census generator: closes the telemetry/nested item (bounds and
 * apply-consumer invariants, MCP-effects disposition) and narrows the NNO
 * item per the 20261010-22 scoping. Kept for provenance. */
import { readFile, writeFile } from 'node:fs/promises';

function row(overrides) {
  return {
    kind: 'internal_invariant',
    family: 'telemetry_invariant',
    apply: { class: 'unverified', evidence: 'NNA-enforced validation or derived disposition; not operator-editable configuration.' },
    store: { owner: 'NNA', path_class: 'manifest.json' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-22 telemetry/NNO census)',
    state: 'open',
    ...overrides,
  };
}

const rows = [
  row({
    id: 'manifest_telemetry:telemetry.destination.bounds',
    key: 'telemetry.destination.bounds',
    source: { product: 'NNA', path: 'src/config-bounds.js', validator: 'telemetryDestination' },
    apply: { class: 'unverified', evidence: 'Destination grammar: credential-free http(s) URL, length bound; enforced at manifest resolution.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/config-bounds.js:telemetryDestination',
      justification: 'The destination grammar (credential-free http(s) URL with a length bound, enforced inside NNA manifest resolution) is engine-internal validation; the telemetry editor renders the applied value and forwards NNA rejections, so duplicating the grammar as a desktop control would add no coverage.',
    },
    notes: 'Added 20261010-22: bounds companion to the manifest_telemetry:telemetry.destination projection row.',
  }),
  row({
    id: 'manifest_telemetry:telemetry.enabled.apply',
    key: 'telemetry.enabled.apply',
    source: { product: 'NNA', path: 'src/config.js', validator: 'validateTelemetry' },
    apply: { class: 'unverified', evidence: 'Apply consumer: enabled telemetry requires an explicit destination; disabling nulls destination and retention.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/config.js:validateTelemetry',
      justification: 'The enable/disable coupling lives in NNA validateTelemetry: an enabled telemetry block requires an explicit destination (telemetry_destination_required) and a disabled block nulls destination and retention; the desktop telemetry page renders the resolved shape, so the coupling is classified as an invariant rather than re-implemented client-side.',
    },
    notes: 'Added 20261010-22: apply-consumer companion to manifest_telemetry:telemetry.enabled.',
  }),
  row({
    id: 'manifest_telemetry:mcp_effects',
    key: 'mcp_effects',
    source: { product: 'NNA', path: 'src/tools/loop.js', validator: 'engine.telemetry.record' },
    apply: { class: 'unverified', evidence: 'Disposition: MCP tool calls emit telemetry events through engine.telemetry.record (tools/loop.js) but no mechanism makes MCP servers consume or alter telemetry configuration (no telemetry reference in src/mcp*.js or nnd-mcp*.js).' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/tools/loop.js:engine.telemetry.record',
      justification: 'The census item asked whether telemetry settings have MCP effects; verification found MCP is a telemetry observer (tool calls emit engine.telemetry.record events) with no config-level coupling in either direction, so the honest disposition is that no surface or projection is owed for an effect that does not exist.',
    },
    notes: 'Added 20261010-22: closes the MCP-effects question as an observational adjacency, not a config effect.',
  }),
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
const telemetryItem = 'Nested telemetry retention, route budgets/fallbacks, MCP effects; per-field bounds/default/null/reset/apply consumers.';
const nnoItem = 'NNO activation, full installation/startup/discovery schemas and evolving L2 contracts.';
const setupItem = 'NND setup-route families not yet rowed.';
census.remaining_census = census.remaining_census
  .filter((entry) => entry !== telemetryItem && entry !== nnoItem)
  .map((entry) => entry === 'Dynamic credentials and TUI command vocabulary (repository environment reads and CLI positional subcommands are enforced by the gate).'
    ? entry : entry);
if (!census.remaining_census.includes(setupItem)) census.remaining_census.push(setupItem);
// Honest retention disposition (20261010-22 scoping): telemetry.retention is
// validated but has no found runtime consumer — the forensic store's
// retention is install-option driven (engine/telemetry.js options,
// forensic-telemetry.js maxAgeMs), matching the catalog's own
// else_ignored acceptance wording.
const retention = census.rows.find((entry) => entry.id === 'manifest_telemetry:telemetry.retention');
if (retention) {
  retention.apply = {
    class: 'unverified',
    evidence: 'Validated when enabled (optional non-empty string) but no runtime consumer found in NNA: the forensic telemetry store derives retention from install-option maxAgeMs (src/engine/telemetry.js:6-12, src/forensic-telemetry.js:39,166-168); the catalog acceptance itself says else_ignored.',
  };
  retention.notes = `${String(retention.notes ?? '')} [20261010-22: apply evidence updated to the honest no-consumer finding.]`;
}
census.known_mismatches.push({
  product: 'NNA',
  path: 'src/nno-integration-activation.js',
  issue: 'NNO activation is an NNA-internal, NNO-owned contract (protocol 1.0, fully specified); NND owes no settings surface for it. Census tracks only landed contracts; NNA NND-integration ADRs 0023-0054 are still landing and remain a standing dependency note, not a work item.',
  work_package: 'C7',
});
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows; remaining ${census.remaining_census.length}: ${census.remaining_census.join(' | ')}`);
