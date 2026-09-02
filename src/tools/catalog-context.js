// SPDX-License-Identifier: Apache-2.0
// A model step receives at most 512 discovery names and 32 KiB of exact compact JSON,
// leaving the bulk of its context budget for task evidence and loaded schemas.
import { FOUNDATIONAL_TOOL_NAMES, INTERNAL_TOOL_NAMES, LEGACY_PROVIDER_TOOL_NAMES } from './core-names.js';

const MAX_NAMES = 512;
const MAX_BYTES = 15 * 1024;

export function toolCatalogContext(registrySnapshot, providerDefinitions) {
  const loaded = new Set(providerDefinitions.map((item) => item.function?.name).filter(Boolean));
  const available = [...new Set(registrySnapshot.map((item) => item.name).filter((name) => name && !loaded.has(name)))]
    .sort(compareNames);
  if (available.length === 0) return null;
  const names = boundedNames(available);
  const tiers = catalogTiers(names);
  const omitted = available.length - names.length;
  const suffix = omitted > 0 ? `\n${omitted} additional authorized tool names were omitted from this bounded catalog.` : '';
  return [
    'Additional authorized tool names whose schemas are not loaded in this step:',
    JSON.stringify(names),
    `Catalog tiers (classification only; no tier grants authority): ${JSON.stringify(tiers)}`,
    'Use tool.search to inspect and load matching tool schemas before calling them.',
  ].join('\n') + suffix;
}

function catalogTiers(names) {
  const foundational = new Set(FOUNDATIONAL_TOOL_NAMES);
  const internal = new Set(INTERNAL_TOOL_NAMES);
  const legacy = new Set(LEGACY_PROVIDER_TOOL_NAMES);
  const tiers = { foundational: [], specialist: [], internal: [], legacy: [] };
  for (const name of names) {
    const tier = foundational.has(name) ? 'foundational'
      : internal.has(name) ? 'internal' : legacy.has(name) ? 'legacy' : 'specialist';
    tiers[tier].push(name);
  }
  return tiers;
}

function boundedNames(names) {
  const selected = [];
  let bytes = 2;
  for (const name of names) {
    if (selected.length >= MAX_NAMES) break;
    const addition = Buffer.byteLength(JSON.stringify(name), 'utf8') + (selected.length > 0 ? 1 : 0);
    if (bytes + addition > MAX_BYTES) break;
    selected.push(name);
    bytes += addition;
  }
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') > MAX_BYTES) {
    throw new RangeError('bounded tool catalog exceeded its serialized byte budget');
  }
  return selected;
}

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
