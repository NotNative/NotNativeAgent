// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.env.NND_ROOT ?? process.cwd();
const TABLE = 'docs/build/EXECUTION/04-feature-parity.md';
const RECORDS = 'docs/build/EXECUTION/feature-parity-records.json';
export const STATUSES = ['pending', 'implemented-unverified', 'verified', 'deferred-nna-blocked'];

/** Parse the authoritative W table (04-feature-parity.md) into {id, packages, disposition}. */
export async function parseWTable() {
  const text = await readFile(join(ROOT, TABLE), 'utf8');
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = /^\| (W-\d{2,3}) \| ([^|]+) \| (.+) \|$/u.exec(line.trim());
    if (!match) continue;
    const [, id, packages, disposition] = match;
    if (id === 'ID' || rows.has(id)) continue;
    rows.set(id, { id, packages: packages.trim(), disposition: disposition.trim() });
  }
  return rows;
}

export async function loadRecords() {
  const parsed = JSON.parse(await readFile(join(ROOT, RECORDS), 'utf8'));
  if (!parsed || !Array.isArray(parsed.records)) throw new Error('feature-parity-records.json must hold a records array');
  return parsed;
}

/** The MVP-closure gate: every W item dispositioned exactly once, honestly. */
export async function auditRecords() {
  const problems = [];
  const table = await parseWTable();
  const expected = [...table.keys()];
  const { records } = await loadRecords();
  const seen = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { problems.push('record is not an object'); continue; }
    const id = record.id;
    if (typeof id !== 'string' || !/^W-\d{2,3}$/u.test(id)) { problems.push(`invalid id ${JSON.stringify(id)}`); continue; }
    if (seen.has(id)) problems.push(`${id} appears twice`);
    seen.set(id, record);
    if (!table.has(id)) { problems.push(`${id} is not in the authoritative table`); continue; }
    const source = table.get(id);
    if (record.work_packages !== source.packages) problems.push(`${id} work_packages drifted from the table`);
    if (record.disposition !== source.disposition) problems.push(`${id} disposition drifted from the table`);
    if (!STATUSES.includes(record.status)) problems.push(`${id} status ${JSON.stringify(record.status)} is outside the vocabulary`);
    if (record.status !== 'pending') {
      if (!Array.isArray(record.evidence) || record.evidence.length === 0
        || record.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        problems.push(`${id} claims ${record.status} without evidence paths`);
      }
    }
    if (record.subfeatures !== undefined && !Array.isArray(record.subfeatures)) problems.push(`${id} subfeatures must be an array`);
  }
  for (const id of expected) if (!seen.has(id)) problems.push(`${id} has no acceptance record`);
  return { problems, expected: expected.length, recorded: seen.size };
}
