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
 *  5. every census invocation option is still declared on the NNA side;
 *  6. every surface path a row claims is a file that exists in its own product;
 *  7. every positional subcommand in the NNA mode vocabulary (`MODES` and
 *     `OPENCODE_ACTIONS` in `src/cli-options.js`) has an invocation census row;
 *  8. every environment read NNA performs (the observed snapshot vocabulary in
 *     `src/nnd-environment-snapshot.js` plus every direct `process.env`
 *     literal under `src/`) has an environment census row.
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
import { existsSync } from 'node:fs';
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
  const violations = { missingRows: [], staleRows: [], kindDrift: [], missingOptions: [], staleOptions: [],
    missingSubcommands: [], staleSubcommands: [], missingEnv: [], staleEnv: [], surfaceClaims: [], missingFiles: [] };
  await trace(violations, census, catalog, nnaSource);
  checkDispositions(violations, census);
  checkSurfaceFiles(violations, census, nnaSource);
  emit(violations, census, catalog);
}

/**
 * A row that claims a desktop surface makes a checkable claim about a file in the tree. Six
 * rows named a component with a `native-` prefix that was renamed away, and stayed `verified`
 * because nothing had ever asked whether the path existed. A named path must be a file.
 */
function checkSurfaceFiles(violations, census, nnaSource) {
  const nndRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const row of census.rows) {
    const gui = row.current_gui;
    const claimed = gui?.path;
    if (typeof claimed !== 'string' || claimed.length === 0) continue;
    if (/[*\s]/u.test(claimed)) continue;
    const root = String(gui.product ?? 'NND') === 'NNA' ? nnaSource : nndRoot;
    if (!existsSync(join(root, claimed))) {
      violations.missingFiles.push({ id: row.id, product: String(gui.product ?? 'NND'), path: claimed });
    }
  }
}

/**
 * A census row may state that no desktop surface is owed to it. That statement moves the
 * headline number without any product changing, so it is only admissible with evidence: an
 * empty path, a status that does not claim a surface, a basis naming a source file and a
 * symbol in it, and a justification long enough to be checked against that source. Rows that
 * satisfy this are counted in the seal output, so a falling headline can always be read
 * against the number of rows that opted out.
 */
function checkDispositions(violations, census) {
  for (const row of census.rows) {
    const gui = row.current_gui;
    if (gui?.owed !== false) continue;
    const problems = [];
    if (gui.path) problems.push('names a surface path');
    if (gui.status === 'verified') problems.push('claims a verified surface');
    if (typeof gui.basis !== 'string' || !/[\w./-]+\.(?:tsx|ts|jsx|js):\w/u.test(gui.basis)) {
      problems.push('basis does not name a source file and symbol');
    }
    if (typeof gui.justification !== 'string' || gui.justification.trim().length < 60) {
      problems.push('justification is missing or too short to check');
    }
    if (problems.length > 0) violations.surfaceClaims.push({ id: row.id, problems });
  }
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
    missing_subcommand_rows: violations.missingSubcommands,
    stale_subcommand_rows: violations.staleSubcommands,
    missing_environment_rows: violations.missingEnv,
    stale_environment_rows: violations.staleEnv,
    surface_not_owed: census.rows.filter((row) => row.current_gui?.owed === false).length,
    unsupported_surface_claims: violations.surfaceClaims.slice(0, 20),
    surface_files_missing: violations.missingFiles.slice(0, 20),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (violations.missingRows.length > 0 || violations.staleRows.length > 0
    || violations.kindDrift.length > 0 || violations.missingOptions.length > 0
    || violations.staleOptions.length > 0 || violations.missingSubcommands.length > 0
    || violations.staleSubcommands.length > 0 || violations.missingEnv.length > 0
    || violations.staleEnv.length > 0 || violations.surfaceClaims.length > 0
    || violations.missingFiles.length > 0) {
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
  checkOptions(violations, census, literals);
  await checkSubcommands(violations, census, nnaSource);
  await checkEnvironment(violations, census, nnaSource);
}

function checkOptions(violations, census, literals) {
  // Only dashed tokens participate in the option checks; positional
  // subcommands are covered by the subcommand vocabulary check below.
  const invocationTokens = new Set(census.rows.filter((row) => row.family === 'invocation')
    .map((row) => row.id.slice(row.id.indexOf(':') + 1))
    .filter((token) => token.startsWith('-')));
  for (const token of [...literals].sort()) {
    if (!invocationTokens.has(token)) violations.missingOptions.push(token);
  }
  for (const token of [...invocationTokens].sort()) {
    if (!literals.has(token)) violations.staleOptions.push(token);
  }
}

async function checkSubcommands(violations, census, nnaSource) {
  // Positional subcommands: the mode vocabulary is NNA's own Set literals, so
  // a new mode or action fails coverage until the census classifies it.
  const { modes, actions } = await subcommandVocabulary(nnaSource);
  const subcommandRows = new Set(census.rows.filter((row) => row.family === 'invocation')
    .map((row) => row.id.slice(row.id.indexOf(':') + 1))
    .filter((token) => !token.startsWith('-')));
  for (const token of [...modes, ...actions].sort()) {
    if (!subcommandRows.has(token)) violations.missingSubcommands.push(token);
  }
  for (const token of [...subcommandRows].sort()) {
    if (!modes.includes(token) && !actions.includes(token)) violations.staleSubcommands.push(token);
  }
}

async function checkEnvironment(violations, census, nnaSource) {
  // Environment provenance: the snapshot vocabulary plus every direct
  // process.env literal under src/ must be classified; an environment row
  // without a live read is stale.
  const envNames = await environmentNames(nnaSource);
  const envRows = new Set(census.rows.filter((row) => row.family === 'environment')
    .map((row) => row.id.slice(row.id.indexOf(':') + 1)));
  for (const name of envNames.sort()) {
    if (!envRows.has(name)) violations.missingEnv.push(name);
  }
  for (const name of [...envRows].sort()) {
    if (!envNames.includes(name)) violations.staleEnv.push(name);
  }
}

async function setLiteral(source, file, name) {
  const text = await readFile(join(source, ...file.split('/')), 'utf8');
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`, 'u').exec(text);
  // Fail loud: a silent empty vocabulary would read as 26 stale rows instead
  // of the parse failure it is.
  if (match === null) throw new Error(`missing ${name} set literal in ${file}`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}

async function subcommandVocabulary(nnaSource) {
  const modes = (await setLiteral(nnaSource, 'src/cli-options.js', 'MODES'))
    .filter((token) => !token.startsWith('-'));
  const actions = await setLiteral(nnaSource, 'src/cli-options.js', 'OPENCODE_ACTIONS');
  return { modes, actions };
}

async function environmentNames(nnaSource) {
  const names = new Set();
  const snapshot = join(nnaSource, 'src', 'nnd-environment-snapshot.js');
  if (existsSync(snapshot)) {
    const text = await readFile(snapshot, 'utf8');
    const match = /OBSERVED_NAMES = \[([^\]]*)\]/u.exec(text);
    if (match !== null) {
      for (const entry of match[1].matchAll(/'([^']+)'/gu)) names.add(entry[1]);
    }
  }
  const { readdir } = await import('node:fs/promises');
  const stack = [join(nnaSource, 'src')];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) stack.push(path);
      else if (item.name.endsWith('.js')) {
        const text = await readFile(path, 'utf8');
        for (const read of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gu)) {
          names.add(read[1] ?? read[2]);
        }
      }
    }
  }
  return [...names];
}
