// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_FILES = 32;
const MAX_TOTAL_BYTES = 1_048_576;
const MAX_INCLUDE_DEPTH = 8;
// Include directives are user supplied input. File/depth bounds alone still
// allow a 1 MiB config to issue tens of thousands of filesystem glob queries.
const MAX_INCLUDE_PATTERNS = 128;
const MAX_INCLUDE_MATCHES = 128;

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameFile(left, right) {
  // Fail closed when the platform cannot provide stable file identity. A
  // descriptor opened through a raced symlink must not inherit the path's
  // earlier containment check.
  return Number.isSafeInteger(left.ino) && left.ino > 0
    && Number.isSafeInteger(right.ino) && right.ino > 0
    && left.ino === right.ino && left.dev === right.dev;
}

function includeValues(line) {
  const match = /^\s*include(?:\s+|=)(.*)$/iu.exec(line);
  if (!match) return [];
  const tokens = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < match[1].length; index += 1) {
    const char = match[1][index];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") {
      const next = match[1][index + 1];
      if (next && (/\s/u.test(next) || next === '"' || next === "'" || next === '\\')) escaped = true;
      else current += char;
      continue;
    }
    if (quote) { if (char === quote) quote = ''; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') break;
    if (/\s/u.test(char)) { if (current) tokens.push(current); current = ''; continue; }
    current += char;
  }
  if (current) tokens.push(current);
  return quote || escaped ? [] : tokens;
}

/** Read bounded user SSH config files and expand only includes inside home. */
export async function readDesktopSshConfigTree({ homeDir = os.homedir(), fileSystem = fs } = {}) {
  let home;
  try { home = fileSystem.realpathSync(homeDir); }
  catch { return ''; }
  const rootFile = path.join(home, '.ssh', 'config');
  const visited = new Set();
  const collected = [];
  let totalBytes = 0;
  let includePatterns = 0;
  let includeMatches = 0;

  async function visit(candidate, depth) {
    if (depth > MAX_INCLUDE_DEPTH || visited.size >= MAX_FILES) return;
    try { if (fileSystem.lstatSync(candidate).isSymbolicLink()) return; }
    catch { return; }
    let resolved;
    try { resolved = fileSystem.realpathSync(candidate); }
    catch { return; }
    if (!inside(home, resolved) || visited.has(resolved)) return;
    let descriptor;
    let text;
    try {
      // Open without following a final symlink where the platform supports it,
      // then enforce the byte budget while reading so a concurrently growing
      // file cannot exceed the cap after a prior stat check.
      const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0;
      descriptor = fileSystem.openSync(resolved, fileSystem.constants.O_RDONLY | noFollow);
      const stat = fileSystem.fstatSync(descriptor);
      // O_NOFOLLOW is not available on every supported platform (notably
      // Windows). Re-resolve and compare descriptor identity to close the
      // check/open race before accepting any bytes.
      const currentPath = fileSystem.realpathSync(resolved);
      if (!inside(home, currentPath) || !sameFile(stat, fileSystem.statSync(currentPath))) return;
      if (!stat.isFile() || stat.size < 0 || totalBytes + stat.size > MAX_TOTAL_BYTES) return;
      const chunks = [];
      let bytesRead = 0;
      const limit = MAX_TOTAL_BYTES - totalBytes;
      while (bytesRead <= limit) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, limit - bytesRead + 1));
        const count = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        chunks.push(buffer.subarray(0, count));
        bytesRead += count;
      }
      if (bytesRead > limit) return;
      text = Buffer.concat(chunks).toString('utf8');
    } catch { return; }
    finally { if (descriptor !== undefined) { try { fileSystem.closeSync(descriptor); } catch {} } }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (totalBytes + bytes > MAX_TOTAL_BYTES) return;
    visited.add(resolved);
    totalBytes += bytes;
    collected.push(text);
    for (const line of text.split(/\r?\n/u)) {
      for (let pattern of includeValues(line)) {
        if (includePatterns >= MAX_INCLUDE_PATTERNS) return;
        includePatterns += 1;
        if (pattern === '~') pattern = home;
        else if (pattern.startsWith('~/')) pattern = path.join(home, pattern.slice(2));
        else if (!path.isAbsolute(pattern)) pattern = path.resolve(path.dirname(resolved), pattern);
        // Node's glob matcher treats backslash as an escape; on Windows it is
        // a path separator in OpenSSH config, so normalize before expansion.
        const globPattern = process.platform === 'win32' ? pattern.replace(/\\/gu, '/') : pattern;
        let matches;
        try { matches = fileSystem.promises.glob(globPattern, { windowsPathsNoEscape: true }); }
        catch { continue; }
        try {
          for await (const match of matches) {
            if (includeMatches >= MAX_INCLUDE_MATCHES) return;
            includeMatches += 1;
            await visit(match, depth + 1);
          }
        } catch { /* A bad or unreadable include should not abort other config. */ }
      }
    }
  }

  await visit(rootFile, 0);
  return collected.join('\n');
}
