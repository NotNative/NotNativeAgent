// SPDX-License-Identifier: Apache-2.0
/** One-off census generator for the secret create/update/scope schema
 * classification (census remaining item 2): validation grammars, the
 * use-request envelope, the derived reference projection, and the delete
 * guard. Kept for provenance. */
import { readFile, writeFile } from 'node:fs/promises';

function row(overrides) {
  return {
    kind: 'internal_invariant',
    family: 'secrets',
    apply: { class: 'unverified', evidence: 'NNA-enforced validation or derived read; values are not operator-editable configuration.' },
    store: { owner: 'NNA', path_class: 'secrets/vault.json' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
    },
    work_package: 'C5',
    implementation_package: 'C5 (20261010-20 secret schema)',
    state: 'open',
    ...overrides,
  };
}

const rows = [
  row({
    id: 'secrets:validation.fields',
    key: 'validation.fields',
    source: { product: 'NNA', path: 'src/secret-contracts.js', validator: 'validateSecretFields' },
    apply: { class: 'unverified', evidence: 'Create/rotate grammar: 1-16 fields, name pattern, value bounds, username_password requirement, rotate-against-kind.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-contracts.js:validateSecretFields',
      justification: 'The field grammar is enforced entirely inside NNA (1-16 entries, name pattern, 20k non-NUL values, username_password completeness, rotate revalidates against the existing kind); the desktop forwards secret payloads verbatim and renders the forwarded errors, so a duplicated editor would not add coverage.',
    },
    notes: 'Added 20261010-20: classifies the create/rotate field grammar behind the already-rowed secrets:fields.{field} projection.',
  }),
  row({
    id: 'secrets:validation.metadata',
    key: 'validation.metadata',
    source: { product: 'NNA', path: 'src/secret-contracts.js', validator: 'normalizeSecretMetadata' },
    apply: { class: 'unverified', evidence: 'Metadata bounds: at most 32 entries with the shared name grammar and normalized value shapes.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-contracts.js:normalizeSecretMetadata',
      justification: 'Metadata normalization (32-entry cap, shared name grammar, sorted deduplicated values) is an NNA-internal invariant; the desktop metadata editor renders what NNA returned and never re-implements the bounds, so the classification is documentation, not a missing control.',
    },
    notes: 'Added 20261010-20: classifies the metadata grammar behind secrets:metadata.{name}.',
  }),
  row({
    id: 'secrets:validation.scope_grammar',
    key: 'validation.scope_grammar',
    source: { product: 'NNA', path: 'src/secret-contracts.js', validator: 'normalizeSecretScope' },
    apply: { class: 'unverified', evidence: 'Scope grammar: five kinds, id bound, null scope only in the local realm; principal scope must cover the requested scope on write.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-contracts.js:normalizeSecretScope',
      justification: 'The scope grammar (deployment/workspace/group/role/user, id bound, local-realm-only null) plus the principal-coverage requirement on writes live in NNA; the secrets:* projection row already shows the applied scope, so the grammar itself needs a classification row, not a second control.',
    },
    notes: 'Added 20261010-20: distinct from secrets:scope, which rows only the read projection.',
  }),
  row({
    id: 'secrets:validation.label_grammar',
    key: 'validation.label_grammar',
    source: { product: 'NNA', path: 'src/secret-contracts.js', validator: 'normalizeSecretLabel' },
    apply: { class: 'unverified', evidence: 'Label bounds (1-96 visible chars, no control characters) and case-folded per-realm uniqueness.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-contracts.js:normalizeSecretLabel',
      justification: 'Label bounds and case-folded per-realm uniqueness are enforced by NNA at create and rename; the desktop editor surfaces the forwarded rejection, so the grammar is recorded as an invariant rather than duplicated as a desktop validation.',
    },
    notes: 'Added 20261010-20: grammar companion to the secrets:label projection row.',
  }),
  row({
    id: 'secrets:validation.use_request',
    key: 'validation.use_request',
    source: { product: 'NNA', path: 'src/secret-broker.js', validator: 'requireUseRequest' },
    apply: { class: 'unverified', evidence: 'Use requests require a four-field envelope (consumer/destination/purpose/reviewerDecisionId) of non-empty strings.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-broker.js:requireUseRequest',
      justification: 'The use-request envelope is an audit-oriented NNA invariant on POST /v1/secrets/:id/use; the desktop has no secret-use surface today, so the envelope is classified as engine-internal rather than promised a control it does not have.',
    },
    notes: 'Added 20261010-20: classifies the consumption-envelope grammar.',
  }),
  row({
    id: 'secrets:references',
    key: 'references',
    source: { product: 'NNA', path: 'src/secret-management.js', validator: 'secretReferences' },
    store: { owner: 'NNA', path_class: 'config/opencode.json' },
    apply: { class: 'unverified', evidence: 'Derived read: scans providerProfiles/mcpServers credentials and headerCredentials for secret-source bindings; no persisted reference field exists.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/secret-management.js:secretReferences',
      justification: 'References are computed by scanning the live configuration for secret-source bindings instead of being stored; the desktop renders secret-binding pointers on the MCP/provider binding surfaces but has no per-secret reverse references view, so the honest classification is an owed:false derived read until that view is built.',
    },
    notes: 'Added 20261010-20: closes the binding-lifecycle half of the remaining census item; binding grammar itself is covered by the provider/MCP credential rows.',
  }),
  row({
    id: 'secrets:delete_guard',
    key: 'delete_guard',
    source: { product: 'NNA', path: 'src/secret-management.js', validator: 'deleteUnreferencedSecret' },
    apply: { class: 'unverified', evidence: 'Delete precondition: secret_in_use when the derived reference scan is non-empty.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/experience-engine.js:deleteSecret',
      justification: 'Deletion is guarded by deleteUnreferencedSecret, but only on NNA\'s primary secret-management path (experience-engine deleteSecret); the broker DELETE route (/v1/secrets/:id) that the desktop console actually calls invokes broker.remove directly with no guard, so the desktop does not forward secret_in_use today and the unguarded route is the recorded gap.',
    },
    notes: 'Added 20261010-20; corrected 20261010-21: the guard fires on experience-engine deleteSecret only — the broker DELETE route is unguarded and no desktop surface forwards secret_in_use.',
  }),
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
const item = 'Full secret create/update/scope schema and per-field validation, references and binding lifecycle.';
census.remaining_census = census.remaining_census.filter((entry) => entry !== item);
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows; remaining ${census.remaining_census.length}`);
