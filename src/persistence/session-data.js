// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, requireExternalId } from '../ids.js';

export class SessionDataManager {
  constructor(options) {
    this.sessionRoot = options.sessionRoot;
    this.reviewerRoot = options.reviewerRoot;
    this.diagnosticsRoot = options.diagnosticsRoot ?? null;
  }

  async preview(sessionId) {
    requireExternalId(sessionId, 'session_id');
    const paths = await candidatePaths(this, sessionId);
    const categories = [];
    for (const item of paths) {
      const { category, path } = item;
      const details = path ? await safeStat(path) : null;
      categories.push({ category, path, exists: details !== null, bytes: details?.size ?? null,
        disposition: item.disposition ?? null, deletable: item.deletable !== false });
    }
    return Object.freeze({ session_id: sessionId, categories, cloud_provider_data: 'outside_nna_control' });
  }

  async exportRedacted(sessionId, path) {
    const preview = await this.preview(sessionId);
    const paths = await candidatePaths(this, sessionId);
    const transcript = paths.find((item) => item.category === 'transcript')?.path;
    const reviewer = paths.find((item) => item.category === 'reviewer_ledger')?.path;
    const records = await redactedRecords(transcript);
    const reviewerRecords = await redactedRecords(reviewer);
    const bundle = {
      format: 1, created_at: new Date().toISOString(), preview, redacted: true,
      records, reviewer_records: reviewerRecords,
    };
    await writeExclusive(path, JSON.stringify(bundle, null, 2));
    return Object.freeze({ path, records: records.length, redacted: true });
  }

  async deleteToTrash(sessionId, confirmation) {
    if (confirmation !== `delete:${sessionId}`) {
      throw new ContractError('deletion_confirmation_required', 'exact session deletion confirmation is required');
    }
    const preview = await this.preview(sessionId);
    const lock = preview.categories.find((item) => item.category === 'lock');
    if (lock?.exists) throw new ContractError('session_locked', 'an attached or stale session lock requires inspection before deletion');
    const trash = join(this.sessionRoot, '.trash', `${sessionId}.${Date.now()}.${randomUUID()}`);
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const moved = [];
    const incomplete = [];
    for (const item of preview.categories.filter((entry) => entry.exists && entry.category !== 'lock' && entry.deletable)) {
      try {
        const safeCategory = item.category.replaceAll(/[^A-Za-z0-9_.-]/gu, '_');
        const target = join(trash, `${safeCategory}-${basename(item.path)}`);
        await rename(item.path, target); moved.push({ category: item.category, target });
      } catch (error) { incomplete.push({ category: item.category, code: error.code ?? 'move_failed' }); }
    }
    for (const item of preview.categories.filter((entry) => entry.exists && !entry.deletable)) {
      incomplete.push({ category: item.category, code: item.disposition ?? 'shared_data_retained' });
    }
    return Object.freeze({ session_id: sessionId, recoverable_trash: trash, moved, incomplete });
  }
}

async function candidatePaths(manager, id) {
  const transcriptName = `${id}.journal.ndjson`;
  const reviewerName = `${id}.review.journal.ndjson`;
  const result = [
    { category: 'transcript', path: join(manager.sessionRoot, transcriptName) },
    { category: 'lock', path: join(manager.sessionRoot, `${id}.lock`) },
    { category: 'attachments', path: join(manager.sessionRoot, 'attachments', id) },
    { category: 'reviewer_ledger', path: join(manager.reviewerRoot, reviewerName) },
  ];
  result.push(...await derivedPaths(manager.sessionRoot, transcriptName, 'transcript_derived'));
  result.push(...await derivedPaths(manager.reviewerRoot, reviewerName, 'reviewer_derived'));
  result.push({
    category: 'diagnostics', path: manager.diagnosticsRoot,
    disposition: manager.diagnosticsRoot ? 'shared_metadata_retained' : 'not_configured', deletable: false,
  });
  result.push({ category: 'derived_indexes_and_caches', path: null, disposition: 'none_materialized_by_core', deletable: false });
  result.push({ category: 'memory', path: null, disposition: 'external_adapter_lifecycle', deletable: false });
  return result;
}

async function derivedPaths(root, base, category) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.startsWith(`${base}.`) && name !== `${base}.lock`)
    .map((name) => ({ category: `${category}:${name.slice(base.length + 1)}`, path: join(root, name) }));
}

async function safeStat(path) {
  try { return await stat(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readBounded(path, limit) {
  const details = await stat(path);
  if (details.size > limit) throw new ContractError('export_too_large', 'session export exceeds bound');
  return readFile(path, 'utf8');
}

async function redactedRecords(path) {
  if (!path) return [];
  let journal;
  try { journal = await readBounded(path, 104_857_600); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return journal.split(/\r?\n/u).filter(Boolean).slice(0, 1_000_000).map(redactLine);
}

function redactLine(line) {
  let record;
  try { record = JSON.parse(line); } catch { return { omitted: true, reason: 'malformed_record' }; }
  return redactSecrets(redactContent(record));
}

function redactContent(value, key = '') {
  if (/^(?:content|text|summary|prompt)$/iu.test(key)) return '[redacted content]';
  if (Array.isArray(value)) return value.map((item) => redactContent(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactContent(item, name)]));
  }
  return value;
}

function redactSecrets(value) {
  const encoded = JSON.stringify(value);
  return JSON.parse(encoded.replaceAll(
    /(?:bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[=:]\s*[^"\s]+)/giu,
    '[redacted secret]',
  ));
}

async function writeExclusive(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { flag: 'wx', mode: 0o600 });
}
