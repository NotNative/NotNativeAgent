// SPDX-License-Identifier: Apache-2.0
import { browserPushApi } from '@notnative/ui/lib/push-api.ts';
﻿import type { RuntimeAPIs } from '@notnative/ui/lib/api/types.ts';
import { createRealTerminalApi } from '@notnative/ui/lib/api/terminal-adapter.ts';
import * as gitApi from '@notnative/ui/lib/git/server-api.ts';
import {
  createDirectory as createWorkspaceDirectory,
  deleteEntry,
  listDirectory as listWorkspaceDirectory,
  rawAssetUrl,
  readFileStat,
  readFileText,
  renameEntry,
  searchWorkspaceFiles,
  writeFileText,
} from '@notnative/ui/lib/files/server-api.ts';

async function loadSettings(): Promise<{ settings: Record<string, unknown>; source: 'desktop' | 'web' }> {
  try {
    const response = await fetch('/api/notnative/settings', { credentials: 'include' });
    if (!response.ok) return { settings: {}, source: 'web' };
    return (await response.json()) as { settings: Record<string, unknown>; source: 'web' };
  } catch {
    return { settings: {}, source: 'web' };
  }
}

async function saveSettings(changes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch('/api/notnative/settings', {
    method: 'PUT',
    credentials: 'include',
    body: JSON.stringify(changes) ?? '{}',
    headers: { 'content-type': 'application/json' },
  }).catch(() => null);
  if (!response || !response.ok) return {};
  const body = (await response.json().catch(() => null)) as { settings?: Record<string, unknown> } | null;
  return body?.settings ?? {};
}

export function createWebAPIs(): RuntimeAPIs {
  return {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: 'web' },
    push: browserPushApi,
    terminal: createRealTerminalApi(), // SLICE-B: the live PTY seam over the terminal lib (doc 07)
    git: createWebGitApi(),
    files: {
      listDirectory: listWorkspaceDirectory,
      search: searchWorkspaceFiles,
      readFileStat,
      readFileText,
      writeFileText,
      rawAssetUrl,
      createDirectory: createWorkspaceDirectory,
      deleteEntry,
      renameEntry,
    },

    settings: { load: loadSettings, save: saveSettings },
    permissions: {
      requestDirectoryAccess: async () => true,
      startAccessingDirectory: async () => undefined,
      stopAccessingDirectory: async () => undefined,
    },
    notifications: {
      async notifyAgentCompletion(payload) {
        try {
          const desktopInvoke = window.__NOTNATIVE_DESKTOP_INVOKE__;
          if (typeof desktopInvoke === 'function') {
            const result = await desktopInvoke('desktop_notify', payload);
            return result.ok === true && (result.result as { shown?: unknown } | undefined)?.shown === true;
          }
          if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
            return false;
          }
          new Notification(payload?.title ?? 'NotNativeDesktop', { body: payload?.body ?? '' });
          return true;
        } catch {
          return false;
        }
      },
      canNotify() {
        return typeof Notification !== 'undefined' && Notification.permission === 'granted';
      },
    },
    tools: {
      async getAvailableTools() {
        return ['mock-read', 'mock-echo'];
      },
    },
  };
}

function createWebGitApi(): RuntimeAPIs['git'] {
  return {
    fetchGitStatus: gitApi.fetchGitStatus,
    fetchGitBranches: gitApi.fetchGitBranches,
    checkoutLocalBranch: gitApi.checkoutLocalBranch,
    createLocalBranch: gitApi.createLocalBranch,
    fetchGitLog: gitApi.fetchGitLog,
    fetchGitDiff: gitApi.fetchGitDiff,
    fetchGitFileDiff: gitApi.fetchGitFileDiff,
    stageGitFiles: gitApi.stageGitFiles,
    unstageGitFiles: gitApi.unstageGitFiles,
    discardGitFiles: gitApi.discardGitFiles,
    applyGitHunk: gitApi.applyGitHunk,
    commitChanges: gitApi.commitChanges,
    syncGitBranch: gitApi.syncGitBranch,
  };
}
