// SPDX-License-Identifier: Apache-2.0
/**
 * Magic-prompt override storage (doc 03 §5.31): immutable version 1 documents
 * identified by a bounded dotted id, with atomic replacement writes.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { ENV } from '../env.ts';

export interface MagicPromptState {
  version: 1;
  overrides: Record<string, string>;
}

const magicPromptMutationQueue = new Map<string, Promise<unknown>>();
const ID_PATTERN = /^[a-z0-9._-]{1,160}$/u;
const MAX_TEXT_CHARS = 200_000;

export function magicPromptFileFor(dataDir: string = ENV.dataDir): string {
  return joinPath(dataDir, 'magic-prompts.json');
}

export function magicPromptIdOk(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function emptyMagicPromptState(): MagicPromptState {
  return { version: 1, overrides: {} };
}

export async function readMagicPrompts(dataDir: string = ENV.dataDir): Promise<MagicPromptState> {
  const file = magicPromptFileFor(dataDir);
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) return emptyMagicPromptState();
  const parsed = JSON.parse(raw) as Partial<MagicPromptState> | null;
  if (parsed?.version !== 1 || typeof parsed.overrides !== 'object' || parsed.overrides === null) {
    throw new Error('magic-prompt store is malformed');
  }
  const overrides: Record<string, string> = {};
  for (const [id, text] of Object.entries(parsed.overrides)) {
    if (magicPromptIdOk(id) && typeof text === 'string' && text.length > 0) overrides[id] = text;
  }
  return { version: 1, overrides };
}

export async function writeMagicPromptOverride(id: string, text: string, dataDir: string = ENV.dataDir): Promise<MagicPromptState> {
  if (!magicPromptIdOk(id)) throw new Error('invalid magic prompt id');
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) {
    throw new Error('magic prompt text must be 1..200000 chars');
  }
  return applyMagicPromptMutation(dataDir, (state) => ({
    ...state,
    overrides: { ...state.overrides, [id]: text },
  }));
}

export async function deleteMagicPromptOverride(id: string, dataDir: string = ENV.dataDir): Promise<MagicPromptState | null> {
  if (!magicPromptIdOk(id)) throw new Error('invalid magic prompt id');
  return applyMagicPromptMutationMapped(dataDir, (state) => {
    if (!(id in state.overrides)) return null;
    const overrides = { ...state.overrides };
    delete overrides[id];
    return { ...state, overrides };
  });
}

export async function deleteAllMagicPromptOverrides(dataDir: string = ENV.dataDir): Promise<MagicPromptState> {
  return applyMagicPromptMutation(dataDir, () => emptyMagicPromptState());
}

async function applyMagicPromptMutation(
  dataDir: string,
  nextState: (state: MagicPromptState) => MagicPromptState,
): Promise<MagicPromptState> {
  return applyMagicPromptMutationMapped(dataDir, (state) => writeMagicPromptState(nextState(state), dataDir));
}

async function applyMagicPromptMutationMapped<T>(
  dataDir: string,
  next: (state: MagicPromptState) => T | Promise<T>,
): Promise<T> {
  const previous = magicPromptMutationQueue.get(dataDir) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const state = await readMagicPrompts(dataDir);
    return await next(state);
  });
  magicPromptMutationQueue.set(dataDir, operation.catch(() => undefined));
  return operation;
}

async function writeMagicPromptState(state: MagicPromptState, dataDir: string): Promise<MagicPromptState> {
  const file = magicPromptFileFor(dataDir);
  const temporary = joinPath(dirname(file), `.magic-prompts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
  return state;
}
