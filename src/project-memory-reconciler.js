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
const MAX_PROJECT_MEMORY_ITEMS = 64;
const MAX_PROJECT_MEMORY_ITEM_BYTES = 512;
const MAX_EVIDENCE_REFS = 64;
const MAX_EVIDENCE_REF_LENGTH = 160;

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

export function explicitProjectKnowledge(records, turnRefs) {
  const allowed = new Set(Array.isArray(turnRefs) ? turnRefs : []);
  const found = [];
  for (const record of records ?? []) {
    if (record?.type !== 'message' || record.role !== 'user' || record.trust !== 'operator'
        || !allowed.has(record.turnId) || typeof record.content !== 'string') continue;
    for (const statement of projectKnowledgeStatements(record.content)) {
      if (secretLike(statement) || Buffer.byteLength(statement, 'utf8') > MAX_PROJECT_MEMORY_ITEM_BYTES) continue;
      found.push(Object.freeze({ turnId: record.turnId, statement, section: decisionSection(statement) }));
      if (found.length >= MAX_PROJECT_MEMORY_ITEMS) return Object.freeze(found);
    }
  }
  return Object.freeze(found);
}

// Retained for integrations that imported the original narrow extractor.
export const explicitProjectDecisions = explicitProjectKnowledge;

export function projectMemoryCandidate(proposal, evidenceRefs = proposal.evidence_refs) {
  return Object.freeze({
    schema: 'notnative.learning-candidate/1.0', destination: 'project_memory',
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

function projectKnowledgeStatements(content) {
  const normalized = content.replace(/\r\n?/gu, '\n').split(/\n+|(?<=[.!?])\s+(?=[A-Z])/u)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').trim())
    .filter(Boolean);
  return normalized.filter((line) => durableProjectStatement(line));
}

function durableProjectStatement(line) {
  if (line.endsWith('?') || !PROJECT_SUBJECT.test(line)) return false;
  if (EXPLICIT_DECISION.test(line)) return true;
  return PROJECT_RULE.test(line) || PROJECT_STATE.test(line);
}

function decisionSection(statement) {
  if (/\b(?:bug|broken|problem|issue|failure|missing)\b/iu.test(statement)) return 'Known problems';
  if (/\b(?:later|future|eventually|backlog|defer|shelve|unresolved)\b/iu.test(statement)) return 'Unresolved work';
  if (/^(?:from now on|always\b|never\b)/iu.test(statement)) return 'Working conventions';
  if (EXPLICIT_DECISION.test(statement)) return 'Decisions and rationale';
  if (/\b(?:architecture|topology|design|engine|component|provider|model|routing|storage|schema|owns?|integration|contract)\b/iu.test(statement)) return 'Current architecture';
  if (/\b(?:path|directory|folder|file|runtime|platform|host|endpoint|configured|installed)\b/iu.test(statement)) return 'Verified environment';
  return 'Working conventions';
}

function replaceManaged(content, managed) {
  if (typeof managed !== 'string') throw new ContractError('project_memory_region_invalid', 'managed project memory must be text');
  const bounds = managedBounds(content);
  if (!bounds) {
    if (content.length === 0) return `${managed}\n`;
    const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${separator}${managed}\n`;
  }
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
  if (!Array.isArray(value) || value.length > MAX_PROJECT_MEMORY_ITEMS) throw new ContractError('project_memory_sections_invalid', `each project-memory section must be an array of at most ${MAX_PROJECT_MEMORY_ITEMS} items`);
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0
      || Buffer.byteLength(item, 'utf8') > MAX_PROJECT_MEMORY_ITEM_BYTES || /[\r\n]/u.test(item)) {
      throw new ContractError('project_memory_item_invalid', 'project-memory items must be bounded single-line text');
    }
    if (secretLike(item)) throw new ContractError('project_memory_secret_forbidden', 'project memory may not contain secret material');
    const trimmed = item.trim();
    const identity = semanticIdentity(trimmed);
    if (!items.some((existing) => semanticIdentity(existing) === identity)) items.push(trimmed);
  }
  return items;
}

function boundedRefs(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_REFS) throw new ContractError('project_memory_evidence_required', 'project-memory proposals require evidence references');
  return Object.freeze([...new Set(value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_EVIDENCE_REF_LENGTH) throw new ContractError('project_memory_evidence_invalid', 'project-memory evidence reference is invalid');
    return item;
  }))]);
}

function indexes(content, marker) {
  const result = []; let offset = 0;
  while ((offset = content.indexOf(marker, offset)) !== -1) { result.push(offset); offset += marker.length; }
  return result;
}
function secretLike(value) {
  return /-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b(?:password|passwd|api[_-]?key|apikey|token|secret)\s*[:=]|\bAKIA[A-Z0-9]{16}\b|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/iu.test(value);
}
const PROJECT_SUBJECT = /\b(?:NNA|NotNativeAgent|agent|harness|runtime|engine|repository|repo|project|workspace|source|code|docs?|tests?|config(?:uration)?|installer|command|tool|hook|provider|model|routing|module|package|schema|API|UI|TUI|GUI|file|folder|directory|path|release|build|deployment)\b/iu;
const EXPLICIT_DECISION = /^(?:decision\s*:|we (?:decided|agreed|will|must|should|need to)|i (?:decided|want|need|prefer|would like)|let(?:'|\u2019)s|from now on|always\b|never\b)/iu;
const PROJECT_RULE = /\b(?:must|should|shall|always|never|is required to|needs? to|prefer(?:s|red)?|convention|policy|standard|rule|owned by|belongs? to)\b/iu;
const PROJECT_STATE = /\b(?:is|are|uses?|contains?|lives?|located|configured|installed|routes?|stores?|loads?|exposes?|supports?)\b/iu;
function semanticIdentity(value) {
  return value.toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
