// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../ids.js';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const MAX_DOCUMENT_BYTES = 262_144;
const MAX_CATALOG_BYTES = 2_097_152;

export class GuidanceCatalog {
  constructor(root = DEFAULT_ROOT) {
    this.inputRoot = root;
    this.root = null;
    this.documents = new Map();
  }

  async initialize() {
    this.root = await realpath(this.inputRoot);
    const paths = await markdownFiles(this.root);
    let total = 0;
    for (const path of paths.slice(0, 64)) {
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_DOCUMENT_BYTES) continue;
      total += info.size;
      if (total > MAX_CATALOG_BYTES) throw new ContractError('guidance_catalog_too_large', 'packaged guidance exceeds bound');
      const id = relative(this.root, path).split(sep).join('/').replace(/\.md$/u, '');
      const content = await readFile(path, 'utf8');
      this.documents.set(id, Object.freeze({ id, path: `docs/${id}.md`, content, tokens: tokenize(`${id} ${content}`) }));
    }
    if (this.documents.size === 0) throw new ContractError('guidance_missing', 'packaged NNA guidance is unavailable');
  }

  search(query, limit = 5) {
    const terms = tokenize(query);
    if (terms.length === 0) throw new ContractError('guidance_query_invalid', 'guidance query requires searchable words');
    return [...this.documents.values()]
      .map((document) => ({ document, score: scoreDocument(document, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id))
      .slice(0, limit)
      .map(({ document, score }) => ({
        id: document.id, path: document.path, score,
        excerpt: excerptFor(document.content, terms),
      }));
  }

  read(id) {
    const document = this.documents.get(id);
    if (!document) throw new ContractError('guidance_document_missing', `NNA guidance document ${id} was not found`);
    return document;
  }
}

async function markdownFiles(root) {
  const found = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.shift();
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
    }
  }
  return found;
}

function tokenize(value) {
  return [...new Set(String(value).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,63}/gu) ?? [])];
}

function scoreDocument(document, terms) {
  const id = document.id.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (id.includes(term)) score += 12;
    const occurrences = document.tokens.filter((token) => token === term || token.includes(term)).length;
    score += Math.min(occurrences, 8);
  }
  return score;
}

function excerptFor(content, terms) {
  const lower = content.toLowerCase();
  let index = terms.map((term) => lower.indexOf(term)).filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? 0;
  index = Math.max(0, index - 180);
  const excerpt = content.slice(index, index + 700).replace(/\s+/gu, ' ').trim();
  return `${index > 0 ? '…' : ''}${excerpt}${index + 700 < content.length ? '…' : ''}`;
}
