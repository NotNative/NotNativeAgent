// SPDX-License-Identifier: Apache-2.0
/** Compaction restoration runtime (doc 15 §G.2). */
import {
  OBLIGATORY_NAMESPACE,
  mergeObligatoryCursor,
  parseObligatoryMessages,
  readObligatoryCursor,
  type ObligatoryMessage,
} from './obligatory-messages.ts';
import type { QueueFeed, QueueEnvelope } from '../queue/queue-feed.ts';

const MESSAGE_LIMIT = 20;

export interface KnowledgePreparation {
  text: string;
  signature: string;
}

export interface ContextRestorationPorts {
  readSession(sessionId: string, directory: string): Promise<unknown>;
  readMessages(sessionId: string, directory: string, limit: number): Promise<unknown>;
  readMessage(sessionId: string, directory: string, messageId: string): Promise<unknown>;
  resetKnowledgeDelivery(sessionId: string, directory: string): void;
  prepareKnowledge(sessionId: string, directory: string): Promise<KnowledgePreparation | null>;
  sendPrompt(sessionId: string, directory: string, body: unknown): Promise<{ ok: boolean }>;
  writeCursor(sessionId: string, directory: string, cursorPatch: Record<string, unknown>): Promise<boolean>;
}

export class ContextObligatoryRuntime {
  private readonly ports: ContextRestorationPorts;
  private readonly feed: QueueFeed;
  private readonly knowledge: (sessionId: string, directory: string) => void;
  private readonly ticking = new Set<string>();
  private stopped = false;
  private unsubs: Array<() => void> = [];

  constructor(
    feed: QueueFeed, ports: ContextRestorationPorts,
    knowledgeDelivered: (sessionId: string, directory: string) => void = () => undefined,
  ) {
    this.feed = feed;
    this.ports = ports;
    this.knowledge = knowledgeDelivered;
  }

  start(): void {
    this.stopped = false;
    this.unsubs.push(this.feed.onEvent((envelope) => this.onEnvelope(envelope)));
    this.feed.start?.();
  }

  dispose(): void {
    this.stopped = true;
    for (const unsubscribe of [...this.unsubs]) unsubscribe();
    this.unsubs = [];
    this.ticking.clear();
    this.feed.stop?.();
  }

  onEnvelope(envelope: QueueEnvelope): void {
    if (this.stopped || envelope.payload.type !== 'session.compacted') return;
    const sessionId = typeof envelope.payload.properties.sessionID === 'string'
      ? envelope.payload.properties.sessionID : '';
    if (sessionId === '' || typeof envelope.directory !== 'string' || envelope.directory === '') return;
    void this.tick(sessionId, envelope.directory);
  }

  async tick(sessionId: string, directory: string): Promise<boolean> {
    const key = `${directory}|${sessionId}`;
    if (this.stopped || this.ticking.has(key)) return false;
    this.ticking.add(key);
    try {
      const session = await this.ports.readSession(sessionId, directory);
      if (!isRecord(session)) return false;
      const parentID = session.parentID;
      if (typeof parentID === 'string' && parentID !== '') return false;
      const metadata = isRecord(session.metadata) ? session.metadata : {};
      const pins = parseObligatoryMessages(metadata);
      this.ports.resetKnowledgeDelivery(sessionId, directory);
      const knowledge = await this.ports.prepareKnowledge(sessionId, directory);
      if (pins.length === 0 && (knowledge === null || knowledge.text.trim() === '')) return false;

      const entries = await this.ports.readMessages(sessionId, directory, MESSAGE_LIMIT);
      if (!Array.isArray(entries)) return false;
      const summaryId = newestSummaryId(entries);
      if (summaryId === null) return false;
      if (readObligatoryCursor(metadata) === summaryId) return false;

      const restored = await this.restorePins(sessionId, directory, pins);
      if (pins.length > 0 && restored.length === 0 && (knowledge === null || knowledge.text.trim() === '')) return false;
      const model = preCompactionModel(entries);
      if (model === null) return false;

      const promptId = `context-${summaryId}`;
      const accepted = await this.ports.sendPrompt(sessionId, directory, {
        model: { providerID: model.providerID, modelID: model.modelID },
        ...(model.agent !== null ? { agent: model.agent } : {}),
        parts: [{ type: 'text', synthetic: true, text: assembledPrompt(promptId, knowledge, restored) }],
      });
      if (!accepted.ok) return false;
      const cursor = mergeObligatoryCursor({}, summaryId, knowledge?.signature ?? null);
      const written = await this.ports.writeCursor(sessionId, directory,
        cursor[OBLIGATORY_NAMESPACE] as Record<string, unknown>);
      if (written && knowledge !== null) this.knowledge(sessionId, directory);
      return written;
    } catch {
      return false;
    } finally {
      this.ticking.delete(key);
    }
  }

  private async restorePins(
    sessionId: string, directory: string, pins: ObligatoryMessage[],
  ): Promise<Array<ObligatoryMessage & { text: string }>> {
    const fetched = await Promise.allSettled(pins.map((pin) =>
      this.ports.readMessage(sessionId, directory, pin.id)));
    const byId = new Map<string, string>();
    for (const result of fetched) {
      if (result.status !== 'fulfilled') continue;
      const entry = result.value;
      if (!isMessageEntry(entry)) continue;
      const text = messageText(entry);
      if (text !== null) byId.set(entry.info.id, text);
    }
    return [...pins].sort((left, right) => left.createdAt - right.createdAt).flatMap((pin) => {
      const text = byId.get(pin.id);
      return text !== undefined ? [{ ...pin, text }] : [];
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMessageEntry(
  entry: unknown,
): entry is { info: { id: string; role: string; agent?: unknown; providerID?: unknown;
  modelID?: unknown; time: Record<string, unknown> }; parts: unknown[] } {
  if (!isRecord(entry) || !isRecord(entry.info) || !isRecord(entry.info.time)) return false;
  if (typeof entry.info.id !== 'string' || entry.info.id === '') return false;
  if (typeof entry.info.role !== 'string') return false;
  if (!Array.isArray(entry.parts)) return false;
  if (entry.info.summary === true) return false;
  if (typeof entry.info.time.completed !== 'number') return false;
  return true;
}

function messageText(entry: unknown): string | null {
  if (!isMessageEntry(entry)) return null;
  return entry.parts
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter((text) => text !== '')
    .join('\n\n')
    .trim() || null;
}

function newestSummaryId(entries: unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!isRecord(entry) || !isRecord(entry.info) || !isRecord(entry.info.time)) continue;
    if (entry.info.summary !== true || typeof entry.info.id !== 'string') continue;
    if (typeof entry.info.time.completed !== 'number') continue;
    return `${entry.info.id}`;
  }
  return null;
}

function preCompactionModel(entries: unknown[]): {
  providerID: string; modelID: string; agent: string | null;
} | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (!isMessageEntry(entry) || (isRecord(entry.info) ? entry.info.role : '') !== 'assistant') continue;
    const info = (entry as { info: Record<string, unknown> }).info;
    const providerID = info.providerID;
    const modelID = info.modelID;
    if (typeof providerID !== 'string' || providerID === '' || typeof modelID !== 'string' || modelID === '') return null;
    const agent = typeof info.agent === 'string' && info.agent !== '' ? info.agent
      : typeof info.mode === 'string' && info.mode !== '' ? info.mode : null;
    return { providerID, modelID, agent };
  }
  return null;
}

function assembledPrompt(
  promptId: string, knowledge: KnowledgePreparation | null,
  pins: Array<ObligatoryMessage & { text: string }>,
): string {
  const sections: string[] = [];
  if (knowledge !== null && knowledge.text.trim() !== '') sections.push(knowledge.text.trim());
  if (pins.length > 0) {
    sections.push([
      `Important-context restore ${promptId}. The following messages are from the compacted conversation.`,
      'The user explicitly marked them as important and required in your context. Pay close attention to them; they may have been sent by either the user or you before compaction.',
      'Use them while continuing the pre-compaction work. Do not treat this context restoration as a new standalone task.',
      'If any tasks or next steps remain, do not acknowledge, summarize, or mention this restored context in a separate response. Simply continue the work and use it silently as background context. Do not append a recap of it after completing those tasks. Only if no tasks or next steps remain, give the user a very brief summary of the important restored context in no more than one short paragraph, without lists or a detailed recap.',
      '',
      pins.map((pin) => `## ${pin.role} — ${new Date(pin.createdAt).toISOString()}\n\n${pin.text}`).join('\n\n---\n\n'),
    ].join('\n'));
  }
  return sections.join('\n\n---\n\n');
}
