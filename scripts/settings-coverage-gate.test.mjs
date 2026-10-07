// SPDX-License-Identifier: Apache-2.0
/** Focused failure-path tests for the C1 settings-coverage gate.
 *
 * The gate runs against a synthetic NNA source (tiny classified catalog plus
 * option modules) and a synthetic census, so a missing classification is
 * rejected without the paired NNA checkout. usage: node --test
 * scripts/settings-coverage-gate.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('./settings-coverage-gate.mjs', import.meta.url));
const windows = { skip: process.platform !== 'win32' };

function catalogModule(fields) {
  const body = fields.map((field) => JSON.stringify(field)).join(',\n  ');
  return `export const CONFIGURATION_CATALOG = Object.freeze({
  schema_version: '1.0',
  authority: 'descriptive_only',
  fields: [
  ${body}
  ],
});
`;
}

async function fixture(t, { fields, cliOptions, census }) {
  const nna = await mkdtemp(join(tmpdir(), 'nnd-catalog-dump-'));
  const work = await mkdtemp(join(tmpdir(), 'nnd-census-'));
  t.after(async () => {
    await rm(nna, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });
  await mkdir(join(nna, 'src'), { recursive: true });
  await writeFile(join(nna, 'VERSION'), '20990101-1\n');
  await writeFile(join(nna, 'src', 'configuration-catalog.js'), catalogModule(fields));
  await writeFile(join(nna, 'src', 'cli.js'), `// synthetic: no option literals here\nexport function greet(what) { return what; }\ngreet('hello');\n`);
  await writeFile(join(nna, 'src', 'cli-options.js'), cliOptions);
  const censusPath = join(work, 'census.json');
  await writeFile(censusPath, JSON.stringify(census));
  return { nna, censusPath };
}

function field(path, classification, extra = {}) {
  return { path, logical_path: path, classification, type: 'string',
    validation: { owner: 'resolveManifest' }, sensitivity: extra.sensitivity ?? null,
    editability: { generic_editable: extra.generic_editable ?? false },
    application: extra.application ?? null };
}

function censusRow(id, family, kind) {
  return { id, family, key: id.slice(id.indexOf(':') + 1), kind, work_package: 'C1', state: 'open' };
}

const healthyCensus = {
  schema_version: 'settings-census-1', version: 'test',
  status: 'open', completeness: 'partial', inspected_on: '2099-01-01',
  source_products: { NNA: { version: '20990101-1' } },
  rows: [
    censusRow('manifest_attachments:attachments', 'manifest_attachments', 'container'),
    censusRow('manifest_attachments:attachments.enabled', 'manifest_attachments', 'operator_setting'),
    censusRow('manifest_provider_alias:provider.endpoint', 'manifest_provider_alias', 'operator_setting'),
    censusRow('invocation:--manifest', 'invocation', 'operator_action'),
    censusRow('invocation:--prompt', 'invocation', 'operator_action'),
  ],
};

const happyFields = [
  field('attachments', 'container'),
  field('attachments.enabled', 'operator_setting', { generic_editable: true, application: { class: 'engine_boundary' } }),
  field('provider.endpoint', 'operator_setting', { application: null }),
];
const happyCliOptions = `const OPTIONS = ['--manifest', '--prompt'];
export function parseCli(argv) { return argv; }
`;

test('coverage gate passes a classified synthetic pair', windows, async t => {
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census: healthyCensus });
  const result = await run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /settings coverage gate passed/u);
  const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('settings coverage gate passed')));
  assert.equal(report.missing_rows.length, 0);
});

test('coverage gate admits an evidenced no-surface-owed claim and counts it', windows, async t => {
  const census = structuredClone(healthyCensus);
  const row = census.rows.find((item) => item.id === 'manifest_attachments:attachments');
  row.current_gui = { path: null, status: 'unverified', owed: false,
    basis: 'packages/ui/src/lib/nnd/native-gateway.ts:parseNativeGatewayView',
    justification: 'The store reports one legal version and the client refuses every other '
      + 'value, so the field can never differ between installations and any display of it '
      + 'would be decoration rather than coverage.' };
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.slice(0, result.stdout.indexOf('settings coverage gate passed')));
  assert.equal(report.surface_not_owed, 1);
});

test('coverage gate rejects a no-surface-owed claim that carries no evidence', windows, async t => {
  const census = structuredClone(healthyCensus);
  const bare = census.rows.find((item) => item.id === 'manifest_attachments:attachments');
  bare.current_gui = { path: null, status: 'unverified', owed: false };
  const contradicted = census.rows.find((item) => item.id === 'manifest_attachments:attachments.enabled');
  contradicted.current_gui = { path: 'packages/ui/src/components/settings/pages/x.tsx',
    status: 'verified', owed: false, basis: 'packages/ui/src/lib/nnd/x.ts:symbol',
    justification: 'Stated twice in the same row, which is exactly the mistake this check '
      + 'exists to refuse, however long the sentence is.' };
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.unsupported_surface_claims.map((claim) => claim.id),
    ['manifest_attachments:attachments', 'manifest_attachments:attachments.enabled']);
});

test('coverage gate rejects an unclassified catalog field', windows, async t => {
  const fields = [...happyFields, field('attachments.new_key', 'operator_setting', { generic_editable: false })];
  const f = await fixture(t, { fields, cliOptions: happyCliOptions, census: healthyCensus });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing_rows, ['attachments.new_key']);
});

test('coverage gate rejects kind drift against the catalog', windows, async t => {
  const census = structuredClone(healthyCensus);
  census.rows.find((row) => row.id === 'manifest_attachments:attachments.enabled').kind = 'internal_invariant';
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kind_drift.length, 1);
  assert.equal(report.kind_drift[0].path, 'attachments.enabled');
});

test('coverage gate rejects census rows with no live catalog field', windows, async t => {
  const census = structuredClone(healthyCensus);
  census.rows.push(censusRow('manifest_attachments:attachments.removed', 'manifest_attachments', 'operator_setting'));
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing_rows, []);
  assert.match(report.stale_rows.join('|'), /attachments\.removed: no live catalog field/u);
});

test('coverage gate rejects an unclassified CLI option literal', windows, async t => {
  const cliOptions = `const OPTIONS = ['--manifest', '--prompt', '--future'];
export function parseCli(argv) { return argv; }
`;
  const f = await fixture(t, { fields: happyFields, cliOptions, census: healthyCensus });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.missing_option_rows, ['--future']);
  assert.deepEqual(report.stale_option_rows, []);
});

test('coverage gate rejects stale census option rows', windows, async t => {
  const census = structuredClone(healthyCensus);
  census.rows.push(censusRow('invocation:--removed', 'invocation', 'operator_action'));
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.stale_option_rows, ['--removed']);
});

test('coverage gate rejects an unusable NNA source with a named failure', windows, async t => {
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census: healthyCensus });
  await rm(join(f.nna, 'src', 'configuration-catalog.js'));
  const result = await run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /settings coverage gate failed.*catalog dump failed/u);
});

test('coverage gate keeps only catalog-declared alias rows alive', windows, async t => {
  // An alias census row survives only when catalog.alias_of names a
  // catalog-declared logical link (fieldByLogical) AND the row kind equals
  // that target's classification; anything else is a stale row.
  const aliasFields = [
    field('attachments', 'container'),
    field('attachments.enabled', 'operator_setting'),
    field('providers[*].endpoint', 'operator_setting'),
    { path: 'provider.endpoint', logical_path: 'providers[*].endpoint', classification: 'operator_setting',
      type: 'string', validation: { owner: 'resolveManifest' }, sensitivity: null,
      editability: { generic_editable: false }, application: null },
  ];
  const cliOptions = `const OPTIONS = ['--manifest', '--prompt'];
export function parseCli(argv) { return argv; }
`;
  const census = structuredClone(healthyCensus);
  census.rows.push(
    censusRow('manifest_provider:providers[*].endpoint', 'manifest_provider', 'operator_setting'),
    censusRow('manifest_legacy:legacy.endpoint', 'manifest_legacy', 'operator_setting'),
  );
  const declared = structuredClone(census);
  declared.rows.find((row) => row.id === 'manifest_legacy:legacy.endpoint')
    .catalog = { alias_of: 'providers[*].endpoint' };
  const fDeclared = await fixture(t, { fields: aliasFields, cliOptions, census: declared });
  const ok = await run(fDeclared);
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const drift = structuredClone(declared);
  drift.rows.find((row) => row.id === 'manifest_legacy:legacy.endpoint').kind = 'internal_invariant';
  const fDrift = await fixture(t, { fields: aliasFields, cliOptions, census: drift });
  const driftResult = await run(fDrift);
  assert.equal(driftResult.status, 1, driftResult.stdout);
  assert.match(driftResult.stderr, /unclassified or drifted coverage detected/u);
  const undeclared = structuredClone(declared);
  undeclared.rows.find((row) => row.id === 'manifest_legacy:legacy.endpoint')
    .catalog = { alias_of: 'attachments.enabled' };
  const fUndeclared = await fixture(t, { fields: aliasFields, cliOptions, census: undeclared });
  const undeclaredResult = await run(fUndeclared);
  assert.equal(undeclaredResult.status, 1, undeclaredResult.stdout);
  const undeclaredReport = JSON.parse(undeclaredResult.stdout);
  assert.match(undeclaredReport.stale_rows.join('|'), /legacy\.endpoint: no live catalog field/u);
});

test('coverage gate rejects a surface path that names no file', windows, async t => {
  // Six census rows once claimed a verified component at a path renamed away
  // from the native- prefix. Nothing noticed, because nothing asked whether the
  // file existed. A claimed path is now a claim about the tree.
  const census = structuredClone(healthyCensus);
  census.rows[0].current_gui = { product: 'NND',
    path: 'scripts/__surface_that_was_renamed_away__.tsx', status: 'verified' };
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 1, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.surface_files_missing.length, 1);
  assert.equal(report.surface_files_missing[0].path, 'scripts/__surface_that_was_renamed_away__.tsx');
  assert.match(result.stderr, /unclassified or drifted coverage detected/u);
});

test('coverage gate accepts a surface path that names a real file', windows, async t => {
  const census = structuredClone(healthyCensus);
  census.rows[0].current_gui = { product: 'NND', path: 'scripts/settings-coverage-gate.mjs',
    status: 'verified' };
  const f = await fixture(t, { fields: happyFields, cliOptions: happyCliOptions, census });
  const result = await run(f);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  // The success path appends a verdict line after the report, so the seal text
  // is matched rather than parsed.
  assert.match(result.stdout, /"surface_files_missing": \[\]/u);
});

function run({ nna, censusPath }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [gate, nna, censusPath], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.once('close', (status) => resolve({ status, stdout: out, stderr: err }));
  });
}
