// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut React hooks + window router (doc 14 §I.2 useKeybind.ts + the
 * runtime router): one keydown listener per window (bubble for normal
 * chords, the digit-prefix router resolves first per §I.2), blur clears
 * the armed prefix, and every registration is component-lifetime.
 */
import { useEffect } from 'react';
import { registerShortcut } from './registry.ts';
import {
  cancelArmedShortcut,
  configureShortcutDispatcher,
  handleDigitPrefixKeydown,
  handleShortcutKeydown,
  resolveArmedPrefixForCapture,
} from './dispatcher.ts';

type ShortcutHandler = (detail?: unknown) => void;

let routerInstalled = false;
let bubbleListener: ((event: KeyboardEvent) => void) | null = null;
let captureListener: ((event: KeyboardEvent) => void) | null = null;
let blurListener: (() => void) | null = null;

export interface ShortcutRouterOptions {
  overrides?: Record<string, string>;
  mac?: boolean;
}

/**
 * Install ONE window router; per-window at app shell level. The capture
 * listener exists ONLY for armed-prefix second keys (§I.2) so inner
 * stopPropagation (app shell stopPropagation etc.) cannot kill sequences.
 * Module patterns: listen for the handler that lives/dispatches training.
 */
function onWindowKeydown(event: KeyboardEvent): void {
  // - Digit-prefix router first (§I.2 desktop resolves the digit prefixes
  //   before normal dispatch and falls through otherwise).
  handleDigitPrefixKeydown(event);
  if (event.defaultPrevented) return;
  handleShortcutKeydown(event);
}

function onWindowKeydownCapture(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  if (resolveArmedPrefixForCapture(event)) event.preventDefault();
}

function onWindowBlur(): void {
  cancelArmedShortcut();
}

export function installShortcutRouter(options: ShortcutRouterOptions = {}): void {
  configureShortcutDispatcher(options);
  if (routerInstalled || typeof window === 'undefined') return;
  routerInstalled = true;
  bubbleListener = onWindowKeydown;
  captureListener = onWindowKeydownCapture;
  blurListener = onWindowBlur;
  window.addEventListener('keydown', bubbleListener);
  window.addEventListener('keydown', captureListener, true);
  window.addEventListener('blur', blurListener);
}

export function uninstallShortcutRouterForTests(): void {
  if (bubbleListener) window.removeEventListener('keydown', bubbleListener);
  if (captureListener) window.removeEventListener('keydown', captureListener, true);
  if (blurListener) window.removeEventListener('blur', blurListener);
  bubbleListener = null;
  captureListener = null;
  blurListener = null;
  routerInstalled = false;
  cancelArmedShortcut();
}

/** Component-lifetime binding; rejects undeclared action ids. */
export function useKeybind(actionId: string, handler: ShortcutHandler): void {
  useEffect(() => {
    const off = registerShortcut(actionId, handler);
    return off;
  }, [actionId, handler]);
}

export function useKeybinds(bindings: Record<string, ShortcutHandler>): void {
  useEffect(() => {
    const offs = Object.entries(bindings).map(([actionId, handler]) => (handler ? registerShortcut(actionId, handler) : () => undefined));
    return () => {
      for (const off of offs) off();
    };
  }, [bindings]);
}
