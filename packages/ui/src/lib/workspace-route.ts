// SPDX-License-Identifier: Apache-2.0
import { create } from 'zustand';
import { SETTINGS_PAGE_ORDER, type SettingsPageSlug } from '../components/settings/search.ts';
import { routeSessionId } from './session-route.ts';

export type WorkspaceTab = 'chat' | 'git' | 'diff' | 'terminal' | 'files';
export interface WorkspaceRoute { settings: SettingsPageSlug | null; session: string | null; tab: WorkspaceTab | null; file: string | null }
export function parseWorkspaceRoute(search: string): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const slug = params.get('settings')?.trim().toLowerCase();
  const settings = slug ? SETTINGS_PAGE_ORDER.find((page) => page.slug === slug)?.slug ?? 'general' : null;
  const rawTab = params.get('tab');
  const tab = ['chat', 'git', 'diff', 'terminal', 'files'].includes(rawTab ?? '') ? rawTab as WorkspaceTab : null;
  const rawFile = params.get('file');
  const file = rawFile && rawFile.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(rawFile) ? rawFile : null;
  return { settings, session: routeSessionId(params.get('session')), tab, file };
}

/** Only session/settings are serialized; host-owned parameters and hashes survive. */
export function workspaceRouteUrl(href: string, session: string | null, settings: SettingsPageSlug | null): URL {
  const url = new URL(href);
  for (const key of ['session', 'settings', 'tab', 'file']) url.searchParams.delete(key);
  if (settings) url.searchParams.set('settings', settings);
  else if (session) url.searchParams.set('session', session);
  return url;
}

export interface ContextRouteRequest {
  runtime: string; directory: string; session: string | null; tab: WorkspaceTab; file: string | null; revision: number;
}
export const useContextRouteStore = create<{ request: ContextRouteRequest | null }>(() => ({ request: null }));
let revision = 0;
export function requestContextRoute(input: Omit<ContextRouteRequest, 'revision'>): void {
  useContextRouteStore.setState({ request: { ...input, revision: ++revision } });
}
