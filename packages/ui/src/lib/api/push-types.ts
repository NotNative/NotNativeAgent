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
  setVisibility(presence: { visible: boolean; platform?: string }): Promise<{ ok: true }>;
  getVisibility(): Promise<{ ok: true; visible: boolean }>;
}
