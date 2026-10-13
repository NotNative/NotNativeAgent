// SPDX-License-Identifier: Apache-2.0
/** One-off census generator: closes the final remaining item — dynamic
 * credential sources (env/secret bindings resolved at request time) and the
 * TUI command vocabulary (terminal-owned surface). Kept for provenance. */
import { readFile, writeFile } from 'node:fs/promises';

const rows = [
  {
    id: 'credentials:dynamic_sources',
    kind: 'internal_invariant',
    family: 'credentials',
    key: 'dynamic_sources',
    source: { product: 'NNA', path: 'src/credential-bindings.js', validator: 'normalizeCredentialBinding' },
    store: { owner: 'NNA', path_class: 'config/opencode.json' },
    apply: { class: 'unverified', evidence: 'Credential bindings resolve dynamically at request time from two sources: environment names (grammar-checked) and secret references (sec_ id + field); consumed transiently via CredentialResolver.withCredential with redaction.' },
    native_endpoint: 'Consumed server-side by NNA at request time; the desktop never resolves credential values.',
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/credential-bindings.js:normalizeCredentialBinding',
      justification: 'Dynamic credential resolution (environment-name and secret-reference bindings validated by normalizeCredentialBinding and handed transiently to trusted consumers with redaction) is an NNA runtime mechanism; the desktop already mirrors the binding grammar in its provider/MCP editors and never resolves or displays credential values, so no additional surface is owed.',
    },
    work_package: 'C4',
    implementation_package: 'C4 (20261010-24 final census item)',
    state: 'open',
    notes: 'Added 20261010-24: closes the dynamic-credentials half of the last census item; the binding grammar rows already exist under the provider/MCP credential families.',
  },
  {
    id: 'tui_commands:vocabulary',
    kind: 'internal_invariant',
    family: 'tui_commands',
    key: 'vocabulary',
    source: { product: 'NNA', path: 'src/tui/commands.js', validator: 'TUI_COMMANDS' },
    store: { owner: 'NNA', path_class: 'request payload (not persisted)' },
    apply: { class: 'unverified', evidence: 'The frozen TUI_COMMANDS array (with aliases, categories, and availability bindings) is the terminal command palette; it lives entirely inside the NNA TUI.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/tui/commands.js:TUI_COMMANDS',
      justification: 'The TUI command palette is the in-terminal operator surface of the NNA terminal UI; the desktop embeds the engine without hosting a TUI and already surfaces the equivalent desktop-native actions (sessions, goals, review, steering) through its own controls, so the vocabulary is classified as terminal-owned rather than owed a mirrored control.',
    },
    work_package: 'C7',
    implementation_package: 'C7 (20261010-24 final census item)',
    state: 'open',
    notes: 'Added 20261010-24: closes the TUI-command half of the last census item as a terminal-owned surface.',
  },
];

const path = 'docs/planning/EXECUTION/settings-coverage.json';
const census = JSON.parse(await readFile(path, 'utf8'));
const existing = new Set(census.rows.map((entry) => entry.id));
let added = 0;
for (const entry of rows) {
  if (existing.has(entry.id)) continue;
  census.rows.push(entry);
  added += 1;
}
const item = 'Dynamic credentials and TUI command vocabulary (repository environment reads and CLI positional subcommands are enforced by the gate).';
census.remaining_census = census.remaining_census.filter((entry) => entry !== item);
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows; remaining ${census.remaining_census.length}`);
