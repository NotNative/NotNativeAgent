// SPDX-License-Identifier: Apache-2.0
/** Draft-only project pin handoff at first material delivery. */
import { useSessionViewStore } from '../sync/view-store.ts';
import { readDraft, saveDraft } from './drafts.ts';
import { parseProjectContextPins, type ProjectContextPinTargets } from './project-context-pins.ts';
import { modelForCreatedSession } from './composer-model-config.ts';

type NewSessionLike = { id: string; metadata?: Record<string, unknown> };

export interface NewSessionDeliveryInput {
  directory: string;
  sourceKey: string;
  outgoing: ({ type: 'text'; text: string; synthetic?: boolean } |
    { type: 'file'; url?: string; filename?: string; mime?: string })[];
  delivery: 'steer' | null;
  model: { providerID: string; modelID: string };
  sendAgent: string;
  nnaConfigured: boolean;
  services: { engine: { actions: {
    send: (input: { directory: string; sessionID: string; parts: NewSessionDeliveryInput['outgoing'];
      model: { providerID: string; modelID: string }; agent?: string; delivery?: 'steer' }) => Promise<void>;
    createSession: (input: { directory: string; projectContextPins?: ProjectContextPinTargets }) => Promise<NewSessionLike>;
  } } };
}

export async function deliverToNewSession(input: NewSessionDeliveryInput): Promise<void> {
  const targets: ProjectContextPinTargets | undefined = input.sourceKey === 'draft'
    ? normalizeDraftProjectContextPins(readDraft(input.directory, 'draft').projectContextPins)
    : undefined;
  const hasTargets = Boolean(targets && (targets.notes.length > 0 || targets.plans.length > 0));
  const created = await input.services.engine.actions.createSession({
    directory: input.directory,
    ...(hasTargets ? { projectContextPins: targets } : {}),
  });
  await input.services.engine.actions.send({
    directory: input.directory, sessionID: created.id, parts: input.outgoing,
    model: modelForCreatedSession(created.metadata, input.nnaConfigured, input.model),
    agent: input.sendAgent,
  });
  useSessionViewStore.getState().setCurrentSession(created.id);
  useSessionViewStore.getState().setActiveDirectory(input.directory);
  if (hasTargets) {
    const draft = readDraft(input.directory, 'draft');
    saveDraft(input.directory, 'draft', { ...draft, projectContextPins: { notes: [], plans: [] } });
  }
}

/** P10-51 defaults tolerate old persisted drafts and malformed stored targets. */
function normalizeDraftProjectContextPins(value: unknown): ProjectContextPinTargets {
  return parseProjectContextPins({ project_context_pins: value });
}
