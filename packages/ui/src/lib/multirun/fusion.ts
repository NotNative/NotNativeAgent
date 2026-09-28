// SPDX-License-Identifier: Apache-2.0
/**
 * UI-owned fusion orchestration (doc 12 §E.5). Fusion sessions are linked only
 * through their titles; all source outputs and instructions ride in prompt
 * content so the operation works with an ordinary harness conversation.
 */
import { normalizeDirectory } from '../nnd/client.ts';
import type { DirectoryStore } from '../../sync/types.ts';
import type { AssistantMessage, MessageEntry, Part, Session } from '../nnd/types.ts';
import { buildFusionSessionTitle, parseMultiRunSessionTitle } from './title.ts';
import type { StoreApi } from 'zustand/vanilla';

export type FusionIdentity = ReturnType<typeof parseMultiRunSessionTitle> & { fusion: false };

export interface FusionModelSelection { providerID: string; modelID: string; variant?: string | null; }

export interface FusionSource {
  session: Session;
  projectDirectory: string;
  sessionDirectory: string;
}

export interface FusionOutput {
  source: FusionSource;
  title: string;
  text: string;
}

export interface FusionPromptPart {
  type: 'text';
  text: string;
  synthetic?: boolean;
}

export interface FusionCandidateServices {
  /** Live per-directory stores. The UI passes current + routed child stores. */
  storeOfDirectory: (directory: string) => StoreApi<DirectoryStore> | undefined;
  directoryOfSession: (sessionID: string) => string | undefined;
  globalActive: () => Session[];
  globalArchived: () => Session[];
  currentStore: () => StoreApi<DirectoryStore>;
}

export interface FusionStartServices {
  candidates: FusionCandidateServices;
  createSession: (input: { directory: string; title: string }) => Promise<Session>;
  selectCurrentSession: (input: { sessionID: string; directory: string }) => void;
  closeDialog: () => void;
  listMessages: (input: { sessionID: string; directory: string; limit: number }) => Promise<MessageEntry[]>;
  listMagicPromptOverrides: () => Promise<Record<string, string>>;
  send: (input: {
    directory: string;
    sessionID: string;
    parts: Array<FusionPromptPart>;
    model: { providerID: string; modelID: string; variant?: string };
    agent?: string;
  }) => Promise<void>;
}

export interface StartFusionParams {
  trigger: Session;
  identity: FusionIdentity;
  model: FusionModelSelection;
  agent?: string;
}

export interface FusionLaunchResult {
  session: Session;
  title: string;
  outputs: FusionOutput[];
  sourceCount: number;
}

const FUSION_VISIBLE_ID = 'session.fusion.visible';
const FUSION_INSTRUCTIONS_ID = 'session.fusion.instructions';
const MESSAGE_LIMIT = 50;

const DEFAULT_FUSION_VISIBLE = 'Reconcile the following {{sourceCount}} competing outputs into a single final answer.';
const DEFAULT_FUSION_INSTRUCTIONS = 'The results below are competing outputs for the same request. Preserve correct work, reconcile contradictions, explain material disagreements, and produce the best final answer.';
const FUSION_INPUT_END = '\n\n--- FUSION INPUTS END ---\nNow write the final fused answer.';

export function isFusionEntry(session: Session): boolean {
  return parseMultiRunSessionTitle(session.title ?? '').fusion === false;
}

export function fusionIdentityFromSession(session: Session): FusionIdentity | null {
  try {
    const parsed = parseMultiRunSessionTitle(session.title ?? '');
    return parsed.fusion ? null : {
      groupSlug: parsed.groupSlug,
      ...(parsed.runGroup === undefined ? {} : { runGroup: parsed.runGroup }),
      providerID: parsed.providerID,
      modelID: parsed.modelID,
      fusion: false,
    };
  } catch {
    return null;
  }
}

function metadataProjectDirectory(session: Session): string | undefined {
  const value = session.metadata?.projectDirectory;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function projectDirectory(session: Session): string {
  return normalizeDirectory(metadataProjectDirectory(session) ?? session.directory ?? '');
}

function sessionDirectory(session: Session): string {
  return normalizeDirectory(session.directory ?? '');
}

export function collectFusionSources(trigger: Session, services: FusionCandidateServices): FusionSource[] {
  const identity = parseMultiRunSessionTitle(trigger.title ?? '');
  const triggerProject = projectDirectory(trigger);
  const byId = new Map<string, FusionSource>();
  const sourceProject = (session: Session): string => projectDirectory(session);
  const live = new Map([...services.globalActive(), ...services.globalArchived()]
    .map((session) => [session.id, session]));
  for (const session of [trigger, ...live.values(), ...services.currentStore().getState().session]) {
    if (byId.has(session.id)) continue;
    const parsed = parseMultiRunSessionTitle(session.title ?? '');
    if (parsed.fusion) continue;
    if (parsed.groupSlug !== identity.groupSlug) continue;
    if ((parsed.runGroup ?? undefined) !== (identity.runGroup ?? undefined)) continue;
    const candidateProject = sourceProject(session);
    if (!candidateProject || candidateProject !== triggerProject) continue;
    byId.set(session.id, {
      session,
      projectDirectory: candidateProject,
      sessionDirectory: sessionDirectory(session),
    });
  }
  return [...byId.values()].sort((left, right) =>
    (left.session.time.created ?? Number.MAX_SAFE_INTEGER) - (right.session.time.created ?? Number.MAX_SAFE_INTEGER)
    || left.session.id.localeCompare(right.session.id));
}

export function extractAssistantText(entries: readonly MessageEntry[]): string {
  const assistants = [...entries]
    .filter((entry): entry is MessageEntry & { info: AssistantMessage } => (
      entry.info.role === 'assistant' && entry.info.error === undefined
    ))
    .sort((left, right) =>
      (left.info.time.completed ?? left.info.time.created) - (right.info.time.completed ?? right.info.time.created)
      || left.info.id.localeCompare(right.info.id));
  const candidate = assistants.length === 0 ? undefined : assistants[assistants.length - 1];
  if (candidate === undefined) return '';
  return textFromParts(candidate.parts);
}

function textFromParts(parts: readonly Part[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is Part & { type: 'text'; text: string } => (
      part.type === 'text' && part.synthetic !== true && part.ignored !== true
    ))
    .map((part) => part.text).join('\n').trim();
}

function localAssistantText(store: StoreApi<DirectoryStore>, sessionID: string): string {
  const state = store.getState();
  const messages = state.message[sessionID];
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const entries: MessageEntry[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    entries.push({ info: message, parts: state.part[message.id] ?? [] });
  }
  return extractAssistantText(entries);
}

export async function resolveFusionOutputs(
  sources: FusionSource[],
  services: Pick<FusionCandidateServices, 'storeOfDirectory' | 'directoryOfSession'> & Pick<FusionStartServices, 'listMessages'>,
): Promise<FusionOutput[]> {
  const outputs: FusionOutput[] = [];
  for (const source of sources) {
    const store = services.storeOfDirectory(source.sessionDirectory);
    const text = (store ? localAssistantText(store, source.session.id) : '')
      || await remoteAssistantText(source, services);
    if (text.length === 0) continue;
    outputs.push({ source, title: source.session.title || source.session.id, text });
  }
  return outputs;
}

async function remoteAssistantText(
  source: FusionSource,
  services: Pick<FusionCandidateServices, 'storeOfDirectory' | 'directoryOfSession'> & Pick<FusionStartServices, 'listMessages'>,
): Promise<string> {
  const directory = services.directoryOfSession(source.session.id) ?? source.sessionDirectory;
  const entries = await services.listMessages({ sessionID: source.session.id, directory, limit: MESSAGE_LIMIT });
  return extractAssistantText(entries);
}

export function renderMagicPrompt(template: string, variables: Record<string, string>): string {
  let rendered = '';
  let cursor = 0;
  while (cursor < template.length) {
    const opening = template.indexOf('{{', cursor);
    if (opening === -1) {
      rendered += template.slice(cursor);
      break;
    }
    rendered += template.slice(cursor, opening);
    const closing = template.indexOf('}}', opening + 2);
    if (closing === -1) {
      rendered += template.slice(opening);
      break;
    }
    const key = template.slice(opening + 2, closing).trim();
    rendered += Object.hasOwn(variables, key) ? variables[key] ?? '' : template.slice(opening, closing + 2);
    cursor = closing + 2;
  }
  return rendered;
}

export function composeFusionPrompt(outputs: FusionOutput[], overrides: Record<string, string> = {}): {
  visibleParts: FusionPromptPart[];
  hiddenParts: Array<FusionPromptPart>;
} {
  const sourceCount = String(outputs.length);
  const sourceLabels = outputs.map((output, index) => `${index + 1}. ${output.title}`).join('\n');
  const visibleTemplate = overrides[FUSION_VISIBLE_ID] ?? DEFAULT_FUSION_VISIBLE;
  const visible = renderMagicPrompt(visibleTemplate, { sourceCount, sourceLabels });
  const instructionsTemplate = overrides[FUSION_INSTRUCTIONS_ID] ?? DEFAULT_FUSION_INSTRUCTIONS;
  const hiddenParts: Array<FusionPromptPart> = [{
    type: 'text',
    text: renderMagicPrompt(instructionsTemplate, { sourceCount, sourceLabels }),
    synthetic: true,
  }];
  outputs.forEach((output, index) => {
    hiddenParts.push({
      type: 'text',
      text: `\n\n--- RESULT ${index + 1}: ${output.title} ---\n${output.text}\n--- END RESULT ${index + 1} ---`,
      synthetic: true,
    });
  });
  hiddenParts.push({ type: 'text', text: FUSION_INPUT_END, synthetic: true });
  return { visibleParts: [{ type: 'text', text: visible }], hiddenParts };
}

export function fusionSessionTitle(identity: FusionIdentity, model: FusionModelSelection): string {
  return buildFusionSessionTitle({
    groupSlug: identity.groupSlug,
    ...(identity.runGroup === undefined ? {} : { runGroup: identity.runGroup }),
    providerID: model.providerID,
    modelID: model.modelID,
  });
}

export async function startFusion(params: StartFusionParams, services: FusionStartServices): Promise<FusionLaunchResult> {
  const { model } = params;
  if (typeof model?.providerID !== 'string' || model.providerID.length === 0
    || typeof model.modelID !== 'string' || model.modelID.length === 0) {
    throw new Error('Choose a fusion model');
  }
  const sources = collectFusionSources(params.trigger, services.candidates);
  const outputs = await resolveFusionOutputs(sources, {...services.candidates, listMessages: services.listMessages});
  if (outputs.length === 0) throw new Error('no outputs');
  const overrides = await services.listMagicPromptOverrides();
  const title = fusionSessionTitle(params.identity, model);
  const directory = sources[0]?.projectDirectory ?? projectDirectory(params.trigger);
  if (!directory) throw new Error('Fusion requires a project directory');
  const session = await services.createSession({ directory, title });
  const createdDirectory = normalizeDirectory(session.directory ?? directory);
  services.selectCurrentSession({ sessionID: session.id, directory: createdDirectory });
  services.closeDialog();
  const prompt = composeFusionPrompt(outputs, overrides);
  await services.send({
    directory: createdDirectory,
    sessionID: session.id,
    parts: [...prompt.visibleParts, ...prompt.hiddenParts],
    model: {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(model.variant ? { variant: model.variant } : {}),
    },
    ...(params.agent === undefined || params.agent.length === 0 ? {} : { agent: params.agent }),
  });
  return { session, title, outputs, sourceCount: outputs.length };
}
