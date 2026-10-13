// SPDX-License-Identifier: Apache-2.0
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  origin?: string;
  platform?: string;
}
export interface PushApi {
  getVapidPublicKey(): Promise<{ publicKey: string }>;
  subscribe(subscription: PushSubscriptionInput): Promise<{ ok: true }>;
  unsubscribe(subscription: { endpoint: string }): Promise<{ ok: true }>;
  setVisibility(presence: { visible: boolean; platform?: string; clientId?: string; sequence?: number }): Promise<{ ok: true; badge?: PushBadge }>;
  getVisibility(): Promise<{ ok: true; visible: boolean }>;
  getBadge?(): Promise<PushBadge>;
  resetBadge?(sessionId: string, reason: 'view' | 'message-sent'): Promise<PushBadge>;
  setSessionViewed?(sessionId: string, viewed: boolean, clientId: string, sequence: number): Promise<{ badge?: PushBadge }>;
}
export interface PushBadge { count: number; epoch: string; revision: number }
