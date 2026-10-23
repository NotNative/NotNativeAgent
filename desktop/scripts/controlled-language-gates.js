// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectProductionSources } from './source-catalog.js';

const scriptRoot = resolve(join(fileURLToPath(import.meta.url), '..', '..'));
const TERM_ID = /^CTL-TERM-\d{3}$/u;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const CONTRACT_SCHEMA = 'nnd.controlled-technical-language.v1';
const CONTRACT_STANDARD = 'NND-CTL/1';
const REPORT_SCHEMA = 'nnd.controlled-language-report.v1';
const UNQUALIFIED_BOUNDARY_FIELDS = new Set(['decision', 'result', 'status']);
const RATIONALE_DEFAULT = Object.freeze(['Why', 'Invariant', 'Compatibility', 'Security']);
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

export function validateTerminologyContract(contract) {
  const errors = [];
  if (!record(contract)) return ['terminology contract must be an object'];
  exact(contract, 'schema', CONTRACT_SCHEMA, errors);
  exact(contract, 'standard', CONTRACT_STANDARD, errors);
  if (!contract.inspiration?.name || !contract.inspiration?.issue) errors.push('inspiration must cite the source standard by name and issue');
  const kinds = stringSet(contract.term_kinds, 'term_kinds', errors);
  const markers = stringSet(contract.rationale_markers, 'rationale_markers', errors);
  const legacy = contract.model_facing_fields;
  if (legacy !== undefined) stringSet(legacy, 'model_facing_fields', errors);
  const terms = array(contract.terms, 'terms', errors);
  const state = { kinds, markers, termIds: new Set(), termNames: new Set(), identifiers: new Set() };
  terms.forEach((term, index) => validateTerm(term, index, state, errors));
  validateDeprecated(contract.deprecated_identifiers, state.identifiers, errors);
  return errors;
}

export function scanIdentifiers(source, filePath = 'source.ts') {
  const scriptKind = ts.getScriptKindFromFileName(filePath);
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true,
    scriptKind === ts.ScriptKind.Unknown ? ts.ScriptKind.TS : scriptKind);
  const failure = parsed.parseDiagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (failure) {
    const detail = ts.flattenDiagnosticMessageText(failure.messageText, ' ');
    throw new Error(`cannot scan ${filePath}: ${detail}`);
  }
  const identifiers = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) identifiers.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return identifiers;
}

export function auditDeprecatedIdentifiers(contract, files) {
  const errors = [];
  const advisories = [];
  const counts = new Map();
  for (const item of contract.deprecated_identifiers ?? []) counts.set(item.identifier, 0);
  for (const file of files) {
    for (const identifier of scanIdentifiers(file.source, file.path)) {
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
  return { errors, advisories, counts };
}

export function auditModelFacingDefinitions(definitions) {
  const prose = [];
  const unqualified = [];
  for (const definition of definitions ?? []) {
    addProse(prose, definition.name, 'purpose', definition.purpose);
    for (const [field, value] of Object.entries(definition.descriptions ?? {})) addProse(prose, definition.name, field, value);
    inspectSchema(definition.inputSchema, definition.name, 'inputSchema', prose, unqualified);
  }
  const longProse = prose.filter((item) => item.words > 25)
    .sort((left, right) => right.words - left.words || left.tool.localeCompare(right.tool) || left.field.localeCompare(right.field));
  unqualified.sort((left, right) => left.tool.localeCompare(right.tool) || left.field.localeCompare(right.field));
  return {
    proseFields: new Set(prose.map((item) => `${item.tool}\0${item.field}`)).size,
    proseSentences: prose.length,
    longProseCandidates: longProse,
    unqualifiedBoundaryCandidates: unqualified,
    maximumSentenceWords: prose.reduce((maximum, item) => Math.max(maximum, item.words), 0),
  };
}

export function countRationaleMarkers(markers, files) {
  const markerSet = new Set(markers);
  const counts = Object.fromEntries([...markerSet].map((marker) => [marker, 0]));
  for (const file of files) {
    for (const line of file.source.split(/\r?\n/u)) {
      const match = /^\s*(?:\/\/|\/\*+|\*)\s*([A-Za-z]+):/u.exec(line);
      if (match && markerSet.has(match[1])) counts[match[1]] += 1;
    }
  }
  return counts;
}

export async function runControlledLanguageGates(options = {}) {
  const root = options.root ?? scriptRoot;
  let contract;
  try { contract = JSON.parse(await readFile(join(root, 'docs', 'architecture', 'nnd-terminology.json'), 'utf8')); }
  catch (error) { throw new Error(`cannot read terminology contract: ${error.message}`, { cause: error }); }
  const contractErrors = validateTerminologyContract(contract);
  if (contractErrors.length > 0) throw new Error(`invalid terminology contract: ${contractErrors.join('; ')}`);
  const paths = await collectProductionSources(root);
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, 'utf8') })));
  const audit = auditDeprecatedIdentifiers(contract, files);
  const markers = countRationaleMarkers(contract.rationale_markers ?? RATIONALE_DEFAULT, files);
  const modelFacing = auditModelFacingDefinitions(options.modelFacingDefinitions ?? []);
  const report = buildReport(contract, modelFacing, markers);
  const reportPath = join(root, 'docs', 'architecture', 'controlled-language-report.json');
  if (options.writeReport === true) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  else await requireCurrentReport(reportPath, report, audit.errors);
  return { errors: audit.errors, advisories: audit.advisories, report, stats: { sourceFiles: files.length, terms: contract.terms.length } };
}

async function requireCurrentReport(reportPath, report, errors) {
  let committed;
  try { committed = await readFile(reportPath, 'utf8'); }
  catch {
    errors.push('controlled-language report is missing; run npm run language:report');
    return;
  }
  if (committed !== `${JSON.stringify(report, null, 2)}\n`) {
    errors.push('controlled-language report is stale; run npm run language:report');
  }
}

function buildReport(contract, modelFacing, markers) {
  return {
    schema: REPORT_SCHEMA,
    standard: CONTRACT_STANDARD,
    scope: 'packages/ui/src, packages/web/src, scripts; production sources only',
    stats: {
      terms: contract.terms.length,
      deprecatedIdentifiers: (contract.deprecated_identifiers ?? []).length,
      rationaleMarkers: Object.values(markers).reduce((total, count) => total + count, 0),
      modelFacingTools: 0,
      proseFields: modelFacing.proseFields,
      proseSentences: modelFacing.proseSentences,
      longProseCandidates: modelFacing.longProseCandidates.length,
      unqualifiedBoundaryCandidates: modelFacing.unqualifiedBoundaryCandidates.length,
      maximumSentenceWords: modelFacing.maximumSentenceWords,
    },
    long_prose_candidates: modelFacing.longProseCandidates,
    unqualified_boundary_candidates: modelFacing.unqualifiedBoundaryCandidates,
    rationale_marker_counts: markers,
  };
}

function inspectSchema(schema, tool, path, prose, unqualified) {
  if (!record(schema)) return;
  addProse(prose, tool, `${path}.description`, schema.description);
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const field = `${path}.properties.${name}`;
    if (UNQUALIFIED_BOUNDARY_FIELDS.has(name)) unqualified.push({ tool, field });
    inspectSchema(property, tool, field, prose, unqualified);
  }
  if (schema.items) inspectSchema(schema.items, tool, `${path}.items`, prose, unqualified);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    (schema[keyword] ?? []).forEach((branch, index) => inspectSchema(branch, tool, `${path}.${keyword}[${index}]`, prose, unqualified));
  }
}

function addProse(target, tool, field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  for (const segment of sentenceSegmenter.segment(value.trim())) {
    const words = [...wordSegmenter.segment(segment.segment)].filter((item) => item.isWordLike).length;
    if (words > 0) target.push({ tool, field, words });
  }
}

function validateTerm(term, index, state, errors) {
  const label = `terms[${index}]`;
  if (!record(term)) { errors.push(`${label} must be an object`); return; }
  unique(term.id, `${label}.id`, TERM_ID, state.termIds, errors);
  unique(term.term, `${label}.term`, /^[a-z][a-z0-9 -]*$/u, state.termNames, errors);
  if (!state.kinds.has(term.kind)) errors.push(`${label}.kind is not declared in term_kinds`);
  checkDefinition(term, label, errors);
  const identifiers = array(term.identifiers, `${label}.identifiers`, errors);
  if (identifiers.length === 0) errors.push(`${label}.identifiers must not be empty`);
  for (const identifier of identifiers) unique(identifier, `${label}.identifiers`, IDENTIFIER, state.identifiers, errors);
  if (term.avoid_for_concept !== undefined) stringSet(term.avoid_for_concept, `${label}.avoid_for_concept`, errors);
}

function checkDefinition(term, label, errors) {
  if (typeof term.definition !== 'string' || term.definition.trim().length === 0) {
    errors.push(`${label}.definition must be a non-empty string`);
    return;
  }
  for (const sentence of term.definition.split(/[.!?]+/u).filter((value) => value.trim())) {
    if (wordCount(sentence) > 25) errors.push(`${label}.definition has a sentence longer than 25 words`);
  }
}

function validateDeprecated(value, declaredIdentifiers, errors) {
  const items = value === undefined ? [] : array(value, 'deprecated_identifiers', errors);
  for (const [index, item] of items.entries()) {
    const label = `deprecated_identifiers[${index}]`;
    if (!record(item)) { errors.push(`${label} must be an object`); continue; }
    unique(item.identifier, `${label}.identifier`, IDENTIFIER, new Set(), errors);
    if (!IDENTIFIER.test(item.replacement ?? '')) errors.push(`${label}.replacement must be a JavaScript identifier`);
    else if (!declaredIdentifiers.has(item.replacement)) errors.push(`${label}.replacement must be declared by a preferred term`);
    if (typeof item.reason !== 'string' || item.reason.trim().length === 0) errors.push(`${label}.reason must be a non-empty string`);
    if (!Number.isSafeInteger(item.baseline_occurrences) || item.baseline_occurrences < 0) {
      errors.push(`${label}.baseline_occurrences must be a non-negative safe integer`);
    }
  }
}

function wordCount(value) {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function array(value, label, errors) {
  if (Array.isArray(value)) return value;
  errors.push(`${label} must be an array`);
  return [];
}

function stringSet(value, label, errors) {
  const values = array(value, label, errors);
  const result = new Set();
  for (const item of values) {
    if (typeof item !== 'string' || item.length === 0) errors.push(`${label} must contain non-empty strings`);
    else if (result.has(item)) errors.push(`${label} contains duplicate ${item}`);
    else result.add(item);
  }
  return result;
}

function unique(value, label, pattern, seen, errors) {
  if (typeof value !== 'string' || !pattern.test(value)) { errors.push(`${label} has an invalid value`); return; }
  if (seen.has(value)) errors.push(`${label} duplicates ${value}`);
  else seen.add(value);
}

function exact(value, field, expected, errors) {
  if (value[field] !== expected) errors.push(`${field} must equal ${expected}`);
}

async function main() {
  const unknown = process.argv.slice(2).filter((value) => value !== '--write-report');
  if (unknown.length > 0) throw new Error(`unknown option ${unknown[0]}`);
  const result = await runControlledLanguageGates({ writeReport: process.argv.includes('--write-report') });
  for (const advisory of result.advisories) process.stdout.write(`CTL debt: ${advisory}\n`);
  if (result.errors.length > 0) {
    process.stderr.write(`${result.errors.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`controlled-language gates passed for ${result.stats.terms} terms across ${result.stats.sourceFiles} source files\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`controlled-language gates failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
