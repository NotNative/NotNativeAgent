// SPDX-License-Identifier: Apache-2.0
/** Harness-backed H.2 assist ports using the bounded Small Model seam. */

import { createSessionReadPorts } from '../session-orchestration/session-harness-read-ports.ts';
import { createSessionWritePorts } from '../session-orchestration/session-harness-write-ports.ts';
import { generateSmallModel, type SmallModelPorts } from '../routes/small-model.ts';
import type { SessionAssistPorts } from './session-assist-runtime.ts';
import { readMergedSettings } from '../lib/settings-store.ts';

const MAX_OUTPUT_TOKENS = 800;
const MESSAGE_WINDOW = 40;

const ASSIST_SYSTEM_PROMPT = [
  'Return exactly one JSON object and nothing else — no prose, no markdown, no code fences.',
  'Shape: {"recap": string, "suggestion": string}.',
  'recap: at most 320 characters; concise factual turn summary.',
  'suggestion: at most 500 characters; one concise next action.',
  'Use double quotes for strings and no trailing commas.',
].join('\n');

interface SessionModelChoice {
  providerID: string;
  modelID: string;
}

export function createNnaSessionAssistPorts(smallModel: SmallModelPorts = {}):
  SessionAssistPorts {
  const read = createSessionReadPorts();
  const write = createSessionWritePorts();
  return {
    readSession: read.readSession,
    readMessages: async (sessionId, directory) => read.readMessages(sessionId, directory, MESSAGE_WINDOW),
    writeMetadata: async (sessionId, directory, assist) => {
      const session = objectOf(await read.readSession(sessionId, directory));
      if (session === null) return false;
      const baseMetadata = objectOf(session.metadata) ?? {};
      const openchamber = objectOf(baseMetadata.openchamber) ?? {};
      const result = await write.patchSession(sessionId, directory, {
        metadata: { ...baseMetadata, openchamber: { ...openchamber, assist } },
      });
      return objectOf(result) !== null;
    },
    generate: async ({ sessionId, directory, model, transcript }) => {
      const tail = await read.readMessages(sessionId, directory, MESSAGE_WINDOW);
      const resolved = model ?? sessionModelFrom(tail) ?? null;
      return generateAssist(smallModel, {
        sessionId, directory, model: resolved, transcript,
      });
    },
  };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function textOf(value: unknown, max = 256): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

async function generateAssist(smallModel: SmallModelPorts, input: {
  sessionId: string; directory: string;
  model: { providerID: string; modelID: string } | null;
  transcript: string;
}): Promise<{ recap: unknown; suggestion: unknown } | null> {
  const model = input.model ?? null;
  return generateSmallModel({
    prompt: input.transcript,
    system: ASSIST_SYSTEM_PROMPT,
    directory: input.directory,
    sessionID: input.sessionId,
    preferredProviderID: model?.providerID,
    preferredModelID: model?.modelID,
    restrictToPreferredProvider: model?.providerID !== undefined,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(smallModel === undefined ? {} : {}),
  }, smallModel).then(async (response) => {
    const raw = objectOf(await response.json().catch(() => null));
    if (raw === null || !response.ok) return null;
    const parsed = objectOf(JSON.parse(textOf(raw.text, 2_000)));
    if (parsed === null) return null;
    const settings = readMergedSettings('web');
    const recap = settings.sessionRecapEnabled === false ? undefined : boundedText(parsed.recap, 320);
    const suggestion = settings.sessionSuggestionEnabled === false ? undefined : boundedText(parsed.suggestion, 500);
    return recap === undefined && suggestion === undefined ? null : { recap, suggestion };
  }).catch(() => null);
}

function boundedText(value: unknown, max: number): string | undefined {
  const text = textOf(value, max);
  return text === '' ? undefined : text;
}

function splitSessionModel(value: string): SessionModelChoice | null {
  const index = value.indexOf('/');
  if (index < 0) return null;
  return { providerID: value.slice(0, index), modelID: value.slice(index + 1) };
}

function sessionModelFrom(messages: unknown[]): SessionModelChoice | null {
  for (const message of messages.slice().reverse()) {
    const info = objectOf(message)?.info;
    const shape = objectOf(info);
    if (shape?.role !== 'user') continue;
    const model = textOf(shape.model);
    return model === '' ? null : splitSessionModel(model);
  }
  return null;
}
