// SPDX-License-Identifier: Apache-2.0
import { MANIFEST_SHAPE_DESCRIPTORS, CONFIGURATION_KEYS } from './configuration-keys.js';
import { CONFIGURATION_RULES } from './configuration-rules.js';
import { CONFIGURATION_METADATA, CONFIGURATION_DYNAMIC_METADATA, CONFIGURATION_SHAPE_METADATA } from './configuration-catalog-metadata.js';

const SOURCE_LAYERS = Object.freeze(['compiled_default', 'user', 'project', 'explicit', 'launch_override', 'session']);
const CLASSIFICATIONS = new Set(['operator_setting', 'authority_grant', 'internal_invariant', 'compatibility_alias', 'container', 'generated_state']);

export function buildConfigurationCatalog({ shapeDescriptors = MANIFEST_SHAPE_DESCRIPTORS, rules = CONFIGURATION_RULES,
  metadata = CONFIGURATION_METADATA, dynamicMetadata = CONFIGURATION_DYNAMIC_METADATA, shapeMetadata = CONFIGURATION_SHAPE_METADATA } = {}) {
  if (!Array.isArray(shapeDescriptors) || shapeDescriptors.length > 128) fail('shape descriptor bound');
  if (Object.keys(shapeMetadata).length !== shapeDescriptors.length) fail('unclassified structural path');
  const fields = [], coveredRules = new Set(), families = new Set();
  for (const shape of shapeDescriptors) {
    if (!Object.hasOwn(shapeMetadata, shape.path) || shapeMetadata[shape.path] !== shape.family) fail(`unclassified structural path ${shape.path}`);
    if (!shape.family) {
      if (shape.kind !== 'dynamic-map') fail(`unclassified shape ${shape.path}`);
      continue;
    }
    const family = metadata[shape.family];
    assertFamilyCoverage(shape, family);
    families.add(shape.family);
    for (const key of shape.keys) {
      const template = shape.path === '$' ? key : `${shape.path}.${key}`;
      const rule = findRule(template, rules);
      if (rule) coveredRules.add(rule.path);
      for (const path of expandRoles(template)) {
        const item = path.startsWith('mcp_servers[*].') ? { ...family[key], application: metadata.mcp.credential.application } : family[key];
        const actualRule = path === 'routes.primary.deadline_ms' ? rules.provider_timeout_ms : rule;
        fields.push(describeField(path, item, actualRule));
      }
    }
  }
  if (Object.keys(metadata).some((family) => !families.has(family))) fail('unclassified metadata family');
  addDynamicEntries(fields, shapeDescriptors, dynamicMetadata);
  if (Object.keys(rules).some((path) => !coveredRules.has(path))) fail('unclassified scalar rule');
  if (fields.length > 512 || new Set(fields.map(({ path }) => path)).size !== fields.length) fail('duplicate or excessive catalog fields');
  fields.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return freezeTree({ schema_version: '1.0', source_layers: [...SOURCE_LAYERS], authority: 'descriptive_only', scalar_rules: publicMetadata(rules), fields });
}

export const CONFIGURATION_CATALOG = buildConfigurationCatalog();

function assertFamilyCoverage(shape, family) {
  if (!family || !Array.isArray(shape.keys) || shape.keys.length > 64) fail(`missing family ${shape.family}`);
  const keys = Object.keys(family);
  if (keys.length !== shape.keys.length || shape.keys.some((key) => !Object.hasOwn(family, key))) fail(`unclassified keys in ${shape.family}`);
}

function describeField(path, item, rule) {
  if (!CLASSIFICATIONS.has(item.classification) || !item.type || !item.validator || !item.application) fail(`incomplete metadata ${path}`);
  if (item.type === 'numeric_rule' && !rule) fail(`missing numeric rule ${path}`);
  if (rule && item.type !== 'numeric_rule') fail(`scalar rule disagrees with metadata ${path}`);
  const alias = path.startsWith('provider.') ? path.replace(/^provider\./u, 'providers[*].') : null;
  const logicalPath = (item.logicalPath ?? (item.logicalSuffix ? path.replace(/[^.]+$/u, item.logicalSuffix) : alias ?? path)).replace(/^provider\./u, 'providers[*].');
  const intent = item.intent ?? (item.classification === 'operator_setting' ? 'typed_setting' : 'observe');
  const genericEditable = item.classification === 'operator_setting' && intent === 'typed_setting';
  const detail = publicMetadata(item);
  delete detail.validator; delete detail.logical_path; delete detail.logical_suffix; delete detail.intent;
  if (rule) {
    detail.type = rule.type;
    detail.parser_default = rule.default;
    detail.default = item.effectiveDefault ?? rule.default;
    detail.unset = rule.unset;
    if (rule.effectiveZero) detail.effective_zero = rule.effectiveZero;
    if (rule.compatibility) detail.compatibility = rule.compatibility;
    detail.dependencies = item.dependencies ?? rule.dependencies;
  }
  return { path, logical_path: logicalPath, ...(alias ? { alias_of: alias } : {}), ...detail,
    validation: { owner: item.validator, ...(rule ? { rule: rule.path } : {}) },
    source_layers: item.classification === 'authority_grant' ? ['authenticated_host'] : [...SOURCE_LAYERS],
    editability: { intent, generic_editable: genericEditable, authorization: 'native_scoped_contract_required', available: false },
  };
}

function addDynamicEntries(fields, shapes, metadata) {
  const expected = new Set();
  for (const shape of shapes.filter(({ kind }) => kind === 'dynamic-map')) {
    if (shape.entry === 'environment-name' || shape.entry === 'effect') {
      expected.add(shape.path);
      const item = metadata[shape.path];
      if (!item) fail(`unclassified dynamic map ${shape.path}`);
      const token = shape.entry === 'environment-name' ? '{header}' : '{tool}';
      fields.push(describeField(`${shape.path}.${token}`, item, null));
    } else if (!shapes.some(({ path }) => path === shape.entry)) fail(`unclassified dynamic child ${shape.path}`);
  }
  if (Object.keys(metadata).some((path) => !expected.has(path))) fail('unclassified dynamic metadata');
}

function findRule(path, rules) {
  if (Object.hasOwn(rules, path)) return rules[path];
  return Object.values(rules).find(({ aliases }) => aliases.includes(path)) ?? null;
}

function expandRoles(path) {
  return path.includes('{role}') ? CONFIGURATION_KEYS.roles.map((role) => path.replace('{role}', role)) : [path];
}

function publicMetadata(value) {
  const copy = structuredClone(value), pending = [copy];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 4096) fail('metadata bound');
    const current = pending.pop();
    for (const [key, child] of Object.entries(current)) {
      const name = key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
      if (name !== key) { delete current[key]; current[name] = child; }
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return copy;
}

function freezeTree(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    if (seen.size > 10000) fail('catalog bound');
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child && typeof child === 'object' && !Object.isFrozen(child)) pending.push(child);
    Object.freeze(current);
  }
  return value;
}

function fail(reason) { throw new TypeError(`configuration catalog invalid: ${reason}`); }
