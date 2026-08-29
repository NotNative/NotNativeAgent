// SPDX-License-Identifier: Apache-2.0
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ToolRegistry } from '../src/tool-registry.js';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SOURCE_FILES = 2_000;
const TERM_ID = /^CTL-TERM-\d{3}$/u;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const REPORT_SCHEMA = 'nna.controlled-language-report.v1';
const UNQUALIFIED_BOUNDARY_FIELDS = new Set(['decision', 'result', 'status']);
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

export function validateTerminologyContract(contract) {
  const errors = [];
  if (!record(contract)) return Object.freeze(['terminology contract must be an object']);
  exact(contract, 'schema', 'nna.controlled-technical-language.v1', errors);
  exact(contract, 'standard', 'NNA-CTL/1', errors);
  const kinds = stringSet(contract.term_kinds, 'term_kinds', errors);
  stringSet(contract.model_facing_fields, 'model_facing_fields', errors);
  stringSet(contract.rationale_markers, 'rationale_markers', errors);
  const terms = array(contract.terms, 'terms', errors);
  const termIds = new Set(); const termNames = new Set(); const declaredIdentifiers = new Set();
  for (const [index, term] of terms.entries()) {
    validateTerm(term, index, { kinds, termIds, termNames, declaredIdentifiers }, errors);
  }
  validateDeprecated(contract.deprecated_identifiers, declaredIdentifiers, errors);
  return Object.freeze(errors);
}

export function scanJavaScriptIdentifiers(source) {
  const identifiers = [];
  const templateExpressions = [];
  let mode = 'code'; let index = 0;
  while (index < source.length) {
    const character = source[index]; const next = source[index + 1];
    if (mode === 'line-comment') { if (character === '\n') mode = 'code'; index += 1; continue; }
    if (mode === 'block-comment') {
      if (character === '*' && next === '/') { mode = 'code'; index += 2; } else index += 1;
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      if (character === '\\') index += 2;
      else { if ((mode === 'single' && character === "'") || (mode === 'double' && character === '"')) mode = 'code'; index += 1; }
      continue;
    }
    if (mode === 'template') {
      if (character === '\\') { index += 2; continue; }
      if (character === '`') { mode = 'code'; index += 1; continue; }
      if (character === '$' && next === '{') { templateExpressions.push(1); mode = 'code'; index += 2; continue; }
      index += 1; continue;
    }
    if (character === '/' && next === '/') { mode = 'line-comment'; index += 2; continue; }
    if (character === '/' && next === '*') { mode = 'block-comment'; index += 2; continue; }
    if (character === "'") { mode = 'single'; index += 1; continue; }
    if (character === '"') { mode = 'double'; index += 1; continue; }
    if (character === '`') { mode = 'template'; index += 1; continue; }
    if (templateExpressions.length > 0 && character === '{') templateExpressions[templateExpressions.length - 1] += 1;
    if (templateExpressions.length > 0 && character === '}') {
      const last = templateExpressions.length - 1;
      templateExpressions[last] -= 1;
      if (templateExpressions[last] === 0) { templateExpressions.pop(); mode = 'template'; }
      index += 1; continue;
    }
    if (identifierStart(character)) {
      let end = index + 1;
      while (identifierPart(source[end])) end += 1;
      identifiers.push(source.slice(index, end)); index = end; continue;
    }
    index += 1;
  }
  return Object.freeze(identifiers);
}

export function auditDeprecatedIdentifiers(contract, files) {
  const errors = []; const advisories = []; const counts = new Map();
  for (const item of contract.deprecated_identifiers ?? []) counts.set(item.identifier, 0);
  for (const file of files) {
    for (const identifier of scanJavaScriptIdentifiers(file.source)) {
      if (counts.has(identifier)) counts.set(identifier, counts.get(identifier) + 1);
    }
  }
  for (const item of contract.deprecated_identifiers ?? []) {
    const count = counts.get(item.identifier) ?? 0;
    if (count > item.baseline_occurrences) {
      errors.push(`${item.identifier} occurs ${count} times; baseline is ${item.baseline_occurrences}; use ${item.replacement}`);
    } else if (count < item.baseline_occurrences) {
      errors.push(`${item.identifier} improved to ${count} occurrences; lower its baseline from ${item.baseline_occurrences}`);
    } else if (count > 0) {
      advisories.push(`${item.identifier}: ${count} existing occurrences; prefer ${item.replacement}`);
    }
  }
  return Object.freeze({ errors: Object.freeze(errors), advisories: Object.freeze(advisories), counts });
}

export function auditModelFacingDefinitions(definitions) {
  const prose = [];
  const unqualified = [];
  for (const definition of definitions) {
    addProse(prose, definition.name, 'purpose', definition.purpose);
    addProse(prose, definition.name, 'providerFacade.description', definition.providerFacade?.description);
    inspectSchema(definition.inputSchema, definition.name, 'inputSchema', prose, unqualified);
  }
  const longProse = prose.filter((item) => item.words > 25)
    .sort((left, right) => right.words - left.words || left.tool.localeCompare(right.tool) || left.field.localeCompare(right.field));
  unqualified.sort((left, right) => left.tool.localeCompare(right.tool) || left.field.localeCompare(right.field));
  return Object.freeze({
    schema: REPORT_SCHEMA,
    standard: 'NNA-CTL/1',
    scope: 'maximal bundled tool registry; purpose, provider facade description, and input-schema description fields',
    stats: Object.freeze({
      tools: definitions.length, proseFields: new Set(prose.map((item) => `${item.tool}\0${item.field}`)).size,
      proseSentences: prose.length, longProseCandidates: longProse.length,
      unqualifiedBoundaryCandidates: unqualified.length,
      maximumSentenceWords: prose.reduce((maximum, item) => Math.max(maximum, item.words), 0),
    }),
    long_prose_candidates: Object.freeze(longProse),
    unqualified_boundary_candidates: Object.freeze(unqualified),
  });
}

export function countRationaleMarkers(markers, files) {
  const counts = Object.fromEntries(markers.map((marker) => [marker, 0]));
  const markerSet = new Set(markers);
  for (const file of files) {
    for (const line of file.source.split(/\r?\n/u)) {
      const match = /^\s*(?:\/\/|\/\*+|\*)\s*([A-Za-z]+):/u.exec(line);
      if (match && markerSet.has(match[1])) counts[match[1]] += 1;
    }
  }
  return Object.freeze(counts);
}

function inspectSchema(schema, tool, path, prose, unqualified) {
  if (!record(schema)) return;
  addProse(prose, tool, `${path}.description`, schema.description);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const field = `${path}.properties.${name}`;
    if (UNQUALIFIED_BOUNDARY_FIELDS.has(name)) unqualified.push(Object.freeze({ tool, field }));
    inspectSchema(property, tool, field, prose, unqualified);
  }
  if (schema.items) inspectSchema(schema.items, tool, `${path}.items`, prose, unqualified);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    for (const [index, branch] of (schema[keyword] ?? []).entries()) inspectSchema(branch, tool, `${path}.${keyword}[${index}]`, prose, unqualified);
  }
}

function addProse(target, tool, field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  for (const segment of sentenceSegmenter.segment(value.trim())) {
    const words = [...wordSegmenter.segment(segment.segment)].filter((item) => item.isWordLike).length;
    if (words > 0) target.push(Object.freeze({ tool, field, words }));
  }
}

export async function runControlledLanguageGates(options = {}) {
  const root = options.root ?? scriptRoot;
  const contractFile = options.contractPath ?? join(root, 'docs', 'architecture', 'nna-terminology.json');
  const contract = JSON.parse(await readFile(contractFile, 'utf8'));
  const errors = [...validateTerminologyContract(contract)];
  const paths = await collectJavaScript(options.sourceRoot ?? join(root, 'src'));
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const audit = auditDeprecatedIdentifiers(contract, files);
  errors.push(...audit.errors);
  const definitions = options.toolDefinitions ?? await maximalBundledToolDefinitions(root);
  const modelFacingReport = auditModelFacingDefinitions(definitions);
  const rationaleMarkerCounts = countRationaleMarkers(contract.rationale_markers ?? [], files);
  const report = Object.freeze({
    ...modelFacingReport,
    stats: Object.freeze({
      ...modelFacingReport.stats,
      rationaleMarkers: Object.values(rationaleMarkerCounts).reduce((total, count) => total + count, 0),
    }),
    rationale_marker_counts: rationaleMarkerCounts,
  });
  const reportPath = options.reportPath ?? join(root, 'docs', 'architecture', 'controlled-language-report.json');
  const renderedReport = `${JSON.stringify(report, null, 2)}\n`;
  if (options.writeReport === true) await writeFile(reportPath, renderedReport, 'utf8');
  else {
    const committed = await readFile(reportPath, 'utf8').catch(() => null);
    if (committed !== renderedReport) errors.push('controlled-language report is stale; run npm run language:report');
  }
  return Object.freeze({
    errors: Object.freeze(errors), advisories: audit.advisories, report,
    stats: Object.freeze({
      sourceFiles: files.length, terms: contract.terms?.length ?? 0,
      deprecatedIdentifiers: audit.counts.size, modelFacingTools: definitions.length,
    }),
  });
}

async function maximalBundledToolDefinitions(root) {
  const snapshot = { revision: 0, goal: null, tasks: [] };
  const registry = new ToolRegistry(root, {
    mcpControl: { async status() { return {}; }, async test() { return {}; } },
    skillRegistry: {
      search() { return []; },
      load() { return { id: 'audit', version: 1, source: 'audit', requiresTools: [], body: '' }; },
    },
    subagentControl: { workspaceRoot: root, async run() { return {}; } },
    conversationWork: {
      snapshot() { return snapshot; }, async setGoal() { return snapshot; }, async completeGoal() { return snapshot; },
      async reopenGoal() { return snapshot; }, async addTask() { return snapshot; }, async updateTask() { return snapshot; },
    },
    telegramNotifications: { schedule() {} }, activeTurnId: () => 'controlled-language-audit',
    elevationBroker: { async execute() { return {}; } }, sessionHistory: { transcript() { return []; } },
  });
  await registry.initialize();
  try { return registry.snapshot(); } finally { await registry.close(); }
}

function validateTerm(term, index, state, errors) {
  const label = `terms[${index}]`;
  if (!record(term)) { errors.push(`${label} must be an object`); return; }
  uniqueString(term.id, `${label}.id`, state.termIds, errors, TERM_ID);
  uniqueString(term.term, `${label}.term`, state.termNames, errors, /^[a-z][a-z0-9 -]*$/u);
  if (!state.kinds.has(term.kind)) errors.push(`${label}.kind is not declared in term_kinds`);
  if (typeof term.definition !== 'string' || term.definition.trim().length === 0) errors.push(`${label}.definition must be a non-empty string`);
  else for (const sentence of term.definition.split(/[.!?]+/u).filter((value) => value.trim())) {
    if (wordCount(sentence) > 25) errors.push(`${label}.definition has a sentence longer than 25 words`);
  }
  const identifiers = array(term.identifiers, `${label}.identifiers`, errors);
  if (identifiers.length === 0) errors.push(`${label}.identifiers must not be empty`);
  for (const identifier of identifiers) uniqueString(identifier, `${label}.identifiers`, state.declaredIdentifiers, errors, IDENTIFIER);
  if (term.avoid_for_concept !== undefined) stringSet(term.avoid_for_concept, `${label}.avoid_for_concept`, errors);
}

function validateDeprecated(value, declaredIdentifiers, errors) {
  const items = array(value, 'deprecated_identifiers', errors); const seen = new Set();
  for (const [index, item] of items.entries()) {
    const label = `deprecated_identifiers[${index}]`;
    if (!record(item)) { errors.push(`${label} must be an object`); continue; }
    uniqueString(item.identifier, `${label}.identifier`, seen, errors, IDENTIFIER);
    if (!IDENTIFIER.test(item.replacement ?? '')) errors.push(`${label}.replacement must be a JavaScript identifier`);
    else if (!declaredIdentifiers.has(item.replacement)) errors.push(`${label}.replacement must be declared by a preferred term`);
    if (typeof item.reason !== 'string' || item.reason.trim().length === 0) errors.push(`${label}.reason must be a non-empty string`);
    if (!Number.isSafeInteger(item.baseline_occurrences) || item.baseline_occurrences < 0) {
      errors.push(`${label}.baseline_occurrences must be a non-negative safe integer`);
    }
  }
}

async function collectJavaScript(directory) {
  const pending = [directory]; const result = [];
  while (pending.length > 0) {
    const current = pending.pop(); const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) result.push(path);
      if (result.length > MAX_SOURCE_FILES) throw new Error(`source file count exceeds ${MAX_SOURCE_FILES}`);
    }
  }
  return result.sort();
}

function array(value, label, errors) {
  if (Array.isArray(value)) return value;
  errors.push(`${label} must be an array`); return [];
}
function stringSet(value, label, errors) {
  const values = array(value, label, errors); const result = new Set();
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0) errors.push(`${label} must contain non-empty strings`);
    else if (result.has(item)) errors.push(`${label} contains duplicate ${item}`);
    else result.add(item);
  }
  return result;
}
function uniqueString(value, label, seen, errors, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) { errors.push(`${label} has an invalid value`); return; }
  if (seen.has(value)) errors.push(`${label} duplicates ${value}`); else seen.add(value);
}
function exact(value, field, expected, errors) { if (value[field] !== expected) errors.push(`${field} must equal ${expected}`); }
function wordCount(value) { return value.trim().split(/\s+/u).filter(Boolean).length; }
function record(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function identifierStart(value) { return typeof value === 'string' && /[A-Za-z_$]/u.test(value); }
function identifierPart(value) { return typeof value === 'string' && /[A-Za-z0-9_$]/u.test(value); }

async function main() {
  const unknown = process.argv.slice(2).filter((value) => value !== '--write-report');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown[0]}`);
  const result = await runControlledLanguageGates({ writeReport: process.argv.includes('--write-report') });
  for (const advisory of result.advisories) process.stdout.write(`CTL debt: ${advisory}\n`);
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join('\n')}\n`); process.exitCode = 1; return;
  }
  process.stdout.write(`controlled-language gates passed for ${result.stats.terms} terms, ${result.stats.sourceFiles} source files, and ${result.stats.modelFacingTools} bundled tools\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`controlled-language gates failed: ${error.message}\n`); process.exitCode = 1; });
}
