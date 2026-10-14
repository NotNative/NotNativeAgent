// SPDX-License-Identifier: Apache-2.0
/**
 * Head dispatch (doc 12 §D.3.6): delivers ONE queue head through the HP-1
 * adapter seam. Slash commands resolve NND-side: skill-shaped names against
 * NNA's served `/v1/nnd/skills` inventory (then the harness catalog where a
 * harness still serves one), non-skill commands against the catalog
 * template — every delivery rides `prompt_async` with the exact §D.3.6 part
 * order and the §B.8 argument expansion.
 * Why: NNA owns no command-execution concept — `/command` and
 * `POST /session/:id/command` are dead routes against real NNA (ingress
 * types are a closed set; the engine treats content as plain prompt text;
 * no template grammar). NND expands its own §B.8 grammar and delivers
 * plain prompts; without a served template there is nothing to expand, so
 * the head degrades to plain prose, never a fabricated command.
 * Knowledge resolves through the `ProjectKnowledgeProvider` seam;
 * `recordDelivered` runs ONLY after an accepted prompt (a rejected dispatch
 * carries the knowledge again; a lookup failure sends without it).
 */
import { harnessRequest, callHarness, callHarnessJson } from './queue-adapter-calls.ts';
import { commandArgsOf, commandNameOf, expandCommandTemplate } from './queue-expansion.ts';
import { QUEUE_ITEM_ID_PATTERN } from './queue-item.ts';
import type { ProjectKnowledgeProvider } from './queue-hooks.ts';
import type { QueueItem } from './queue-item.ts';

/** dispatch resolution: skill instruction / expanded template text / prose. */
export type SlashResolution
  = { kind: 'skill'; name: string }
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
  const knowledgeText = await resolveKnowledge(sessionId, directory, knowledge);
  const outcome = await postPromptRoute(sessionId, directory, item, slash, knowledgeText);
  // knowledge delivery records only AFTER the prompt is accepted (§D.3.6)
  if (outcome.ok && knowledgeText !== null) knowledge.recordDelivered(sessionId, directory);
  return outcome;
}

async function resolveSlash(item: QueueItem, directory: string): Promise<SlashResolution> {
  if (!item.text.startsWith('/')) return null;
  const name = commandNameOf(item.text);
  if (!name) return null;
  // Why: real NNA serves no `GET /command` catalog and no command-execution
  // route (ingress is a closed prompt-text set). NND resolves skill-shaped
  // names against NNA's served `/v1/nnd/skills` inventory; non-skill
  // commands expand ONLY where a catalog with a template is actually served
  // (mock harness, or a future served catalog). Every fallback is the
  // existing catalog-miss path: plain prose through prompt_async.
  const skills = await callHarnessJson(harnessRequest('/v1/nnd/skills', directory, { method: 'GET' }));
  if (skillEntryOf(skills, name)) return { kind: 'skill', name };
  const catalog = await callHarnessJson(harnessRequest('/command', directory, { method: 'GET' }));
  const entry = commandEntryOf(catalog, name);
  if (!entry) return null; // catalog miss: plain prose delivery
  const template = typeof entry.template === 'string' && entry.template !== '' ? entry.template : null;
  if (entry.source === 'skill') return { kind: 'skill', name };
  return { kind: 'expandedCommand', name, template }; // expansion replaces the delivered text
}

/** The inventory entry `skills[].id` matching the invocation name, if NNA
 *  serves the inventory and names it (id/version/description/invocation). */
function skillEntryOf(skills: unknown, name: string): boolean {
  const inventory = asRecord(skills);
  if (!Array.isArray(inventory?.skills)) return false;
  for (const entry of inventory.skills) {
    const record = asRecord(entry);
    if (record !== null && record.id === name) return true;
  }
  return false;
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
  // F9: the queue item id is the submission's idempotency identity — NNA
  // treats a repeat of a persisted submission as an accepted duplicate (204),
  // so an acceptance-unknown retry of the same head never opens a second turn.
  // Ids from before the bounded-id rule simply ride without the identity.
  if (QUEUE_ITEM_ID_PATTERN.test(item.id)) body.messageID = item.id;
  if (item.sendConfig.agent) body.agent = item.sendConfig.agent;
  // Why: no variant on the prompt route — NNA rejects per-prompt variant (nnd_variant_override_unsupported).
  return postSession(sessionId, directory, `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
}
