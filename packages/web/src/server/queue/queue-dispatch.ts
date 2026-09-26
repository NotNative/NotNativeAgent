// SPDX-License-Identifier: Apache-2.0
/**
 * Head dispatch (doc 12 §D.3.6): delivers ONE queue head through the HP-1
 * adapter seam. Slash commands resolve against the harness catalog
 * (`GET /command`) — a non-skill command without captured context rides
 * `POST /session/:id/command` (file parts only; a command queued WITH
 * context cannot use it), everything else rides `prompt_async` with the
 * exact §D.3.6 part order and the §B.8 argument expansion. Knowledge
 * resolves through the `ProjectKnowledgeProvider` seam; `recordDelivered`
 * runs ONLY after an accepted prompt (a rejected dispatch carries the
 * knowledge again; a lookup failure sends without it).
 */
import { harnessRequest, callHarness, callHarnessJson } from './queue-adapter-calls.ts';
import { commandArgsOf, commandNameOf, expandCommandTemplate } from './queue-expansion.ts';
import type { ProjectKnowledgeProvider } from './queue-hooks.ts';
import type { QueueItem } from './queue-item.ts';

/** dispatch resolution: command route / skill instruction / template text. */
export type SlashResolution
  = { kind: 'command'; name: string; template: string | null }
  | { kind: 'skill'; name: string }
  | { kind: 'expandedCommand'; name: string; template: string | null }
  | null;

export type DeliveryOutcome = { ok: true } | { ok: false; status: number; reason: string };

function skillInstruction(name: string): string {
  return `The user explicitly invoked the ${name} skill. Use the corresponding skill tool to handle this request.`;
}

export function commandEntryOf(catalog: unknown, name: string): { source?: unknown; template?: unknown } | null {
  if (!Array.isArray(catalog)) return null;
  for (const entry of catalog) {
    const record = asRecord(entry);
    if (record !== null && record.name === name) return { source: record.source, template: record.template };
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Deliver one head: resolve slash + knowledge, post the resolved route,
 *  then — ONLY after acceptance — record the knowledge delivery. */
export async function deliverHead(
  sessionId: string,
  directory: string,
  item: QueueItem,
  knowledge: ProjectKnowledgeProvider,
): Promise<DeliveryOutcome> {
  const slash = await resolveSlash(item, directory);
  let knowledgeText: string | null = null;
  if (slash === null || slash.kind === 'skill' || slash.kind === 'expandedCommand') {
    knowledgeText = await resolveKnowledge(sessionId, directory, knowledge);
  }
  const outcome = slash !== null && slash.kind === 'command'
    ? await postCommandRoute(sessionId, directory, item, slash)
    : await postPromptRoute(sessionId, directory, item, slash, knowledgeText);
  // knowledge delivery records only AFTER the prompt is accepted (§D.3.6)
  if (outcome.ok && knowledgeText !== null) knowledge.recordDelivered(sessionId, directory);
  return outcome;
}

async function resolveSlash(item: QueueItem, directory: string): Promise<SlashResolution> {
  if (!item.text.startsWith('/')) return null;
  const name = commandNameOf(item.text);
  if (!name) return null;
  const catalog = await callHarnessJson(harnessRequest('/command', directory, { method: 'GET' }));
  const entry = commandEntryOf(catalog, name);
  if (!entry) return null; // catalog miss: plain prose delivery
  const template = typeof entry.template === 'string' && entry.template !== '' ? entry.template : null;
  if (entry.source === 'skill') return { kind: 'skill', name };
  if (item.context.length === 0) return { kind: 'command', name, template };
  return { kind: 'expandedCommand', name, template }; // command WITH context
}

async function resolveKnowledge(sessionId: string, directory: string, knowledge: ProjectKnowledgeProvider): Promise<string | null> {
  try {
    const text = await knowledge.resolve(sessionId, directory);
    return typeof text === 'string' && text.trim() !== '' ? text : null;
  } catch {
    return null; // lookup failure → send without it (§D.3.6)
  }
}

async function postSession(sessionId: string, directory: string, route: string, body: unknown): Promise<DeliveryOutcome> {
  const response = await callHarness(harnessRequest(route, directory, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  if (!response.ok) return { ok: false, status: response.status, reason: `${route} rejected with ${response.status}` };
  return { ok: true };
}

function postCommandBody(item: QueueItem, slash: { kind: 'command'; name: string; template: string | null }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    command: slash.name,
    arguments: commandArgsOf(item.text, slash.name),
    // the command route takes the model as `provider/model` (§D.3.6)
    model: `${item.sendConfig.providerID}/${item.sendConfig.modelID}`,
  };
  if (item.sendConfig.agent) body.agent = item.sendConfig.agent;
  if (item.sendConfig.variant) body.variant = item.sendConfig.variant;
  const fileParts = item.attachments
    .map((attachment) => ({ type: 'file', mime: attachment.mimeType, filename: attachment.filename, url: attachment.dataUrl }));
  if (fileParts.length > 0) body.parts = fileParts; // file parts ONLY (§D.3.6)
  return body;
}

async function postCommandRoute(
  sessionId: string,
  directory: string,
  item: QueueItem,
  slash: { kind: 'command'; name: string; template: string | null },
): Promise<DeliveryOutcome> {
  return postSession(sessionId, directory, `/session/${encodeURIComponent(sessionId)}/command`, postCommandBody(item, slash));
}

/** Parts in the exact §D.3.6 order: 1 user text, 2 file parts, 3 context
 *  (each entry as a synthetic carrying its metadata; `instructions` go as
 *  their OWN synthetic part immediately before the entry), 4 skill
 *  instruction, 5 knowledge, 6 agent mention. The expansion of a non-skill
 *  command REPLACES the delivered user text (registered E-09-3:
 *  "expands into the text" = position 1, slot 4 stays open). */
function assemblePromptParts(item: QueueItem, deliveredText: string, skillInstructionText: string | null, knowledgeText: string | null): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (deliveredText.trim() !== '') parts.push({ type: 'text', text: deliveredText });
  for (const attachment of item.attachments) {
    parts.push({ type: 'file', mime: attachment.mimeType, filename: attachment.filename, url: attachment.dataUrl });
  }
  for (const entry of item.context) {
    if (entry.kind === 'context' && entry.instructions) parts.push({ type: 'text', text: entry.instructions, synthetic: true });
    parts.push(entry.kind === 'context'
      ? { type: 'text', text: entry.text, synthetic: true, metadata: entry.metadata }
      : { type: 'text', text: entry.text, synthetic: true });
  }
  if (skillInstructionText) parts.push({ type: 'text', text: skillInstructionText, synthetic: true });
  if (knowledgeText) parts.push({ type: 'text', text: knowledgeText, synthetic: true });
  if (item.agentMention) parts.push({ type: 'agent', name: item.agentMention });
  return parts;
}

async function postPromptRoute(
  sessionId: string,
  directory: string,
  item: QueueItem,
  slash: SlashResolution,
  knowledgeText: string | null,
): Promise<DeliveryOutcome> {
  const deliveredText = slash !== null && slash.kind === 'expandedCommand' && slash.template !== null
    ? expandCommandTemplate(slash.template, commandArgsOf(item.text, slash.name))
    : item.text; // template-less commands keep the raw invocation (registered E-09-4)
  const parts = assemblePromptParts(
    item,
    deliveredText,
    slash !== null && slash.kind === 'skill' ? skillInstruction(slash.name) : null,
    knowledgeText,
  );
  const body: Record<string, unknown> = {
    model: { providerID: item.sendConfig.providerID, modelID: item.sendConfig.modelID },
    parts,
  };
  if (item.sendConfig.agent) body.agent = item.sendConfig.agent;
  if (item.sendConfig.variant) body.variant = item.sendConfig.variant;
  return postSession(sessionId, directory, `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
}
