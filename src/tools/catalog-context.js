// SPDX-License-Identifier: Apache-2.0
// A model step receives at most 512 discovery names and 32 KiB of exact compact JSON,
// leaving the bulk of its context budget for task evidence and loaded schemas.
import { FOUNDATIONAL_TOOL_NAMES, INTERNAL_TOOL_NAMES, LEGACY_PROVIDER_TOOL_NAMES } from './core-names.js';

const MAX_NAMES = 512;
const MAX_BYTES = 15 * 1024;

/**
 * The discovery catalog a step shows.
 *
 * Why the catalog no longer subtracts the loaded surface: it used to list "names
 * whose schemas are not loaded in this step", so every `tool_search` moved a name
 * from the catalog into the loaded set and rewrote the text mid-turn. The catalog
 * sits before the transcript, so each rewrite invalidated the provider's prefix
 * cache from that point - a tool-heavy turn re-billed its whole context at full
 * price every step (a measured turn billed 860k input tokens with a 0.0% cache hit).
 * The catalog is now the full installed list, stable for a turn; the loaded surface
 * is visible to the model in its `tools` array, and `tool_search` stays the loader.
 *
 * Why a caller-supplied snapshot instead of reading the registry live: the text must
 * be byte-identical across every step of a turn. Taking it once at turn start makes
 * "the catalog changed mid-turn" impossible by construction rather than by discipline.
 */
export function toolCatalogContext(registrySnapshot, _providerDefinitions = []) {
  const available = [...new Set(registrySnapshot.map((item) => item.name).filter(Boolean))]
    .sort(compareNames);
  if (available.length === 0) return null;
  const names = boundedNames(available);
  const tiers = catalogTiers(names);
  const omitted = available.length - names.length;
  const suffix = omitted > 0 ? `\n${omitted} additional installed tool names were omitted from this bounded catalog.` : '';
  return [
    'Installed tool names. A name whose schema is already in this step\'s tools needs no loading:',
    JSON.stringify(names),
    `Catalog tiers (classification only; no tier grants authority): ${JSON.stringify(tiers)}`,
    'Use tool_search with an exact name to load a schema not in this step\'s tools. A workflow lease controls schema visibility; every call still requires mandatory review.',
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
