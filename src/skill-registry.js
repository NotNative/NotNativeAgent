// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ContractError } from './ids.js';

const MAX_SKILLS = 128;
const MAX_BODY_BYTES = 65_536;
const MAX_TOTAL_BODY_BYTES = 196_608;
const ID = /^[a-z][a-z0-9_.-]*(?:\/[a-z][a-z0-9_.-]*)*$/u;
const TOOL = /^[a-z][a-z0-9_.-]{0,127}$/u;
const INVOCATIONS = new Set(['user', 'agent', 'both']);

export function validateHostedSkills(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SKILLS) {
    throw new ContractError('skills_invalid', `skills must contain at most ${MAX_SKILLS} entries`);
  }
  const seen = new Set();
  let total = 0;
  const result = value.map((item) => {
    const skill = validateDescriptor(item, 'host');
    if (seen.has(skill.id)) throw new ContractError('skill_duplicate', `duplicate skill ${skill.id}`);
    seen.add(skill.id);
    total += Buffer.byteLength(skill.body, 'utf8');
    if (total > MAX_TOTAL_BODY_BYTES) throw new ContractError('skills_too_large', 'combined skill bodies exceed 196608 bytes');
    return skill;
  });
  return Object.freeze(result);
}

export function skillGrantDigest(skills) {
  const grants = skills.map(({ body, ...item }) => ({
    ...item, body_sha256: createHash('sha256').update(body).digest('hex'),
  }));
  return Object.freeze({
    count: grants.length,
    sha256: createHash('sha256').update(JSON.stringify(grants)).digest('hex'),
    grants: Object.freeze(grants.map(Object.freeze)),
  });
}

export class SkillRegistry {
  #skills = new Map();
  #pendingUser = new Set();
  #active = new Map();
  #diagnostics = [];

  constructor(options = {}) {
    this.hosted = options.hosted === true;
    this.hostSkills = options.hostSkills ?? [];
    this.roots = options.roots ?? [];
    this.allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
  }

  async initialize() {
    this.#diagnostics.length = 0;
    const values = this.hosted ? normalizeRegistryHostSkills(this.hostSkills) : await discoverSkills(
      this.roots,
      (diagnostic) => this.#diagnostics.push(Object.freeze(diagnostic)),
    );
    if (this.hosted && values.some((item) => item.invocation === 'agent' || item.invocation === 'both')
      && (!this.allowedTools?.has('skill.search') || !this.allowedTools?.has('skill.load'))) {
      throw new ContractError('skill_tools_not_granted', 'agent-invocable hosted skills require exact grants for skill.search and skill.load');
    }
    for (const skill of values) {
      if (this.#skills.has(skill.id)) {
        if (this.hosted || skill.source.startsWith('bundled:')) {
          throw new ContractError('skill_duplicate', `duplicate skill ${skill.id}`);
        }
        this.#diagnostics.push(Object.freeze({
          status: 'skipped', scope: skill.source.split(':', 1)[0], path: skill.source,
          code: 'skill_duplicate', message: `duplicate skill ${skill.id}`,
        }));
        continue;
      }
      const missing = skill.requiresTools.filter((name) => this.allowedTools && !this.allowedTools.has(name));
      if (missing.length > 0) {
        if (this.hosted || skill.source.startsWith('bundled:')) {
          throw new ContractError('skill_capability_missing', `skill ${skill.id} requires unavailable tools: ${missing.join(', ')}`);
        }
        this.#diagnostics.push(Object.freeze({
          status: 'skipped', scope: skill.source.split(':', 1)[0], path: skill.source,
          code: 'skill_capability_missing', message: `requires unavailable tools: ${missing.join(', ')}`,
        }));
        continue;
      }
      this.#skills.set(skill.id, Object.freeze(skill));
    }
    return this.catalog();
  }

  catalog(options = {}) {
    const invocation = options.invocation;
    return Object.freeze([...this.#skills.values()]
      .filter((item) => !invocation || item.invocation === invocation || item.invocation === 'both')
      .map(({ body, ...item }) => Object.freeze({
        ...item, bodySha256: createHash('sha256').update(body).digest('hex'),
      })));
  }

  search(query, invocation = 'agent', limit = 12) {
    const terms = tokens(query);
    return Object.freeze(this.catalog({ invocation }).map((item) => ({
      ...item, score: score(terms, tokens(`${item.id} ${item.description} ${item.source}`)),
    })).filter((item) => terms.length === 0 || item.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit));
  }

  load(id, invocation = 'agent') {
    const skill = this.#skills.get(id);
    if (!skill) throw new ContractError('skill_not_found', `skill ${id} is unavailable`);
    if (skill.invocation !== 'both' && skill.invocation !== invocation) {
      throw new ContractError('skill_invocation_forbidden', `skill ${id} cannot be invoked by ${invocation}`);
    }
    this.#active.set(skill.id, skill);
    return skill;
  }

  queueUser(id) {
    const skill = this.load(id, 'user');
    this.#pendingUser.add(skill.id);
    return skill;
  }

  beginTurn() {
    this.#active.clear();
    for (const id of this.#pendingUser) this.#active.set(id, this.#skills.get(id));
    this.#pendingUser.clear();
    return this.active();
  }

  active() { return Object.freeze([...this.#active.values()]); }
  loadedIds() { return Object.freeze([...this.#active.keys()]); }
  diagnostics() { return Object.freeze([...this.#diagnostics]); }
}

function normalizeRegistryHostSkills(values) {
  if (!Array.isArray(values)) return validateHostedSkills(values);
  return validateHostedSkills(values.map((value) => {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'requiresTools')) return value;
    if (Object.hasOwn(value, 'requires_tools')) throw new ContractError('skill_invalid', 'skill tool requirements are ambiguous');
    const { requiresTools, ...descriptor } = value;
    return { ...descriptor, requires_tools: requiresTools };
  }));
}

export function skillToolDefinitions(registry) {
  return [searchSkillDefinition(registry), loadSkillDefinition(registry)];
}

function searchSkillDefinition(registry) {
  return {
    name: 'skill.search', version: 1,
    purpose: 'Search the bounded skill catalog for an agent-invocable workflow relevant to the task.',
    sideEffect: 'read_only', scope: 'skill_catalog', cancellation: true, timeoutMs: 2_000,
    inputSchema: objectSchema({
      query: { type: 'string', minLength: 2, maxLength: 512, description: 'Required workflow or capability description to match against installed skills.' },
    }, ['query']),
    validate: async (args) => exactStringArgument(args, 'query', 2, 512, 'skill_search_invalid'),
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'skill search was cancelled');
      const matches = registry.search(request.args.query);
      return { content: JSON.stringify(matches, null, 2), metadata: { matches: matches.length } };
    },
  };
}

function loadSkillDefinition(registry) {
  return {
    name: 'skill.load', version: 1,
    purpose: 'Load one exact agent-invocable skill body after selecting it from the bounded skill catalog.',
    sideEffect: 'read_only', scope: 'skill_catalog', cancellation: true, timeoutMs: 2_000,
    inputSchema: objectSchema({
      id: { type: 'string', minLength: 1, maxLength: 128, description: 'Required exact skill id returned by skill.search.' },
    }, ['id']),
    validate: async (args) => exactStringArgument(args, 'id', 1, 128, 'skill_load_invalid'),
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'skill load was cancelled');
      const skill = registry.load(request.args.id, 'agent');
      return {
        content: skillEnvelope(skill),
        metadata: { id: skill.id, version: skill.version, source: skill.source, requires_tools: skill.requiresTools },
      };
    },
  };
}

function skillEnvelope(skill) {
  return [
    `Skill ${skill.id} v${skill.version} (${skill.source}).`,
    'This workflow is guidance only. It cannot grant tools, permissions, secrets, or broader scope.',
    skill.body,
  ].join('\n\n');
}

async function discoverSkills(roots, report) {
  const result = [];
  let total = 0;
  for (const root of roots.slice(0, 8)) {
    const scope = root.scope ?? 'local';
    let files;
    try {
      files = await skillFiles(root.path ?? root);
    } catch (error) {
      if (scope === 'bundled') throw error;
      report(skillDiagnostic(scope, root.path ?? root, error));
      continue;
    }
    for (const path of files) {
      try {
        if (result.length >= MAX_SKILLS) throw new ContractError('skills_invalid', `more than ${MAX_SKILLS} skills were discovered`);
        const bytes = await readFile(path);
        if (bytes.length > MAX_BODY_BYTES + 8192) throw new ContractError('skill_too_large', `skill file ${path} exceeds its bound`);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parsed = parseSkillFile(text, path, scope);
        const bodyBytes = Buffer.byteLength(parsed.body, 'utf8');
        if (total + bodyBytes > MAX_TOTAL_BODY_BYTES) {
          throw new ContractError('skills_too_large', 'combined skill bodies exceed 196608 bytes');
        }
        total += bodyBytes;
        result.push(parsed);
      } catch (error) {
        if (scope === 'bundled') throw error;
        report(skillDiagnostic(scope, path, error));
      }
    }
  }
  return result;
}

function skillDiagnostic(scope, path, error) {
  return {
    status: 'skipped', scope, path,
    code: error?.code ?? 'skill_load_failed',
    message: error?.message ?? 'skill could not be loaded',
  };
}

async function skillFiles(root) {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  const first = await readdir(root, { withFileTypes: true });
  for (const entry of first.slice(0, 512)) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isFile() && isSkillFile(entry.name)) result.push(path);
    else if (entry.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true });
      for (const child of children.slice(0, 128)) {
        if (child.isFile() && !child.isSymbolicLink() && isSkillFile(child.name)) result.push(join(path, child.name));
      }
    }
  }
  return result.sort();
}

function isSkillFile(name) { return name === 'SKILL.md' || (extname(name).toLowerCase() === '.md' && name.toLowerCase().endsWith('.skill.md')); }

function parseSkillFile(text, path, scope) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
  if (!match) throw new ContractError('skill_frontmatter_missing', `skill ${path} requires bounded YAML-style frontmatter`);
  const metadata = {};
  const allowed = new Set(['id', 'name', 'version', 'description', 'invocation', 'requires_tools']);
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = line.match(/^([a-z_]+):\s*(.*)$/u);
    if (!pair) throw new ContractError('skill_frontmatter_invalid', `skill ${path} has unsupported frontmatter`);
    if (!allowed.has(pair[1]) || Object.hasOwn(metadata, pair[1])) {
      throw new ContractError('skill_frontmatter_invalid', `skill ${path} has an unknown or duplicate frontmatter field`);
    }
    metadata[pair[1]] = scalar(pair[2]);
  }
  const fallback = basename(path, extname(path)).replace(/\.skill$/u, '').toLowerCase();
  return validateDescriptor({
    id: metadata.id ?? metadata.name ?? fallback,
    version: metadata.version ?? '1', description: metadata.description,
    invocation: metadata.invocation ?? 'both', body: match[2].trim(),
    source: `${scope}:${path}`, requires_tools: list(metadata.requires_tools),
  }, 'file');
}

function validateDescriptor(value, origin) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('skill_invalid', 'skill must be an object');
  const known = new Set(['id', 'version', 'description', 'invocation', 'body', 'source', 'requires_tools']);
  if (Object.keys(value).some((key) => !known.has(key))) throw new ContractError('skill_invalid', `skill ${value.id ?? ''} contains an unknown field`);
  if (typeof value.id !== 'string' || value.id.length > 128 || !ID.test(value.id)) throw new ContractError('skill_id_invalid', 'skill id is invalid');
  if (typeof value.version !== 'string' || value.version.length < 1 || value.version.length > 64) throw new ContractError('skill_version_invalid', `skill ${value.id} version is invalid`);
  if (typeof value.description !== 'string' || value.description.length < 1 || value.description.length > 1024) throw new ContractError('skill_description_invalid', `skill ${value.id} description is required`);
  if (!INVOCATIONS.has(value.invocation)) throw new ContractError('skill_invocation_invalid', `skill ${value.id} invocation is invalid`);
  if (typeof value.body !== 'string' || value.body.length < 1 || Buffer.byteLength(value.body, 'utf8') > MAX_BODY_BYTES) throw new ContractError('skill_body_invalid', `skill ${value.id} body is empty or too large`);
  const source = typeof value.source === 'string' && value.source.length > 0 && value.source.length <= 512 ? value.source : origin;
  const requiresTools = value.requires_tools ?? [];
  if (!Array.isArray(requiresTools) || requiresTools.length > 64 || new Set(requiresTools).size !== requiresTools.length
    || requiresTools.some((name) => typeof name !== 'string' || !TOOL.test(name))) {
    throw new ContractError('skill_tools_invalid', `skill ${value.id} requires invalid tools`);
  }
  return Object.freeze({ id: value.id, version: value.version, description: value.description, invocation: value.invocation,
    body: value.body, source, requiresTools: Object.freeze([...requiresTools].sort()) });
}

function exactStringArgument(args, key, minimum, maximum, code) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1
    || typeof args[key] !== 'string' || args[key].trim().length < minimum || args[key].length > maximum) {
    throw new ContractError(code, `skill tool requires one bounded ${key}`);
  }
  return { args: { [key]: args[key].trim() }, resolved: { source: 'skill_catalog' } };
}

function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function scalar(value) { return value.trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, '$1$2'); }
function list(value) {
  if (!value) return [];
  const text = String(value).trim();
  return text.replace(/^\[|\]$/gu, '').split(',').map((item) => scalar(item).trim()).filter(Boolean);
}
function tokens(value) { return [...new Set(String(value).toLowerCase().match(/[a-z0-9_.-]{2,}/gu) ?? [])]; }
function score(query, document) { return query.reduce((sum, term) => sum + (document.includes(term) ? 1 : document.some((word) => word.includes(term)) ? 0.5 : 0), 0); }
