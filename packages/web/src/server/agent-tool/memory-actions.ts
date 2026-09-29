// SPDX-License-Identifier: Apache-2.0
/** Server-owned dispatch contract for the memory managed tool. */
import { agentMemoryEnabled, createMemoryEntry, deleteMemoryEntry, readMemoryStore,
  sanitizeMemoryEntry, type AgentMemoryEntry, type AgentMemoryScope } from '../project-context/agent-memory.ts';
import { resolveMemoryOwnership } from '../project-context/agent-memory-ownership.ts';

export interface MemoryToolResult { status: number; value: unknown }

const ACTIONS = new Set(['memory.read', 'memory.list', 'memory.save', 'memory.delete']);
const SCOPES = new Set(['global', 'project', 'both']);
const TYPES = new Set(['fact', 'preference', 'reference']);
const UNAVAILABLE = 'Stored memory could not be read; try again before assuming it is absent';

function normalizedAction(input: Record<string, unknown>): string | null {
  const action = typeof input.action === 'string' ? input.action.trim() : '';
  if (ACTIONS.has(action)) return action;
  return ALIASES.has(action) ? `memory.${action}` : null;
}
const ALIASES = new Set(['read', 'list', 'save', 'delete']);

function parametersOf(input: Record<string, unknown>): Record<string, unknown> {
  const explicit = input.parameters;
  if (explicit === undefined) return input;
  if (!explicit || typeof explicit !== 'object' || Array.isArray(explicit)) return {};
  const implicit: Record<string, unknown> = { ...input };
  delete implicit.action;
  delete implicit.parameters;
  return { ...implicit, ...(explicit as Record<string, unknown>) };
}

async function readScope(scope: AgentMemoryScope, projectId: string | undefined) {
  try { return { entries: await readMemoryStore(scope, projectId), failed: false as const }; }
  catch { return { entries: [] as Awaited<ReturnType<typeof readMemoryStore>>, failed: true as const }; }
}

function summary(scope: AgentMemoryScope): (entry: unknown) => Record<string, unknown> {
  return (entry) => {
    const value = entry as { id?: unknown; title?: unknown; type?: unknown; flagged?: unknown };
    return {
      memoryId: typeof value?.id === 'string' ? value.id : '',
      title: typeof value?.title === 'string' ? value.title : '',
      type: typeof value?.type === 'string' ? value.type : 'fact',
      scope,
      ...(value?.flagged !== undefined ? { heldBack: true } : {}),
    };
  };
}

export async function executeMemoryTool(
  rawInput: unknown, projectId: string | undefined, toolName = 'openchamber_memory',
): Promise<MemoryToolResult> {
  if (toolName !== 'openchamber_memory') {
    return { status: 400, value: { error: `unsupported managed tool ${toolName}` } };
  }
  if (!agentMemoryEnabled()) {
    return { status: 403, value: { error: 'Agent memory is switched off in OpenChamber settings' } };
  }
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return { status: 400, value: { error: 'agent memory tool input must be an object' } };
  }
  const input = rawInput as Record<string, unknown>;
  const action = normalizedAction(input);
  if (!action) return { status: 400, value: { error: 'valid agent memory action is required' } };
  const parameters = parametersOf(input);

  if (action === 'memory.save') return await saveMemory(projectId, parameters);

  if (action === 'memory.list') return await listMemory(projectId, parameters);

  if (action === 'memory.read') return await readMemory(projectId, parameters);

  return await deleteMemory(projectId, parameters);
}

async function saveMemory(projectId: string | undefined, parameters: Record<string, unknown>):
  Promise<MemoryToolResult> {
  const scope: AgentMemoryScope = parameters.scope === 'global' ? 'global' : 'project';
  if (parameters.scope !== undefined && parameters.scope !== 'global' && parameters.scope !== 'project') {
    return { status: 400, value: { error: 'invalid agent memory scope' } };
  }
  const title: string = typeof parameters.title === 'string' && parameters.title.trim() !== '' ?
    parameters.title : '';
  const body: string = typeof parameters.body === 'string' && parameters.body.trim() !== '' ?
    parameters.body : '';
  if (title === '' || body === '') {
    return { status: 400, value: { error: 'agent memory title and body are required' } };
  }
  if (parameters.type !== undefined && !TYPES.has(String(parameters.type))) {
    return { status: 400, value: { error: 'invalid agent memory type' } };
  }
  try {
    const touched = await createMemoryEntry(projectId, {
      title, body, type: parameters.type, scope, sessionId: parameters.sessionId,
    });
    return { status: 200, value: {
      saved: true, memory: summary(scope)(touched.memory), replaced: touched.replaced,
      ...(touched.warning === undefined ? {} : { warning: touched.warning }),
    } };
  } catch (error) {
    return { status: 500, value: { error: error instanceof Error ? error.message : 'agent memory save failed' } };
  }
}

async function listMemory(projectId: string | undefined, parameters: Record<string, unknown>):
  Promise<MemoryToolResult> {
  const scope = (parameters.scope === undefined ? 'both' : parameters.scope) as string;
  if (!SCOPES.has(scope)) return { status: 400, value: { error: 'invalid agent memory scope' } };
  const scopes: AgentMemoryScope[] = scope === 'both' ? ['global', 'project'] : [scope as AgentMemoryScope];
  const loaded = await Promise.all(scopes.map(async (selected) => ({
    selected, stores: await readScope(selected, selected === 'project' ? projectId : undefined),
  })));
  const unavailable = loaded.filter((scope) => scope.stores.failed).map((scope) => scope.selected);
  const memory = loaded.flatMap((current) => current.stores.entries.map(summary(current.selected)));
  return {
    status: unavailable.length > 0 ? 503 : 200,
    value: { memory, ...(unavailable.length > 0 ? { unavailableScope: unavailable } : {}) },
  };
}

async function readMemory(projectId: string | undefined, parameters: Record<string, unknown>):
  Promise<MemoryToolResult> {
  const title = typeof parameters.title === 'string' ? parameters.title : '';
  const memoryId = typeof parameters.memoryId === 'string' ? parameters.memoryId : '';
  if (!title && !memoryId) {
    return { status: 400, value: { error: 'agent memory title or memoryId is required' } };
  }
  const requested = parameters.scope as string | undefined;
  if (requested !== undefined && requested !== 'global' && requested !== 'project') {
    return { status: 400, value: { error: 'invalid agent memory scope' } };
  }
  const scopes: AgentMemoryScope[] = requested === 'global' ? ['global'] :
    requested === 'project' ? ['project'] : ['project', 'global'];
  const loaded = await Promise.all(scopes.map(async (scope) => ({
    scope, stores: await readScope(scope, scope === 'project' ? projectId : undefined),
  })));
  if (loaded.every((current) => current.stores.failed)) {
    return { status: 503, value: { error: UNAVAILABLE, unavailableScope: scopes } };
  }
  const match = loaded.flatMap((current) => current.stores.entries
    .map((entry) => ({ scope: current.scope, entry })))
    .find(({ entry }) => (memoryId === '' || entry.id === memoryId)
      && (title === '' || entry.title === title));
  if (!match) return { status: 404, value: { error: 'memory entry not found' } };
  const entry = sanitizeMemoryEntry(match.entry);
  return { status: 200, value: { ...summary(match.scope)(entry), body: entry.body } };
}

async function deleteMemory(projectId: string | undefined, parameters: Record<string, unknown>):
  Promise<MemoryToolResult> {
  const memoryId = typeof parameters.memoryId === 'string' ? parameters.memoryId : '';
  const scope = parameters.scope;
  if (!memoryId || (scope !== 'global' && scope !== 'project')) {
    return { status: 400, value: { error: 'agent memory delete requires memoryId and scope' } };
  }
  try {
    const deleted = await deleteMemoryEntry(projectId, scope, memoryId);
    if (!deleted) return { status: 404, value: { error: 'memory entry not found' } };
    return { status: 200, value: { deleted: true, memoryId, scope } };
  } catch {
    return { status: 503, value: { error: UNAVAILABLE, unavailableScope: [scope] } };
  }
}

export async function sessionMemoryContent(input: {
  contextDirectory: string; projects?: readonly { id: string; worktree: string }[];
  managedChatsRoot?: string;
}): Promise<{ content: string | undefined; projectId?: string }> {
  const owner = resolveMemoryOwnership({ ...input, directory: input.contextDirectory });
  if (!agentMemoryEnabled()) return { content: undefined, projectId: owner };
  const expected = [
    'You have stored memory from earlier sessions. Only the titles are listed below.',
    'A title is an abbreviation, not the memory. Read the entry with the',
    'openchamber_memory tool before you act on it: titles routinely leave out',
    'the conditions, exceptions and reasons that decide how the memory applies,',
    'and a title that looks self-explanatory is the most likely to be hiding',
    'them. Read every title that could bear on the task at hand; you need not',
    'read the ones unrelated to what you are doing.',
    '',
    'Memory records what was true when it was written. Verify anything it says',
    'about files, flags or commands before relying on it.',
  ].join('\n');
  const global = await readScope('global', undefined);
  const project = await readScope('project', owner);
  const globalEntries = (global?.entries ?? []).filter((entry) => entry.flagged === undefined);
  const projectEntries = (project?.entries ?? []).filter((entry) => entry.flagged === undefined);
  if (!globalEntries.length && !projectEntries.length) return { content: undefined, projectId: owner };
  const sections: string[] = [];
  if (globalEntries.length) {
    sections.push(['### About the user',
      ...globalEntries.map(projectLine)].join('\n'));
  }
  if (projectEntries.length) {
    sections.push(['### About this project',
      ...projectEntries.map(projectLine)].join('\n'));
  }
  return { content: [expected, ...sections].join('\n\n'), projectId: owner };
}

function projectLine(entry: AgentMemoryEntry): string {
  return `- [${entry.type}] ${entry.title}`;
}
