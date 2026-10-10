// SPDX-License-Identifier: Apache-2.0
/** One-off C7 census extension: adds invocation rows for every positional
 * subcommand in NNA's mode vocabulary and environment rows for every
 * environment name NNA reads (snapshot vocabulary + direct process.env
 * literals). Rows carry evidenced owed:false claims because the CLI stays
 * the terminal-owned authority and the environment reads are process
 * plumbing, never desktop settings.
 * usage: node scripts/add-c7-subcommand-env-rows.mjs ABSOLUTE_NNA_SOURCE
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CENSUS_PATH = fileURLToPath(new URL('../docs/build/EXECUTION/settings-coverage.json', import.meta.url));
const nnaSource = process.argv[2];
if (!nnaSource) {
  console.error('usage: node scripts/add-c7-subcommand-env-rows.mjs ABSOLUTE_NNA_SOURCE');
  process.exit(1);
}

const census = JSON.parse(await readFile(CENSUS_PATH, 'utf8'));
const existing = new Set(census.rows.map((row) => row.id));
let added = 0;

function subcommandRow(token) {
  return {
    id: `invocation:${token}`,
    kind: 'operator_action',
    family: 'invocation',
    key: token,
    source: { product: 'NNA', path: 'src/cli-options.js', validator: 'parseCli' },
    store: { owner: 'NNA', path_class: 'invocation_arguments' },
    scope: ['invocation'],
    apply: {
      class: 'census_only',
      evidence: 'nnd-invocation-routes 20261006-21: the CLI stays the terminal-owned authority; '
        + 'the native surface describes the grammar read-only and applies nothing',
    },
    native_endpoint: 'GET /v1/nnd/configuration/invocation (vocabulary read; subcommands remain CLI-owned)',
    native_permission: 'nnd.configuration.read',
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/cli-options.js:MODES',
      justification: 'The CLI remains the only way to invoke a positional subcommand: the desktop '
        + 'launches the harness child itself (nnd serve, process plumbing in nna-local) but exposes '
        + 'no desktop control for any subcommand, so a subcommand control would duplicate the '
        + 'terminal without owning it.',
    },
    sensitivity: 'security',
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-14 gate extension)',
    state: 'open',
    evidence: { source_symbols: ['MODES', 'OPENCODE_ACTIONS', 'parseCli'], tests_run: [
      'NND scripts/settings-coverage-gate.test.mjs 14/14 including the subcommand classification pair',
    ] },
    notes: 'Added by the C7 gate extension: every positional subcommand in the NNA mode vocabulary requires a row.',
  };
}

function environmentRow(name, basis, observed) {  return {
    id: `environment:${name}`,
    kind: 'operator_setting',
    family: 'environment',
    key: name,
    source: { product: 'NNA', path: observed ? 'src/nnd-environment-snapshot.js' : basis.split(':').slice(0, -1).join(':'),
      validator: observed ? 'OBSERVED_NAMES' : 'direct process.env read' },
    store: { owner: 'NNA', path_class: 'process_environment' },
    scope: ['process_invocation'],
    apply: {
      class: 'census_only',
      evidence: 'nnd-environment-snapshot 20261006-3: environment values are observed read-only '
        + 'and never applied or stored',
    },
    native_endpoint: 'GET /v1/nnd/configuration/environment (read-only observation)',
    native_permission: 'nnd.configuration.read',
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis,
      justification: observed
        ? 'The value is one of the snapshot-observed environment names: the desktop can display the '
          + 'read-only observation at most, and the value itself is never editable, stored, or applied '
          + 'as a configuration surface.'
        : 'The read is process plumbing inside NNA tooling (spawn environments, harness detection, '
          + 'browser automation paths), not configuration: no value is stored, applied, or rendered '
          + 'as a setting anywhere in the desktop.',
    },
    sensitivity: 'security',
    work_package: 'C1',
    implementation_package: 'C1 stage 2 (20261010-14 gate extension)',
    state: 'open',
    evidence: { source_symbols: [observed ? 'OBSERVED_NAMES' : 'process.env'], tests_run: [
      'NND scripts/settings-coverage-gate.test.mjs 14/14 including the environment provenance pair',
    ] },
    notes: 'Added by the C7 gate extension: every environment read requires a provenance row.',
  };
}

// Positional subcommands from the mode vocabulary.
const cliOptions = await readFile(join(nnaSource, 'src', 'cli-options.js'), 'utf8');
const sets = { MODES: [], OPENCODE_ACTIONS: [] };
for (const name of Object.keys(sets)) {
  const match = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`, 'u').exec(cliOptions);
  if (match === null) throw new Error(`missing ${name} set literal in src/cli-options.js`);
  sets[name] = [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}
const subcommands = [...sets.MODES.filter((token) => !token.startsWith('-')), ...sets.OPENCODE_ACTIONS];
for (const token of subcommands) {
  if (!existing.has(`invocation:${token}`)) {
    census.rows.push(subcommandRow(token));
    existing.add(`invocation:${token}`);
    added += 1;
  }
}

// Environment names: snapshot vocabulary plus direct reads.
const envNames = new Map(); // name -> { file, observed }
const snapshot = join(nnaSource, 'src', 'nnd-environment-snapshot.js');
const snapshotText = await readFile(snapshot, 'utf8');
const observedMatch = /OBSERVED_NAMES = \[([^\]]*)\]/u.exec(snapshotText);
if (observedMatch === null) throw new Error('missing OBSERVED_NAMES in src/nnd-environment-snapshot.js');
for (const entry of observedMatch[1].matchAll(/'([^']+)'/gu)) envNames.set(entry[1], { basis: 'src/nnd-environment-snapshot.js:OBSERVED_NAMES', observed: true });
const stack = [join(nnaSource, 'src')];
while (stack.length > 0) {
  const current = stack.pop();
  for (const item of await readdir(current, { withFileTypes: true })) {
    const path = join(current, item.name);
    if (item.isDirectory()) stack.push(path);
    else if (item.name.endsWith('.js')) {
      const text = await readFile(path, 'utf8');
      for (const read of text.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/gu)) {
        const name = read[1] ?? read[2];
        if (!envNames.has(name)) {
          envNames.set(name, { basis: `src/${path.slice(nnaSource.length + 5).replaceAll('\\', '/')}:process.env`, observed: false });
        }
      }
    }
  }
}
for (const [name, info] of [...envNames.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (!existing.has(`environment:${name}`)) {
    census.rows.push(environmentRow(name, info.basis, info.observed));
    existing.add(`environment:${name}`);
    added += 1;
  }
}

await writeFile(CENSUS_PATH, `${JSON.stringify(census, null, 1)}\n`);
console.log(`added ${added} rows; census now has ${census.rows.length} rows`);
