// SPDX-License-Identifier: Apache-2.0
/** One-off census generator for the skills-format classification: adds the
 * on-disk skill format row and the no-write-actions disposition row, retires
 * the census item, and records the NNA-side gap. Kept for provenance. */
import { readFile, writeFile } from 'node:fs/promises';

const rows = [
  {
    id: 'skills-store:SKILL.md-format',
    kind: 'internal_invariant',
    family: 'skills-store',
    key: 'SKILL.md format',
    source: { product: 'NNA', path: 'src/skill-registry.js', validator: 'parseSkillFile' },
    store: { owner: 'NNA', path_class: 'bundled/user/trusted-project skill roots' },
    apply: { class: 'unverified', evidence: 'On-disk discovery format: SKILL.md (or *.skill.md) with YAML frontmatter read by the registry; not an operator-editable configuration value.' },
    native_endpoint: 'GET /v1/nnd/configuration/skills (metadata-only inventory: bodies and source paths stay engine-private)',
    native_permission: 'nnd.configuration.read',
    current_gui: {
      product: 'NND', path: 'packages/ui/src/components/settings/pages/native-skills.tsx', status: 'verified',
    },
    work_package: 'C5',
    implementation_package: 'C5 (20261010-19 skills formats)',
    state: 'open',
    notes: 'Added 20261010-19: classifies the on-disk skill format behind the inventory the desktop already renders.',
  },
  {
    id: 'skills_action:install-remove-edit',
    kind: 'operator_action',
    family: 'skills_action',
    key: 'install/remove/edit',
    source: { product: 'NNA', path: 'src/skills-cli.js', validator: 'runSkillsCommand' },
    apply: { class: 'unverified', evidence: 'NNA accepts only the list action on its skills CLI and GET-only skills routes; no write action exists to classify as applied.' },
    current_gui: {
      product: 'NND', path: null, status: 'unverified', owed: false,
      basis: 'src/skills-cli.js:LIST_ACTION',
      justification: 'NNA\'s skills CLI accepts only the list action (anything else raises invalid_skills_command) and its skills routes are GET-only, so no install/remove/edit action exists for the desktop to surface; building one would mean inventing NNA behavior it does not own.',
    },
    work_package: 'C5',
    implementation_package: 'C5 (20261010-19 skills formats)',
    state: 'open',
    notes: 'Added 20261010-19: honest disposition for the F8.3 write actions; unblocks only when NNA ships the native lifecycle contract (revision/reload reporting).',
  },
];

const path = 'docs/planning/EXECUTION/settings-coverage.json';
const census = JSON.parse(await readFile(path, 'utf8'));
const existing = new Set(census.rows.map((row) => row.id));
let added = 0;
for (const row of rows) {
  if (existing.has(row.id)) continue;
  census.rows.push(row);
  added += 1;
}
const item = 'On-disk skill formats and native install/remove/edit action availability; current skills CLI only lists.';
census.remaining_census = census.remaining_census.filter((entry) => entry !== item);
census.known_mismatches.push({
  product: 'NNA',
  path: 'src/skills-cli.js',
  issue: 'Skills surface is read-only: the CLI accepts only the list action and the skills routes are GET-only, so F8.3 install/update/remove/edit and effective-revision reporting have no native lifecycle contract to build against.',
  work_package: 'C5',
});
await writeFile(path, JSON.stringify(census, null, 1) + '\n');
console.log(`added ${added} rows; census now has ${census.rows.length} rows; remaining ${census.remaining_census.length}`);
