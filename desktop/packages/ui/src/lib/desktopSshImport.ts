// SPDX-License-Identifier: Apache-2.0
/**
 * `~/.ssh/config` importer (doc 08 section 7.3): Host rows become candidate
 * rows `{host, pattern, source, sshCommand}`. Every alias on a Host line is
 * its own row; Match blocks, comments, glob-only rows and Include directives
 * are skipped (Include expansion is doc-09 bridge work - registered).
 * `sshCommand` re-invokes the alias so OpenSSH re-applies the user's own
 * options (HostName/user come along for free).
 */
import { parseSshCommand } from './desktopSsh.ts';

export interface SshImportCandidate {
  host: string;
  pattern: boolean;
  source: string;
  sshCommand: string;
}

const GLOB = /[*?!]/u;

function tokenizeConfig(text: string): Array<{ key: string; value: string }> {
  const tokens: Array<{ key: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eqAt = line.indexOf('=');
    const spaceAt = line.search(/\s/u);
    const keyCut = (eqAt !== -1 && (spaceAt === -1 || eqAt < spaceAt)) ? eqAt : spaceAt;
    if (keyCut === -1) continue;
    tokens.push({ key: line.slice(0, keyCut).toLowerCase(), value: line.slice(keyCut + 1).trim() });
  }
  return tokens;
}

export function parseSshConfig(text: string, source = '~/.ssh/config'): SshImportCandidate[] {
  const candidates: SshImportCandidate[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeConfig(text)) {
    if (token.key !== 'host') continue;
    for (const alias of token.value.split(/\s+/u).filter((entry) => entry !== '')) {
      if (alias === '*') continue;
      if (seen.has(alias)) continue;
      seen.add(alias);
      candidates.push({
        host: alias,
        pattern: GLOB.test(alias),
        source,
        sshCommand: `ssh ${alias}`,
      });
    }
  }
  return candidates.filter((row) => importCandidateIsUseable(row) || row.pattern);
}

/** Bridge-guarded read: the desktop shell hands us the config text. */
export interface SshConfigReader {
  readSshConfig(): Promise<string>;
}

export async function desktopSshImportHosts(reader: SshConfigReader): Promise<SshImportCandidate[]> {
  const text = await reader.readSshConfig();
  if (typeof text !== 'string' || text.trim() === '') return [];
  return parseSshConfig(text);
}

/** Included so the store can validate a row before offering it. */
export function importCandidateIsUseable(row: SshImportCandidate): boolean {
  return parseSshCommand(row.sshCommand).destination !== null;
}
