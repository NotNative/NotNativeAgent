// SPDX-License-Identifier: Apache-2.0
/**
 * Snippet storage (doc 03 config entities §5.x "Snippets"): text-expansion
 * macros managed as `<data-dir>/config/snippets/<name>.json` files. Names
 * are `[\w-]{1,64}` (the tokenizer's `#name` vocabulary); records carry
 * `name`, `text`, and default `scope: 'global'`. Expansion replaces known
 * `#name` tokens; unknown tokens stay verbatim (§H.3/§H.2 failure keeps
 * the original).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { ENV } from '../env.ts';

export interface SnippetRecord {
  name: string;
  text: string;
  scope?: string;
  [key: string]: unknown;
}

const NAME = /^[\w-]{1,64}$/u;

/** Windows reserves these names for FILES on any volume with any extension
 * (CON, PRN, AUX, NUL, COM1-9, LPT1-9): on volumes that still enforce the
 * rule, writing `<name>.json` throws. This Windows build tolerates them, so
 * the API guards the family to keep the contract platform-independent. */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

export function snippetNameReserved(name: string): boolean {
  return RESERVED.has(name.toLowerCase());
}

export function snippetsDirFor(dataDir: string = ENV.dataDir): string {
  return joinPath(dataDir, 'config', 'snippets');
}

export function snippetNameOk(name: string): boolean {
  return NAME.test(name);
}

export async function listSnippets(dataDir: string = ENV.dataDir): Promise<SnippetRecord[]> {
  const dir = snippetsDirFor(dataDir);
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -5)).sort();
  const records: SnippetRecord[] = [];
  for (const name of names) {
    const record = await readSnippet(name, dataDir);
    if (record !== null) records.push(record);
  }
  return records;
}

export async function readSnippet(name: string, dataDir: string = ENV.dataDir): Promise<SnippetRecord | null> {
  if (!snippetNameOk(name)) return null;
  try {
    const parsed = JSON.parse(await readFile(joinPath(snippetsDirFor(dataDir), `${name}.json`), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as SnippetRecord;
    if (typeof record.name !== 'string' || typeof record.text !== 'string') return null;
    record.name = name; // the URL (file) name is the authority
    return record;
  } catch {
    return null;
  }
}

/** The name the file ACTUALLY carries: exact case first; when the volume
 * folds case (Windows), a case-insensitive fold resolves the single stored
 * entry so lookups by any case land on the true identity instead of
 * rewriting the stored file under the URL's case. An ambiguous fold
 * (possible on POSIX with `sig.json` AND `SIG.json`) resolves to null -
 * the URL is simply not a stored name. */
export async function resolveStoredName(name: string, dataDir: string = ENV.dataDir): Promise<string | null> {
  if (!snippetNameOk(name)) return null;
  const dir = snippetsDirFor(dataDir);
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir);
  const exact = entries.find((entry) => entry === `${name}.json`);
  if (exact !== undefined) return exact.slice(0, -5);
  const folded = `${name.toLowerCase()}.json`;
  const matches = entries.filter((entry) => entry.toLowerCase() === folded);
  return matches.length === 1 ? matches[0]!.slice(0, -5) : null;
}

export async function writeSnippet(record: SnippetRecord, dataDir: string = ENV.dataDir): Promise<void> {
  const dir = snippetsDirFor(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ ...record, name: record.name, scope: record.scope ?? 'global' });
  const target = joinPath(dir, `${record.name}.json`);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, payload, 'utf8');
  await rename(tmp, target);
}

export async function deleteSnippet(name: string, dataDir: string = ENV.dataDir): Promise<boolean> {
  if (!snippetNameOk(name)) return false;
  const target = joinPath(snippetsDirFor(dataDir), `${name}.json`);
  if (!existsSync(target)) return false;
  try {
    await unlink(target);
  } catch (error) {
    // A racing DELETE already removed the file between the existence probe
    // and the unlink: that is a lost race, not a server fault - 404.
    if ((error as NodeJS.ErrnoException & { code?: string })?.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

/** `#name` tokens over a known roster expand; unknown tokens keep their
 * bytes (the §H.3 registered keep-original rule). */
export function expandSnippetText(text: string, records: SnippetRecord[]): string {
  const map = new Map(records.map((record) => [record.name, record.text]));
  return text.replace(/#([\w-]+)/gu, (whole, name: string) => map.get(name) ?? whole);
}
