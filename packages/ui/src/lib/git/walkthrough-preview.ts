// SPDX-License-Identifier: Apache-2.0
/** Deterministic working-tree walkthrough from one server-owned snapshot. */
import { runtimeFetch } from '../runtime-fetch.ts';

export interface WalkthroughStopPreview {
  id: string;
  scope: 'staged' | 'working';
  path: string;
  header: string;
  oldStart: number;
  newStart: number;
  body: string;
}
export interface WalkthroughPreview { signature: string; stops: WalkthroughStopPreview[]; fileCount: number; binaryFiles: number }
export async function loadWalkthroughPreview(directory: string): Promise<WalkthroughPreview> {
  const response = await runtimeFetch(`/api/git/walkthrough-snapshot?directory=${encodeURIComponent(directory)}`);
  const payload = await response.json().catch(() => null) as WalkthroughPreview | { error?: string; code?: string } | null;
  if (!response.ok) throw new Error(payload && 'error' in payload && payload.error ? payload.error : `Git snapshot failed (${response.status}).`);
  if (!payload || !('signature' in payload) || !Array.isArray(payload.stops)) throw new Error('Invalid Git snapshot response.');
  return payload;
}
