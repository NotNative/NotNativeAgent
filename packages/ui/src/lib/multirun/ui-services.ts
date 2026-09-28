// SPDX-License-Identifier: Apache-2.0
/** Real UI service adapter for the multi-run creation core (doc 12 §E.3). */
import type { ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import { toast } from 'sonner';
import { createWorktree, gitStatus, removeWorktree } from '../server-api.ts';
import { normalizeDirectory } from '../nnd/client.ts';
import { expandPrompt } from '../../chat/prompt-language.ts';
import { snippetMap } from '../snippets-source.ts';
import type { DirectoryStore } from '../../sync/types.ts';
import type { SyncEngine } from '../../sync/sync-engine.ts';
import type { MultiRunServices, MultiRunWorktree } from './create.ts';
import type { Session } from '../nnd/types.ts';

export interface MultiRunUiServicesInput {
  directory: string;
  engine: SyncEngine;
  store: StoreApi<DirectoryStore>;
}

export function sessionWorktreeMetadata(
  session: Session,
  worktree: MultiRunWorktree | undefined,
  projectDirectory?: string,
  createdFromBranch?: string | null,
): Record<string, unknown> | undefined {
  if (worktree === undefined) return undefined;
  return {
    ...session.metadata,
    createdFromBranch: createdFromBranch ?? session.metadata?.createdFromBranch ?? worktree.branch,
    kind: 'standard',
    projectDirectory: projectDirectory ?? session.metadata?.projectDirectory ?? session.directory,
  };
}

export function createMultiRunUiServices(input: MultiRunUiServicesInput): MultiRunServices {
  const directory = normalizeDirectory(input.directory);
  const store = input.store;
  let sourceBranch: string | null = null;
  return {
    directory: () => directory,
    isGitRepository: async (target) => {
      const status = await gitStatus(target);
      if (status === null) throw new Error('Unable to determine git status');
      if (normalizeDirectory(target) === directory) sourceBranch = status.branch;
      return status.isGitRepository;
    },
    createWorktree: async (request) => {
      if (request.setupCommands?.length) throw new Error('Worktree setup commands are not available yet');
      const outcome = await createWorktree(directory, {
        mode: 'new', branchName: request.branchName, worktreeName: request.worktreeName, startRef: request.startRef,
      });
      if (!outcome.ok) throw new Error(outcome.error);
      return { path: outcome.worktree.path, branch: outcome.worktree.branch };
    },
    removeWorktree: async ({ worktree }) => {
      const outcome = await removeWorktree(directory, worktree.path, worktree.branch !== null);
      if (!outcome.ok) throw new Error(outcome.error);
    },
    createSession: (request) => input.engine.actions.createSession(request),
    registerRun: (run) => {
      const sessionDirectory = input.engine.routingDirectoryOf?.(run.sessionID) ?? run.session.directory;
      const runStore = input.engine.childStoreOf?.(sessionDirectory) ?? store;
      registerWorktreeBackedRun(runStore, run.session, run.worktree, directory, sourceBranch);
    },
    expandPrompt: (text) => expandPrompt(text, snippetMap()),
    dispatchRun: async (request) => {
      await input.engine.actions.send({
        directory: request.run.directory,
        sessionID: request.run.sessionID,
        parts: [
          { type: 'text', text: request.expandedPrompt },
          ...request.files.map((file) => ({ type: 'file' as const, url: file.url, filename: file.filename, mime: file.mime })),
        ],
        model: {
          providerID: request.run.model.providerID,
          modelID: request.run.model.modelID,
          ...(request.run.model.variant ? { variant: request.run.model.variant } : {}),
        },
        ...(request.agent === undefined ? {} : { agent: request.agent }),
      });
    },
  };
}

export function registerWorktreeBackedRun(
  store: StoreApi<DirectoryStore>,
  session: Session,
  worktree: MultiRunWorktree | undefined,
  projectDirectory?: string,
  createdFromBranch?: string | null,
): void {
  const metadata = sessionWorktreeMetadata(session, worktree, projectDirectory, createdFromBranch);
  if (metadata === undefined) return;
  store.setState((state) => {
    const index = state.session.findIndex((entry) => entry.id === session.id);
    if (index < 0) return {};
    const next = [...state.session];
    next[index] = { ...next[index]!, metadata };
    return { session: next };
  });
}

export function reportMultiRunError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  toast.error(message);
}

export type MultiRunUiNode = ReactNode;
