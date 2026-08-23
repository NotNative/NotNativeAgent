// SPDX-License-Identifier: Apache-2.0

export function grantBeforeOtherFilesRestriction(value) {
  const parts = String(value).toLowerCase().split(
    /\b(?:do\s+not|don't|never)\s+(?:write|change|replace|create|update|edit|modify|delete|remove|move|rename|copy)\s+(?:any\s+)?other\s+files?\b/iu,
  );
  return parts.length > 1 ? parts[0] : null;
}

export function evidenceNamesTarget(evidence, target) {
  const normalizedEvidence = evidence.replaceAll('\\', '/');
  const segments = target.split('/').filter(Boolean);
  const name = segments.at(-1);
  const relativeSuffixes = segments.slice(1, -1)
    .map((_, index) => segments.slice(index + 1).join('/'))
    .filter((value) => value.includes('/'));
  return containsPathReference(normalizedEvidence, target)
    || relativeSuffixes.some((suffix) => containsPathReference(normalizedEvidence, suffix))
    || (name.length > 0 && containsPathReference(normalizedEvidence, name));
}

function containsPathReference(evidence, reference) {
  let offset = evidence.indexOf(reference);
  while (offset >= 0) {
    const before = offset === 0 ? '' : evidence[offset - 1];
    const afterIndex = offset + reference.length;
    const after = afterIndex >= evidence.length ? '' : evidence[afterIndex];
    if (!/[a-z0-9._/-]/u.test(before) && !/[a-z0-9._/-]/u.test(after)) return true;
    offset = evidence.indexOf(reference, offset + 1);
  }
  return false;
}
