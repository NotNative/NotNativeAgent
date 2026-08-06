// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

export const MANAGED_START = '<!-- nna:managed:start -->';
export const MANAGED_END = '<!-- nna:managed:end -->';
const SECTIONS = Object.freeze([
  'Current architecture', 'Decisions and rationale', 'Working conventions',
  'Verified environment', 'Known problems', 'Unresolved work',
]);

export class ProjectMemoryReconciler {
  constructor(workspaceRoot, options = {}) {
    this.path = join(workspaceRoot, 'NNA.md');
    this.maximumBytes = options.maximumBytes ?? 32_768;
    this.read = options.read ?? readFile;
    this.stat = options.stat ?? lstat;
  }

  async propose(input) {
    const snapshot = await this.#snapshot();
    return this.#proposal(snapshot, input);
  }

  async proposeAppend(input) {
    const snapshot = await this.#snapshot();
    const existing = snapshot.region ? parseManagedRegion(snapshot.region) : {};
    const sections = {};
    for (const section of SECTIONS) {
      sections[section] = [...(existing[section] ?? []), ...(input.sections?.[section] ?? [])];
    }
    return this.#proposal(snapshot, { ...input, sections });
  }

  #proposal(snapshot, input) {
    const managed = managedRegion(input.sections);
    const content = replaceManaged(snapshot.content, managed);
    if (Buffer.byteLength(content, 'utf8') > this.maximumBytes) {
      throw new ContractError('project_memory_too_large', 'proposed NNA.md exceeds the managed project-memory limit');
    }
    return Object.freeze({
      path: this.path, exists: snapshot.exists, expected_hash: snapshot.hash,
      proposed_hash: digest(content), old_region: snapshot.region, new_region: managed,
      content, evidence_refs: boundedRefs(input.evidenceRefs),
    });
  }

  async #snapshot() {
    try {
      const info = await this.stat(this.path);
      if (info.isSymbolicLink()) throw new ContractError('project_memory_symlink_forbidden', 'managed project memory cannot target a symbolic link');
      if (!info.isFile()) throw new ContractError('project_memory_target_invalid', 'NNA.md is not a regular file');
      if (info.size > this.maximumBytes) throw new ContractError('project_memory_too_large', 'existing NNA.md exceeds the managed project-memory limit');
      const content = await this.read(this.path, 'utf8');
      return { exists: true, content, hash: digest(content), region: extractManaged(content) };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return { exists: false, content: '', hash: null, region: null };
    }
  }
}

export function explicitProjectDecisions(records, turnRefs) {
  const allowed = new Set(Array.isArray(turnRefs) ? turnRefs : []);
  const found = [];
  for (const record of records ?? []) {
    if (record?.type !== 'message' || record.role !== 'user' || record.trust !== 'operator'
        || !allowed.has(record.turnId) || typeof record.content !== 'string') continue;
    for (const statement of decisionStatements(record.content)) {
      if (secretLike(statement) || Buffer.byteLength(statement, 'utf8') > 512) continue;
      found.push(Object.freeze({ turnId: record.turnId, statement, section: decisionSection(statement) }));
      if (found.length >= 64) return Object.freeze(found);
    }
  }
  return Object.freeze(found);
}

export function projectMemoryCandidate(proposal, evidenceRefs = proposal.evidence_refs) {
  return Object.freeze({
    kind: 'guidance.project_memory', confidence: 1, evidenceRefs,
    expectedBenefit: 'Preserve verified durable project knowledge for future turns.',
    successCriteria: [
      'The managed NNA.md region matches the proposed content fingerprint.',
      'User-authored content outside the managed region remains byte-for-byte unchanged.',
    ],
    riskClass: 'reversible',
    payload: {
      target: proposal.path, expected_hash: proposal.expected_hash ?? 'new_file',
      proposed_hash: proposal.proposed_hash, old_region: proposal.old_region ?? '',
      new_region: proposal.new_region,
    },
  });
}

function managedRegion(sections) {
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new ContractError('project_memory_sections_invalid', 'project-memory sections must be an object');
  }
  const unknown = Object.keys(sections).filter((name) => !SECTIONS.includes(name));
  if (unknown.length > 0) throw new ContractError('project_memory_sections_invalid', `unsupported project-memory section: ${unknown[0]}`);
  const lines = [MANAGED_START];
  for (const section of SECTIONS) {
    const items = normalizeItems(sections[section] ?? []);
    if (items.length === 0) continue;
    lines.push(`## ${section}`, ...items.map((item) => `- ${item}`), '');
  }
  while (lines.at(-1) === '') lines.pop();
  lines.push(MANAGED_END);
  return lines.join('\n');
}

function parseManagedRegion(region) {
  const result = {}; let section = null;
  for (const line of region.split(/\r?\n/u)) {
    if (line.startsWith('## ')) {
      const name = line.slice(3).trim();
      section = SECTIONS.includes(name) ? name : null;
      if (section) result[section] ??= [];
    } else if (section && line.startsWith('- ')) result[section].push(line.slice(2));
  }
  return result;
}

function decisionStatements(content) {
  const normalized = content.replace(/\r\n?/gu, '\n').split(/\n+/u)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean);
  return normalized.filter((line) => /^(?:decision\s*:|we (?:decided|agreed|will|must|should|need to)|i (?:decided|want|need|prefer|would like)|let(?:'|’)s|from now on|always\b|never\b)/iu.test(line));
}

function decisionSection(statement) {
  if (/\b(?:bug|broken|problem|issue|failure|missing)\b/iu.test(statement)) return 'Known problems';
  if (/\b(?:later|future|eventually|backlog|defer|shelve|unresolved)\b/iu.test(statement)) return 'Unresolved work';
  if (/\b(?:architecture|design|engine|component|provider|model|routing|storage|schema)\b/iu.test(statement)) return 'Decisions and rationale';
  return 'Working conventions';
}

function replaceManaged(content, managed) {
  const bounds = managedBounds(content);
  if (!bounds) return content.length === 0 ? `${managed}\n` : `${content.replace(/\s*$/u, '')}\n\n${managed}\n`;
  return `${content.slice(0, bounds.start)}${managed}${content.slice(bounds.end)}`;
}

function extractManaged(content) {
  const bounds = managedBounds(content);
  return bounds ? content.slice(bounds.start, bounds.end) : null;
}

function managedBounds(content) {
  const starts = indexes(content, MANAGED_START), ends = indexes(content, MANAGED_END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new ContractError('project_memory_markers_invalid', 'NNA.md managed markers are missing, duplicated, or out of order');
  }
  return { start: starts[0], end: ends[0] + MANAGED_END.length };
}

function normalizeItems(value) {
  if (!Array.isArray(value) || value.length > 64) throw new ContractError('project_memory_sections_invalid', 'each project-memory section must be an array of at most 64 items');
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0 || Buffer.byteLength(item, 'utf8') > 512 || /[\r\n]/u.test(item)) {
      throw new ContractError('project_memory_item_invalid', 'project-memory items must be bounded single-line text');
    }
    if (secretLike(item)) throw new ContractError('project_memory_secret_forbidden', 'project memory may not contain secret material');
    if (!items.includes(item.trim())) items.push(item.trim());
  }
  return items;
}

function boundedRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) throw new ContractError('project_memory_evidence_required', 'project-memory proposals require evidence references');
  return Object.freeze([...new Set(value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 160) throw new ContractError('project_memory_evidence_invalid', 'project-memory evidence reference is invalid');
    return item;
  }))]);
}

function indexes(content, marker) {
  const result = []; let offset = 0;
  while ((offset = content.indexOf(marker, offset)) !== -1) { result.push(offset); offset += marker.length; }
  return result;
}
function secretLike(value) {
  return /-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:password|passwd|api[_-]?key|token|secret)\s*[:=]/iu.test(value);
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
