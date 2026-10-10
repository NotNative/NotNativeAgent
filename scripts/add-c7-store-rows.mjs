// SPDX-License-Identifier: Apache-2.0
/** One-off census generator for the C1 non-manifest store rule: adds a row
 * for every USER_DATA_FILE_KEYS key that had no census row with a matching
 * store.path_class. Kept for provenance; census edits only ever happen via
 * scripts (JSON.stringify(census, null, 1) + '\n'). */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const rows = [
  {
    id: 'generated-store:provider/model-dialects.json',
    kind: 'internal_invariant',
    family: 'generated-store',
    key: 'modelDialects',
    source: { product: 'NNA', path: 'src/reliability/model-dialects.js', validator: 'ModelDialectRegistry' },
    store: { owner: 'NNA', path_class: 'provider/model-dialects.json' },
    apply: { class: 'unverified', evidence: 'Generated engine state: dialect resolution adapts to observed model behavior and is not an operator-editable configuration value.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/product.js:USER_DATA_FILE_KEYS',
      justification: 'The provider model-dialect registry is machine-internal generated state; NNA surfaces dialect observations through its model data and instructions, and the desktop renders those observations without reading or writing this file directly.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-18 non-manifest stores)',
    state: 'open',
    notes: 'Added by the C7 gate extension: every USER_DATA_FILE_KEYS key requires a census row classified with its store path.',
  },
  {
    id: 'generated-store:runtime/dream-state.db',
    kind: 'internal_invariant',
    family: 'generated-store',
    key: 'dreamState',
    source: { product: 'NNA', path: 'src/dream-store.js', validator: 'DreamStore' },
    store: { owner: 'NNA', path_class: 'runtime/dream-state.db' },
    apply: { class: 'unverified', evidence: 'Generated engine state: dream runs, packets, watermarks, and candidates are engine bookkeeping, not operator configuration.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/product.js:USER_DATA_FILE_KEYS',
      justification: 'The DreamStore SQLite runtime state is engine-internal bookkeeping with no nnd route projection; no desktop dream surface exists, so no desktop control for this store is owed.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-18 non-manifest stores)',
    state: 'open',
    notes: 'Added by the C7 gate extension: every USER_DATA_FILE_KEYS key requires a census row classified with its store path.',
  },
  {
    id: 'generated-store:runtime/nnm-turn-receipts.jsonl',
    kind: 'internal_invariant',
    family: 'generated-store',
    key: 'nnmGovernanceReceipts',
    source: { product: 'NNA', path: 'src/nnm-governance-receipts.js', validator: 'NnmGovernanceReceipts' },
    store: { owner: 'NNA', path_class: 'runtime/nnm-turn-receipts.jsonl' },
    apply: { class: 'unverified', evidence: 'Generated engine state: per-turn governance receipts are DreamCoordinator bookkeeping, not operator configuration.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/product.js:USER_DATA_FILE_KEYS',
      justification: 'Per-turn governance receipts are internal DreamCoordinator bookkeeping; no nnd route projects them and no desktop control is owed for this append-only journal.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-18 non-manifest stores)',
    state: 'open',
    notes: 'Added by the C7 gate extension: every USER_DATA_FILE_KEYS key requires a census row classified with its store path.',
  },
  {
    id: 'generated-store:secrets/master-key.json',
    kind: 'internal_invariant',
    family: 'generated-store',
    key: 'secretKey',
    source: { product: 'NNA', path: 'src/secret-vault.js', validator: 'decodeMasterKey' },
    store: { owner: 'NNA', path_class: 'secrets/master-key.json' },
    apply: { class: 'unverified', evidence: 'Fail-closed internal secret material; NNA refuses to surface or regenerate the key through any route.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/product.js:USER_DATA_FILE_KEYS',
      justification: 'The master key file is fail-closed internal secret material; the desktop broker consumes the vault through the nnd secret routes and must never read, cache, or display key bytes.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-18 non-manifest stores)',
    state: 'open',
    notes: 'Added by the C7 gate extension: every USER_DATA_FILE_KEYS key requires a census row classified with its store path.',
  },
  {
    id: 'generated-store:secrets/audit.ndjson',
    kind: 'internal_invariant',
    family: 'generated-store',
    key: 'secretAudit',
    source: { product: 'NNA', path: 'src/secret-broker.js', validator: 'auditEvents' },
    store: { owner: 'NNA', path_class: 'secrets/audit.ndjson' },
    apply: { class: 'unverified', evidence: 'Generated compliance journal: NNA appends vault operations; the entries are not operator configuration.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/product.js:USER_DATA_FILE_KEYS',
      justification: 'The secret audit journal is internal compliance bookkeeping; the desktop exposes vault operations through the nnd secret routes and no separate desktop audit surface is owed.',
    },
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-18 non-manifest stores)',
    state: 'open',
    notes: 'Added by the C7 gate extension: every USER_DATA_FILE_KEYS key requires a census row classified with its store path.',
  },
];

const path = process.argv[2] ?? 'docs/build/EXECUTION/settings-coverage.json';
const census = JSON.parse(await readFile(path, 'utf8'));
const existing = new Set(census.rows.map((row) => row.id));
let added = 0;
for (const row of rows) {
  if (existing.has(row.id)) continue;
  census.rows.push(row);
  added += 1;
}
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows`);
