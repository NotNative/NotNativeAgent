// SPDX-License-Identifier: Apache-2.0
/** C1 settings-coverage gate: reject unclassified native configuration surface.
 *
 * The NNA classified configuration catalog is the executable key inventory and
 * validates itself against NNA's validators; this gate pins the census ledger to
 * that inventory so a new native key or CLI option fails coverage until the
 * census classifies it (guide 03, C1). Checks, in order:
 *  1. every classified catalog field has a census manifest row;
 *  2. every census manifest row maps to a live catalog field (no stale rows;
 *     alias rows survive through their live logical target only);
 *  3. census row `kind` agrees with the live catalog classification;
 *  4. every dashed CLI option literal in NNA `src/cli.js` and
 *     `src/cli-options.js` has an invocation census row;
 *  5. every census invocation option is still declared on the NNA side.
 *
 * The option scan is mechanical literal extraction: humans own the census
 * classifications; the gate only rejects unclassified additions. It scans the
 * two option modules only, not the whole tree, so unrelated quoted text cannot
 * create false option requirements.
 *
 * usage: node scripts/settings-coverage-gate.mjs ABSOLUTE_NNA_SOURCE [CENSUS_JSON]
 * The second argument is a test seam: the hermetic test passes a synthetic
 * NNA source and census; production reads the committed census.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CENSUS_PATH = fileURLToPath(new URL('../docs/build/EXECUTION/settings-coverage.json', import.meta.url));

await main(process.argv[2], process.argv[3] ?? CENSUS_PATH).catch((error) => {
  process.stderr.write(`settings coverage gate failed: ${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});

async function main(nnaSource, censusPath) {
  if (!nnaSource || !/^(?:[A-Za-z]:[\\/]|\/)/u.test(nnaSource)) {
    throw new Error('usage: node scripts/settings-coverage-gate.mjs ABSOLUTE_NNA_SOURCE [CENSUS_JSON]');
  }
  const catalog = await dumpCatalog(nnaSource);
  const census = JSON.parse(await readFile(censusPath, 'utf8'));
  const violations = { missingRows: [], staleRows: [], kindDrift: [], missingOptions: [], staleOptions: [] };
  await trace(violations, census, catalog, nnaSource);
  emit(violations, census, catalog);
}

function emit(violations, census, catalog) {
  const report = {
    census: 'docs/build/EXECUTION/settings-coverage.json',
    nna_version: catalog.version,
    catalog_fields: catalog.fields.length,
    census_manifest_rows: census.rows.filter((row) => row.family.startsWith('manifest')).length,
    missing_rows: violations.missingRows,
    stale_rows: violations.staleRows,
    kind_drift: violations.kindDrift.slice(0, 200),
    missing_option_rows: violations.missingOptions,
    stale_option_rows: violations.staleOptions,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (violations.missingRows.length > 0 || violations.staleRows.length > 0
    || violations.kindDrift.length > 0 || violations.missingOptions.length > 0
    || violations.staleOptions.length > 0) {
    process.stderr.write('settings coverage gate: unclassified or drifted coverage detected\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('settings coverage gate passed\n');
  }
}

async function dumpCatalog(nnaSource) {
  // The catalog is NNA's authority, so import it in NNA's own process rather
  // than copying its logic across the repository boundary.
  const loader = `
const { CONFIGURATION_CATALOG } = await import(${JSON.stringify(pathToFileURL(join(nnaSource, 'src/configuration-catalog.js')).href)});
const { readFile } = await import('node:fs/promises');
process.stdout.write(JSON.stringify({
  version: (await readFile('VERSION', 'utf8')).trim(),
  authority: CONFIGURATION_CATALOG.authority,
  schema_version: CONFIGURATION_CATALOG.schema_version,
  fields: CONFIGURATION_CATALOG.fields.map((field) => ({
    path: field.path,
    logical_path: field.logical_path,
    classification: field.classification,
    type: field.type,
    validation_owner: field.validation?.owner ?? null,
    sensitivity: field.sensitivity ?? null,
    generic_editable: field.editability?.generic_editable === true,
    application: field.application ?? null,
  })),
}));
`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', loader],
    { cwd: nnaSource, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  // Await 'close', not 'exit': exit can fire before stdio streams drain, which
  // would truncate the catalog JSON for a large dump. The bound fails closed.
  const code = await new Promise((done, reject) => {
    const bound = setTimeout(() => { child.kill(); reject(new Error('NNA catalog dump exceeded 60s')); }, 60000);
    child.once('error', (error) => { clearTimeout(bound); reject(error); });
    child.once('close', (status) => { clearTimeout(bound); done(status); });
  });
  if (code !== 0) throw new Error(`NNA catalog dump failed: ${err.slice(-4000)}`);
  const dump = JSON.parse(out);
  if (dump.schema_version !== '1.0') throw new Error('catalog schema_version must stay 1.0 for this gate');
  if (dump.authority !== 'descriptive_only') throw new Error('catalog authority must stay descriptive_only for this gate');
  for (const field of dump.fields) {
    if (!field.path || !field.classification) throw new Error(`catalog dump is missing path/classification near ${field.path ?? '(unknown)'}`);
  }
  return dump;
}

async function trace(violations, census, catalog, nnaSource) {
  const fields = catalog.fields;
  const fieldByPath = new Map(fields.map((field) => [field.path, field]));
  const fieldByLogical = new Map(fields.filter((field) => field.logical_path !== field.path)
    .map((field) => [field.logical_path, field]));

  const rowByPath = new Map();
  for (const row of census.rows.filter((row) => row.family.startsWith('manifest'))) {
    const colon = row.id.indexOf(':');
    if (colon < 1) { violations.staleRows.push(`${row.id}: manifest row id must be family:path`); continue; }
    const path = row.id.slice(colon + 1);
    if (rowByPath.has(path)) violations.staleRows.push(`${row.id}: duplicate manifest row`);
    rowByPath.set(path, row);
  }

  for (const field of fields) {
    const row = rowByPath.get(field.path);
    if (!row) { violations.missingRows.push(field.path); continue; }
    if (row.kind !== field.classification) {
      violations.kindDrift.push({ path: field.path, census_kind: row.kind, catalog: field.classification });
    }
  }
  for (const [path, row] of rowByPath) {
    if (fieldByPath.has(path) || fieldByLogical.has(path)) continue;
    // An alias row survives only through a catalog-DECLARED alias link (the
    // logical-path map, which is the catalog's own alias vocabulary), and its
    // kind must still equal the linked target's classification; pointing
    // `catalog.alias_of` at an unrelated live field cannot silence a stale row.
    const targetField = row.catalog?.alias_of ? fieldByLogical.get(row.catalog.alias_of) : null;
    if (!(targetField && row.kind === targetField.classification)) {
      violations.staleRows.push(`${row.id}: no live catalog field`);
    }
  }

  const literals = new Set();
  for (const file of ['src/cli.js', 'src/cli-options.js']) {
    const text = await readFile(join(nnaSource, ...file.split('/')), 'utf8');
    // Standalone-quoted literals only (including template literals); prose
    // strings that mention an option mid-sentence do not close on the token,
    // so a future option must still be a quoted literal to require a row.
    for (const match of text.matchAll(/(['"`])(\s*-{1,2}[a-z][a-z0-9_:.-]*)\1/giu)) {
      literals.add(match[2].trim());
    }
  }
  const invocationTokens = new Set(census.rows.filter((row) => row.family === 'invocation')
    .map((row) => row.id.slice(row.id.indexOf(':') + 1)));
  for (const token of [...literals].sort()) {
    if (!invocationTokens.has(token)) violations.missingOptions.push(token);
  }
  for (const token of [...invocationTokens].sort()) {
    if (!literals.has(token)) violations.staleOptions.push(token);
  }
}
