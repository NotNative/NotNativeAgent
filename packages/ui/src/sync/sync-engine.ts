// SPDX-License-Identifier: Apache-2.0
/**
 * Sync engine facade (doc 04 §I): mounts the engine parts (engine-instance)
 * behind the stable SyncEngine surface. React bindings and the layout demand
 * driver arrive with doc 05.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { HarnessEvent } from '../lib/nnd/events.ts';
import type { DirectoryStore } from './types.ts';
import type { ChildStoreManager } from './child-store.ts';
import type { SessionMessageLoader } from './session-message-loader.ts';
import type { EventPipeline } from './event-pipeline.ts';
import type { EventRoutingIndex } from './routing-index.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { buildEngineParts } from './engine-instance.ts';
import { installPersistLifecycleFlush } from './persist-cache.ts';
import { useSessionViewStore } from './view-store.ts';
import type { SessionActionsApi } from './engine-actions.ts';

export interface SyncEngine {
  manager: ChildStoreManager;
  loader: SessionMessageLoader;
  routing: EventRoutingIndex;
  pipeline: () => EventPipeline | null;
  start: () => Promise<void>;
  dispose: () => void;
  rebootstrapActive: () => void;
  waitForConnection: () => Promise<void>;
  handleHarnessEventDirect: (event: HarnessEvent, directory?: string) => void;
  childStoreOf: (directory: string) => StoreApi<DirectoryStore> | undefined;
  routingDirectoryOf: (sessionID: string) => string | undefined;
  resyncAfterStreamGap: (reason: string) => Promise<void>;
  materializerStats: () => { pending: number };
  routeEvent: (event: HarnessEvent) => string;
  actions: SessionActionsApi;
}

export type { SessionActionsApi };

export function createSyncEngine(transport: 'auto' | 'ws' | 'sse' = 'auto'): SyncEngine {
  installPersistLifecycleFlush();
  const parts = buildEngineParts(transport);
  return {
    manager: parts.manager,
    loader: parts.loader,
    routing: parts.routing,
    pipeline: parts.pipelineRef,
    start: parts.start,
    dispose: parts.dispose,
    rebootstrapActive: () => {
      const dir = normalizeDirectory(useSessionViewStore.getState().activeDirectory);
      parts.manager.requestBootstrap({ directory: dir, priority: 0, reason: 'action-demand', force: true });
    },
    waitForConnection: parts.waitForConnection,
    handleHarnessEventDirect: (event, directory) => parts.handleFlush(directory ?? '', [event]),
    childStoreOf: (directory) => parts.manager.children.get(normalizeDirectory(directory)),
    routingDirectoryOf: (sessionID) => parts.routing.sessionDirectoryById.get(sessionID),
    resyncAfterStreamGap: parts.resyncAfterStreamGap,
    materializerStats: () => ({ pending: parts.materializerPending() }),
    routeEvent: parts.routeEvent,
    actions: parts.actions,
  };
}
