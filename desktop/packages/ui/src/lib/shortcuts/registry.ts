// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut handler registry (doc 14 §I.2 registry.ts): active handler per
 * action is FIRST-bound; when the winner unregisters, the NEXT bound
 * handler re-acquires (the §I.4 contextual owners mount/unmount over a
 * browser-resident fallback). suspend/resume is nesting-safe.
 */
import { shortcutDecl } from './schema.ts';

type ShortcutHandler = (detail?: unknown) => void;

interface Registration {
  actionId: string;
  handler: ShortcutHandler;
}

const order: Registration[] = [];
let suspendDepth = 0;

function firstFor(actionId: string): Registration | null {
  return order.find((entry) => entry.actionId === actionId) ?? null;
}

export function registerShortcut(actionId: string, handler: ShortcutHandler): () => void {
  if (!shortcutDecl(actionId)) {
    throw new Error(`undeclared shortcut action: ${actionId}`);
  }
  if (firstFor(actionId)?.handler === handler) return () => removeRegistration(actionId, handler);
  const registration: Registration = { actionId, handler };
  order.push(registration);
  return () => removeRegistration(actionId, handler);
}

function removeRegistration(actionId: string, handler: ShortcutHandler): void {
  const index = order.findIndex((entry) => entry.actionId === actionId && entry.handler === handler);
  if (index >= 0) order.splice(index, 1); // next-in-line re-acquires by lookup order
}

export function unregisterShortcut(actionId: string): void {
  const first = firstFor(actionId);
  if (first) removeRegistration(actionId, first.handler);
}

export function activeShortcutHandler(actionId: string): ShortcutHandler | null {
  return firstFor(actionId)?.handler ?? null;
}

export function isShortcutRegistrySuspended(): boolean {
  return suspendDepth > 0;
}

/** Suspends ALL app handlers; nesting-safe with idempotent cleanup. */
export function suspendShortcutRegistry(suspended: boolean): void {
  suspendDepth = Math.max(0, suspendDepth + (suspended ? 1 : -1));
}

/** Test isolation: wipes registrations + suspension. */
export function __resetShortcutRegistryForTests(): void {
  order.splice(0, order.length);
  suspendDepth = 0;
}
