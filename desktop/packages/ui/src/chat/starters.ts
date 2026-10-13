// SPDX-License-Identifier: Apache-2.0
/**
 * Draft starters (doc 05 §H.5, v1): two groups (global + project), each
 * starter = command/skill/built-in reference. Click applies the insert
 * rule: `"visible " + existing draft` (commands) / `visible\n + draft`
 * (skills). Hover X removes; DnD reorder + shared/badge land with settings.
 */
import { getRuntimeKey } from '../lib/runtime-switch.ts';

const STARTERS_KEY = 'nnd.draft-starters.v1';

export interface Starter {
  id: string;
  group: 'global' | 'project';
  kind: 'builtin' | 'command' | 'skill';
  label: string;
  visible: string;
}

interface StartersEnvelope {
  version: 1;
  runtimes: Record<string, Starter[]>;
}

const DEFAULT_STARTERS: Starter[] = [
  { id: 's_debug', group: 'global', kind: 'builtin', label: 'Debug an issue', visible: 'Help me debug an issue: ' },
  { id: 's_catchup', group: 'global', kind: 'builtin', label: 'Catch up on changes', visible: 'Summarize the recent changes in this project.' },
  { id: 's_review', group: 'project', kind: 'builtin', label: 'Review the diff', visible: 'Review the current diff and flag issues.' },
  { id: 's_plan', group: 'project', kind: 'builtin', label: 'Plan a feature', visible: 'Plan a feature: ' },
];

function keyFor(projectDirectory: string): string {
  return `${getRuntimeKey()}\n${projectDirectory}`;
}

function readAll(): Record<string, Starter[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STARTERS_KEY) ?? '') as StartersEnvelope;
    if (parsed?.version !== 1) throw new Error('stale');
    return parsed.runtimes;
  } catch {
    return { [keyFor('*')]: DEFAULT_STARTERS };
  }
}

/** Global starters first, then project starters. */
export function startersFor(projectDirectory: string): Starter[] {
  const all = readAll();
  const global = all[keyFor('*')] ?? DEFAULT_STARTERS;
  const project = all[keyFor(projectDirectory)] ?? [];
  return [...global, ...project];
}

export function addStarter(starter: Starter, projectDirectory: string): void {
  const all = readAll();
  const groupKey = starter.group === 'global' ? keyFor('*') : keyFor(projectDirectory);
  all[groupKey] = [...(all[groupKey] ?? []), starter];
  persist(all);
}

export function removeStarter(starterID: string, projectDirectory: string): void {
  const all = readAll();
  for (const key of [keyFor('*'), keyFor(projectDirectory)]) {
    all[key] = (all[key] ?? []).filter((starter) => starter.id !== starterID);
  }
  persist(all);
}

function persist(all: Record<string, Starter[]>): void {
  try {
    localStorage.setItem(STARTERS_KEY, JSON.stringify({ version: 1, runtimes: all }));
  } catch {
    /* best-effort */
  }
}

/** §H.5 click semantics: commands take inline args, skills take a newline. */
export function starterInsertText(starter: Starter, existingDraft: string): string {
  const visible = starter.visible;
  if (!existingDraft) return visible + ' ' + existingDraft;
  if (starter.kind === 'skill') return `${visible}\n${existingDraft}`;
  return `${visible} ${existingDraft}`;
}
