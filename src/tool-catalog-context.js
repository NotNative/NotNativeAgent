// SPDX-License-Identifier: Apache-2.0
const MAX_NAMES = 512;
const MAX_BYTES = 32 * 1024;

export function toolCatalogContext(registrySnapshot, providerDefinitions) {
  const loaded = new Set(providerDefinitions.map((item) => item.function?.name).filter(Boolean));
  const available = [...new Set(registrySnapshot.map((item) => item.name).filter((name) => name && !loaded.has(name)))]
    .sort(compareNames);
  if (available.length === 0) return null;
  const names = boundedNames(available);
  const omitted = available.length - names.length;
  const suffix = omitted > 0 ? `\n${omitted} additional authorized tool names were omitted from this bounded catalog.` : '';
  return [
    'Additional authorized tool names whose schemas are not loaded in this step:',
    JSON.stringify(names),
    'Use tool.search to inspect and load matching tool schemas before calling them.',
  ].join('\n') + suffix;
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
  return selected;
}

function compareNames(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
