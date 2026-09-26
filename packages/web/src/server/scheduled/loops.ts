// SPDX-License-Identifier: Apache-2.0
/**
 * Loop files (doc 12 C.8): portable scheduled-task definitions under
 * `.agents/loops/*.md`. Discovery mirrors skills scopes: a user scope next
 * to the home directory plus project scopes in every ancestor of the
 * project path up to the worktree root; project scope shadows the user
 * scope and the nearest ancestor wins. The frontmatter schedule is
 * CRON-ONLY and `enabled` defaults FALSE - discovery must never
 * auto-execute repository content. Parse failures degrade: a file with a
 * usable name reports a null definition (its last good task definition is
 * kept), a file without a usable name is only warned.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join as joinPath } from 'node:path';
import { cronNextAt, isValidZone } from './next-run.ts';
import {
  TASK_CRON_MAX, TASK_NAME_MAX, TASK_PROMPT_MAX, TASK_ROUTE_ID_MAX,
} from './scheduled-constants.ts';

export interface LoopDefinition {
  name: string;
  schedule: { kind: 'cron'; cron: string; timezone: string };
  execution: { prompt: string; providerID: string; modelID: string; agent?: string };
  enabled: boolean;
}

export interface DiscoveredLoop {
  name: string;
  /** Absolute path of the driving .agents/loops/*.md file (task identity). */
  file: string;
  scope: 'user' | 'project';
  definition: LoopDefinition | null;
  reason?: string;
}

export interface LoopOptions { now: number; serverZone: string }

export type LoopLog = { warn: (message: string) => void };

/** The deterministic id prefix shape (doc 12 C.1: `loop:<scope>:<name>`). */
export const LOOP_TASK_ID_PATTERN = /^loop:(user|project):/u;

/** A loop name is id-shaped: it becomes a segment of a deterministic id, so
 * separators/space-bearing names would break task id law - parse failure. */
const LOOP_NAME_LEGAL = /^[A-Za-z0-9._-]+$/u;

export interface RawLoop { file: string; scope: 'user' | 'project'; text: string }
interface ParsedMeta { meta: Map<string, string>; body: string }

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

/** Flat frontmatter only: the portable format is key: value lines. */
function splitFrontmatter(text: string): ParsedMeta | null {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length && i <= 256; i += 1) {
    if (lines[i]?.trim() === '---') { end = i; break; }
  }
  if (end < 1) return null;
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    meta.set(line.slice(0, at).trim(), stripQuotes(line.slice(at + 1).trim()));
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

function zoneOrDefault(value: string | undefined, options: LoopOptions): string {
  return value !== undefined && isValidZone(value) ? value : options.serverZone;
}

function boundedAgent(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 && value.length <= TASK_ROUTE_ID_MAX ? value : undefined;
}

/** Parses one loop document (doc 12 C.8 format section). Usable-name
 * failures keep the name with `definition: null`; unusable-name files
 * return an empty-name loop the caller reports as a warning only. The
 * caller supplies the file path and scope for the returned loop. */
export function parseLoopFile(text: string, options: LoopOptions): DiscoveredLoop {
  const base: DiscoveredLoop = { name: '', file: '', scope: 'project', definition: null };
  const parts = splitFrontmatter(text);
  if (parts === null) return { ...base, reason: 'loop file has no frontmatter block' };
  const name = parts.meta.get('name')?.trim() ?? '';
  if (name.length === 0 || name.length > TASK_NAME_MAX) {
    return { ...base, reason: 'loop name must be 1..80 characters' };
  }
  if (!LOOP_NAME_LEGAL.test(name)) {
    return { ...base, name, reason: 'loop name is not a legal task id segment' };
  }
  const fail = (reason: string): DiscoveredLoop => ({ ...base, name, definition: null, reason });
  const cron = parts.meta.get('schedule')?.trim() ?? '';
  if (cron.length === 0 || cron.length > TASK_CRON_MAX) return fail('loop schedule is missing or too long');
  const timezone = zoneOrDefault(parts.meta.get('timezone'), options);
  if (cronNextAt(cron, timezone, options.now) === null) return fail('loop schedule is not a valid cron expression');
  const model = parts.meta.get('model') ?? '';
  const cutoff = model.indexOf('/');
  const providerID = cutoff > 0 ? model.slice(0, cutoff) : '';
  const modelID = cutoff > 0 ? model.slice(cutoff + 1) : '';
  if (providerID.length === 0 || providerID.length > TASK_ROUTE_ID_MAX
    || modelID.length === 0 || modelID.length > TASK_ROUTE_ID_MAX) {
    return fail('loop model must be a providerID/modelID pair split on the first slash');
  }
  const prompt = parts.body;
  if (prompt.length === 0 || prompt.length > TASK_PROMPT_MAX) return fail('loop body (the prompt) is required');
  const agent = boundedAgent(parts.meta.get('agent'));
  return {
    ...base,
    name,
    definition: {
      name,
      schedule: { kind: 'cron', cron, timezone },
      execution: agent === undefined
        ? { prompt, providerID, modelID }
        : { prompt, providerID, modelID, agent },
      enabled: parts.meta.get('enabled') === 'true',
    },
  };
}

export function loopTaskId(loop: DiscoveredLoop): string {
  return `loop:${loop.scope}:${loop.name}`;
}

/** The task document a loop drives: the stored record (rename/adoption)
 * carries its unknown fields, execution extras, and state verbatim; the
 * file owns name/enabled/schedule and the execution core. Caller passes
 * `id` explicitly to rename (a new loop-derived id), else the loop id. */
export function loopTaskInput(
  loop: DiscoveredLoop, options: { stored: unknown; id?: string },
): Record<string, unknown> {
  const definition = loop.definition;
  if (definition === null) throw new Error('loop has no parsed definition');
  const base = loopStoredRecord(options.stored);
  const storedExecution = loopStoredRecord(base.execution);
  const execution: Record<string, unknown> = {
    ...storedExecution,
    prompt: definition.execution.prompt,
    providerID: definition.execution.providerID,
    modelID: definition.execution.modelID,
  };
  if (definition.execution.agent !== undefined) execution.agent = definition.execution.agent;
  return {
    ...base,
    id: options.id ?? loopTaskId(loop),
    name: definition.name,
    enabled: definition.enabled,
    schedule: { kind: 'cron', cron: definition.schedule.cron, timezone: definition.schedule.timezone },
    execution,
    loopFile: loop.file,
  };
}

function loopStoredRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Ancestors of the project path from nearest to the worktree root (a
 * directory holding a .git entry), inclusive; without one, the fs root. */
export function projectLoopAncestors(projectPath: string): string[] {
  const chain: string[] = [];
  let current = projectPath;
  for (let depth = 0; depth < 96; depth += 1) {
    chain.push(current);
    if (existsSync(joinPath(current, '.git'))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

async function scanLoopDir(dir: string, scope: 'user' | 'project', log?: LoopLog): Promise<RawLoop[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((entry) => entry.endsWith('.md')).sort();
  } catch {
    return []; // missing or unreadable directory contributes nothing
  }
  const raw: RawLoop[] = [];
  for (const entry of names) {
    const file = joinPath(dir, entry);
    try {
      raw.push({ file, scope, text: await readFile(file, 'utf8') });
    } catch (error) {
      log?.warn(`loop file unreadable: ${file}: ${String(error)}`);
    }
  }
  return raw;
}

/**
 * Discover loops with C.8 precedence: the user scope first, then project
 * ancestors from the FARTHEST to the nearest, so a closer scope wins the
 * name. A file whose metadata is unusable reports `definition: null` but
 * still claims its name for shadowing; a file without a usable name only
 * warns and vanishes from discovery (it must never block valid loops).
 */
export async function discoverLoops(
  projectPath: string | null,
  options: LoopOptions,
  userLoopsDir: string = joinPath(homedir(), '.agents', 'loops'),
  log?: LoopLog,
): Promise<DiscoveredLoop[]> {
  const ranked: RawLoop[] = [...(await scanLoopDir(userLoopsDir, 'user', log))];
  const ancestors = projectPath !== null ? projectLoopAncestors(projectPath) : [];
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const dir = joinPath(ancestors[i] ?? '', '.agents', 'loops');
    if (dir.length === 0) continue;
    ranked.push(...(await scanLoopDir(dir, 'project', log)));
  }
  const byName = new Map<string, DiscoveredLoop>();
  for (const raw of ranked) {
    const parsed = { ...parseLoopFile(raw.text, options), file: raw.file, scope: raw.scope };
    if (parsed.name.length === 0) {
      log?.warn(`loop file without a usable name: ${raw.file}${parsed.reason === undefined ? '' : `: ${parsed.reason}`}`);
      continue;
    }
    // The scan runs least-priority first (user, then project ancestors from
    // the farthest): a LATER file SHADOWS the earlier one for its name.
    const dropped = byName.get(parsed.name);
    byName.set(parsed.name, parsed);
    if (dropped !== undefined) {
      log?.warn(`loop name ${parsed.name} shadowed: ${dropped.file} loses to ${raw.file}`);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name) || a.file.localeCompare(b.file));
}

/**
 * Loop-file enabled toggle (the PATCH loop-file route): rewrites the
 * `enabled:` key inside the existing frontmatter, or appends it there;
 * returns null when the text is not a loop document.
 */
export function writeLoopEnabled(text: string, enabled: boolean): string | null {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') return null;
  let end = -1;
  for (let i = 1; i < lines.length && i <= 256; i += 1) {
    if (lines[i]?.trim() === '---') { end = i; break; }
  }
  if (end < 1) return null;
  // The rewrite touches only the flag line: the file's own line endings
  // (a CRLF checkout) must survive the rewrite instead of being converted.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const flag = `enabled: ${enabled ? 'true' : 'false'}`;
  let touched = false;
  for (let i = 1; i < end; i += 1) {
    if (/^enabled\s*:/u.test(lines[i] ?? '')) { lines[i] = flag; touched = true; break; }
  }
  if (!touched) lines.splice(end, 0, flag);
  return lines.join(eol);
}
