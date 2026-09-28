// SPDX-License-Identifier: Apache-2.0
/** Stable multi-run and fusion identities (doc 12 §E.2). */

export type MultiRunRunGroup = string;

export type MultiRunTitleParts = {
  groupSlug: string;
  runGroup?: MultiRunRunGroup;
  providerID: string;
  modelID: string;
  index?: number;
  fusion?: boolean;
};

const GROUP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/u;
const RUN_GROUP_PATTERN = /^g([1-9]\d*)$/u;
const DUPLICATE_INDEX_PATTERN = /^([2-9]\d*)$/u;
const TITLE_SEGMENT_PATTERN = /^[^/]+$/u;

function slugToken(value: string, maxLength: number): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, maxLength);
}

export function normalizeGroupSlug(name: string): string {
  const slug = slugToken(name, 50);
  return GROUP_SLUG_PATTERN.test(slug) ? slug : '';
}

export function toModelSlug(providerID: string, modelID: string): string {
  return slugToken(`${providerID}-${modelID}`, 60);
}

function assertParts({ groupSlug, runGroup, providerID, modelID, index }: MultiRunTitleParts): void {
  if (!GROUP_SLUG_PATTERN.test(groupSlug)) throw new TypeError('invalid multi-run group slug');
  if (runGroup !== undefined && !RUN_GROUP_PATTERN.test(runGroup)) throw new TypeError('invalid multi-run run group');
  if (!TITLE_SEGMENT_PATTERN.test(providerID) || !TITLE_SEGMENT_PATTERN.test(modelID)) {
    throw new TypeError('provider and model must be non-empty title segments');
  }
  if (index !== undefined && (index < 2 || !Number.isSafeInteger(index))) {
    throw new TypeError('multi-run duplicate index starts at 2');
  }
}

export function buildMultiRunSessionTitle(parts: MultiRunTitleParts): string {
  assertParts(parts);
  const segments = [parts.runGroup, parts.groupSlug, parts.providerID, parts.modelID, parts.index === undefined ? undefined : String(parts.index)]
    .filter((segment): segment is string => segment !== undefined);
  return segments.join('/');
}

export function buildFusionSessionTitle(parts: Omit<MultiRunTitleParts, 'index'>): string {
  assertParts(parts);
  const segments = [parts.runGroup, parts.groupSlug, parts.providerID, parts.modelID, 'fusion']
    .filter((segment): segment is string => segment !== undefined);
  return segments.join('/');
}

export function buildWorktreeName(parts: MultiRunTitleParts): string {
  assertParts(parts);
  const model = toModelSlug(parts.providerID, parts.modelID);
  if (!GROUP_SLUG_PATTERN.test(parts.groupSlug)) throw new TypeError('invalid multi-run group slug');
  const segments = [parts.runGroup, parts.groupSlug, model, parts.index === undefined ? undefined : String(parts.index)]
    .filter((segment): segment is string => segment !== undefined);
  return segments.join('/');
}

export function parseMultiRunSessionTitle(title: string): MultiRunTitleParts {
  const segments = title.split('/');
  if (segments.length < 3 || segments.some((segment) => segment.length === 0)) throw new TypeError('invalid multi-run session title');

  let cursor = 0;
  let runGroup: string | undefined;
  if (segments[0] !== undefined && RUN_GROUP_PATTERN.test(segments[0])) {
    runGroup = segments[0];
    cursor = 1;
  }
  const groupSlug = segments[cursor];
  const providerID = segments[cursor + 1];
  const modelID = segments[cursor + 2];
  if (groupSlug === undefined || providerID === undefined || modelID === undefined) {
    throw new TypeError('invalid multi-run session title');
  }
  let index: number | undefined;
  let fusion = false;
  if (segments.length === cursor + 4) {
    const rawIndex = segments[cursor + 3];
    if (rawIndex === 'fusion') {
      fusion = true;
    } else {
      const match = rawIndex === undefined ? null : DUPLICATE_INDEX_PATTERN.exec(rawIndex);
      if (match === null) throw new TypeError('invalid multi-run session title');
      index = Number(match[1]);
    }
  } else if (segments.length !== cursor + 3) {
    throw new TypeError('invalid multi-run session title');
  }

  assertParts({ groupSlug, runGroup, providerID, modelID, index });
  return { groupSlug, runGroup, providerID, modelID, index, fusion };
}

export function parseWorktreeRunGroup(runGroup: string): number | undefined {
  const match = RUN_GROUP_PATTERN.exec(runGroup);
  return match === null ? undefined : Number(match[1]);
}
