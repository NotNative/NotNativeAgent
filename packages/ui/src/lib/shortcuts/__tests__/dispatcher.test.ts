// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Shortcut dispatcher gates (doc 14 §I.2): single-chord dispatch, mod+k
 * sequence arming (3000 ms expiry, blur/mismatch/Escape rules), digit
 * prefixes before normal chords, editable-target policy (plain chords
 * yield; Cmd/Ctrl chords don't; Escape abort works), IME composition
 * yields, registry first-wins + suspension.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  armedShortcutActionId,
  cancelArmedShortcut,
  configureShortcutDispatcher,
  handleDigitPrefixKeydown,
  handleShortcutKeydown,
} from '../dispatcher.ts';
import {
  __resetShortcutRegistryForTests,
  registerShortcut,
  suspendShortcutRegistry,
  unregisterShortcut,
  activeShortcutHandler,
} from '../registry.ts';
import { installShortcutRouter, uninstallShortcutRouterForTests } from '../hooks.ts';

function keyEvent(partial: KeyboardEventInit & { keyCode?: number; target?: HTMLElement }): KeyboardEvent {
  const { target, ...init } = partial;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, 'target', { value: target ?? document.body });
  return event;
}

const HANDLERS: Record<string, ReturnType<typeof vi.fn>> = {};
let offs: (() => void)[] = [];

function register(actionId: string): void {
  const handler = vi.fn();
  HANDLERS[actionId] = handler;
  offs.push(registerShortcut(actionId, handler));
}

beforeEach(() => {
  __resetShortcutRegistryForTests();
  cancelArmedShortcut();
  configureShortcutDispatcher({ mac: false });
  for (const off of offs) off();
  offs = [];
  for (const handler of Object.values(HANDLERS)) handler.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  uninstallShortcutRouterForTests();
});

describe('single-chord dispatch (§I.2 dispatcher)', () => {
  it('dispatches mod+i when the handler is registered, else no-ops', () => {
    register('focus_input');
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(1);
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true })); // still registered
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(2);
    handleShortcutKeydown(keyEvent({ key: 'o', ctrlKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(2);
  });

  it('first registration wins until unregistered', () => {
    register('focus_input');
    const second = vi.fn();
    const offSecond = registerShortcut('focus_input', second);
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    offSecond();
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(second).not.toHaveBeenCalled();
    unregisterShortcut('focus_input');
    expect(activeShortcutHandler('focus_input')).toBeNull();
    // third registration now wins after explicit unregister
    const third = vi.fn();
    registerShortcut('focus_input', third);
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(third).toHaveBeenCalledOnce();
  });

  it('suspension stops ALL app handlers (nested OK)', () => {
    register('focus_input');
    suspendShortcutRegistry(true);
    suspendShortcutRegistry(true);
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.focus_input).not.toHaveBeenCalled();
    suspendShortcutRegistry(false);
    suspendShortcutRegistry(false);
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(1);
  });

  it('runs with an override binding (mod+u moves focus_input)', () => {
    register('focus_input');
    configureShortcutDispatcher({ overrides: { focus_input: 'mod+u' }, mac: false });
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.focus_input).not.toHaveBeenCalled();
    handleShortcutKeydown(keyEvent({ key: 'u', ctrlKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledOnce();
  });

  it('mac platform: mod resolves to metaKey', () => {
    register('focus_input');
    configureShortcutDispatcher({ mac: true });
    handleShortcutKeydown(keyEvent({ key: 'i', metaKey: true }));
    expect(HANDLERS.focus_input).toHaveBeenCalledOnce();
  });
});

describe('sequence prefixes (mod+k …; §I.2 dispatcher)', () => {
  it('arms on the first chord, dispatches the exact second, clears after', () => {
    register('rename_current_session');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    expect(armedShortcutActionId()).toBe('rename_current_session');
    expect(HANDLERS.rename_current_session).not.toHaveBeenCalled();
    handleShortcutKeydown(keyEvent({ key: 'r' })); // second chord is BARE r (mod+k r)
    expect(HANDLERS.rename_current_session).toHaveBeenCalledOnce();
    expect(armedShortcutActionId()).toBeNull();
  });

  it('the 3000 ms window expires without dispatch', () => {
    register('open_help');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    vi.advanceTimersByTime(3000);
    handleShortcutKeydown(keyEvent({ key: 'h' })); // boundary: exactly 3000 still in window
    expect(HANDLERS.open_help).toHaveBeenCalledOnce();
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    vi.advanceTimersByTime(3001); // expiry is LAZY: swept by the next keydown only
    handleShortcutKeydown(keyEvent({ key: 'h' }));
    expect(HANDLERS.open_help).toHaveBeenCalledTimes(1);
  });

  it('Window blur clears the armed prefix', () => {
    installShortcutRouter();
    register('toggle_services_menu');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    window.dispatchEvent(new Event('blur'));
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true }));
    expect(HANDLERS.toggle_services_menu).not.toHaveBeenCalled();
  });

  it('Escape cancels an armed prefix (and only then is consumed)', () => {
    register('abort_run');
    register('rename_current_session'); // arms need the mod+k family resident
    handleShortcutKeydown(keyEvent({ key: 'Escape' })); // no prefix: abort dispatches
    expect(HANDLERS.abort_run).toHaveBeenCalledTimes(1);
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    handleShortcutKeydown(keyEvent({ key: 'Escape' })); // prefix armed: cancel only
    expect(armedShortcutActionId()).toBeNull();
    expect(HANDLERS.abort_run).toHaveBeenCalledTimes(1);
  });

  it('a mismatch second key clears the prefix without dispatching anything', () => {
    register('rename_current_session');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    handleShortcutKeydown(keyEvent({ key: 'z' }));
    expect(HANDLERS.rename_current_session).not.toHaveBeenCalled();
    expect(armedShortcutActionId()).toBeNull();
    handleShortcutKeydown(keyEvent({ key: 'r' }));
    expect(HANDLERS.rename_current_session).not.toHaveBeenCalled(); // prefix cleared already
  });

  it('sibling sequences share the armed first chord (dispatch their own)', () => {
    register('open_timeline_dialog'); // mod+k t
    register('rename_current_session'); // mod+k r
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    handleShortcutKeydown(keyEvent({ key: 't' }));
    expect(HANDLERS.open_timeline_dialog).toHaveBeenCalledOnce();
    expect(HANDLERS.rename_current_session).not.toHaveBeenCalled();
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    handleShortcutKeydown(keyEvent({ key: 'r' }));
    expect(HANDLERS.rename_current_session).toHaveBeenCalledOnce();
  });
});

describe('digit prefixes + editables + IME (§I.2)', () => {
  it('digit prefix dispatches the digit as detail before normal chords', () => {
    register('switch_session_tab');
    handleDigitPrefixKeydown(keyEvent({ key: '4', ctrlKey: true }));
    expect(HANDLERS.switch_session_tab).toHaveBeenCalledWith(4);
    handleDigitPrefixKeydown(keyEvent({ key: '0', ctrlKey: true }));
    expect(HANDLERS.switch_session_tab).toHaveBeenCalledTimes(1); // 0 not a prefix digit
  });

  it('plain chords yield in editables, but Cmd/Ctrl chords do not', () => {
    register('focus_input'); // mod+i
    register('cycle_agent'); // plain tab
    const input = document.createElement('input');
    document.body.appendChild(input);
    handleShortcutKeydown(keyEvent({ key: 'Tab', target: input }));
    expect(HANDLERS.cycle_agent).not.toHaveBeenCalled(); // editable yield
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true, target: input }));
    expect(HANDLERS.focus_input).toHaveBeenCalledOnce(); // Cmd/Ctrl works from editables
    handleShortcutKeydown(keyEvent({ key: 'Tab', target: document.body }));
    expect(HANDLERS.cycle_agent).toHaveBeenCalledTimes(1); // outside editables it fires
    input.remove();
  });

  it('IME composition blocks arm+dispatch except the armed second key', () => {
    register('focus_input');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true })); // armable
    handleShortcutKeydown(keyEvent({ key: 'i', ctrlKey: true, isComposing: true }));
    expect(HANDLERS.focus_input).not.toHaveBeenCalled(); // normal chords yield during IME
    handleShortcutKeydown(keyEvent({ key: 'r', ctrlKey: true })); // not a mod+k second
  });

  it('armed second keys stay eligible DURING IME composition (doc 14 §I.2)', () => {
    register('rename_current_session');
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true })); // arms
    handleShortcutKeydown(keyEvent({ key: 'r', isComposing: true })); // composing second
    expect(HANDLERS.rename_current_session).toHaveBeenCalledOnce(); // dispatched
    expect(armedShortcutActionId()).toBeNull();
    handleShortcutKeydown(keyEvent({ key: 'k', ctrlKey: true }));
    handleShortcutKeydown(keyEvent({ key: 'x', isComposing: true })); // mismatch clears + restores
    expect(armedShortcutActionId()).toBeNull();
    expect(HANDLERS.rename_current_session).toHaveBeenCalledTimes(1);
  });

  it('mac: literal ctrl chords match ctrlKey (⌃]) without mod immunity', () => {
    register('cycle_favorite_model_forward'); // ctrl+]
    configureShortcutDispatcher({ mac: true });
    handleShortcutKeydown(keyEvent({ key: ']', metaKey: true }));
    expect(HANDLERS.cycle_favorite_model_forward).not.toHaveBeenCalled(); // ⌘] ≠ ctrl+]
    handleShortcutKeydown(keyEvent({ key: ']', ctrlKey: true }));
    expect(HANDLERS.cycle_favorite_model_forward).toHaveBeenCalledOnce(); // ⌃] ✓
  });

  it('AltGraph combos (ctrl+alt on Windows) yield to text entry', () => {
    register('new_mini_chat'); // mod+alt+n — would hijack AltGr+N on Windows
    const input = document.createElement('input');
    document.body.appendChild(input);
    const altGr = keyEvent({ key: 'n', ctrlKey: true, altKey: true, target: input });
    (altGr as unknown as { getModifierState: (key: string) => boolean }).getModifierState = (key: string): boolean => key === 'AltGraph';
    handleShortcutKeydown(altGr);
    expect(HANDLERS.new_mini_chat).not.toHaveBeenCalled(); // text entry keeps AltGr+N
    const plain = keyEvent({ key: 'n', ctrlKey: true, altKey: true });
    (plain as unknown as { getModifierState: (key: string) => boolean }).getModifierState = (key: string): boolean => key === 'AltGraph';
    handleShortcutKeydown(plain);
    expect(HANDLERS.new_mini_chat).toHaveBeenCalledOnce(); // outside editables it owns the combo
    input.remove();
  });

  it('install/uninstall round-trips leave exactly one (or zero) live router', () => {
    installShortcutRouter();
    installShortcutRouter(); // idempotent
    uninstallShortcutRouterForTests();
    uninstallShortcutRouterForTests(); // symmetric teardown
    installShortcutRouter();
    register('focus_input');
    const intercept = new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(intercept);
    expect(HANDLERS.focus_input).toHaveBeenCalledTimes(1); // exactly ONE listener live
    uninstallShortcutRouterForTests();
  });
});
