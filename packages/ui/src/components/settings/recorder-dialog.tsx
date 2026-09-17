// SPDX-License-Identifier: Apache-2.0
/**
 * ShortcutRecordingDialog (doc 14 §I.3): records up to two chords with the
 * 3000 ms window; Enter/Escape are recordable; feedback (conflict / too
 * many keys) appears after the second chord, the timeout, or Confirm;
 * recording stays LOCAL until Confirm — the dialog's own Confirm/Cancel are
 * the only ways to apply or discard.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShortcutDecl } from '../../lib/shortcuts/config.ts';
import { displayCombo } from '../../lib/shortcuts/bindings.ts';
import { cancelArmedShortcut } from '../../lib/shortcuts/dispatcher.ts';
import { isMac } from '../../lib/platform.ts';
import {
  recorderInitialState,
  recorderOnStroke,
  recorderOnTimeout,
  recorderExpiredWindow,
  recorderConfirm,
  recorderReset,
  type RecorderState,
} from '../../lib/shortcuts/recorder.ts';
import { useI18n } from '../I18nProvider.tsx';

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

function strokeOf(event: KeyboardEvent): { key: string; mods: Set<'mod' | 'ctrl' | 'alt' | 'shift'> } | null {
  // §I.2 platform split: mod = Cmd on macOS else Ctrl (matches the engine).
  if (MODIFIER_KEYS.has(event.key) || event.isComposing) return null;
  const key = event.key === ' ' ? 'space' : event.key === ',' ? 'comma' : event.key.toLowerCase();
  if (key.length === 0 || /undefined/iu.test(key)) return null;
  const mods = new Set<'mod' | 'ctrl' | 'alt' | 'shift'>();
  const mac = isMac();
  if (mac ? event.metaKey : event.ctrlKey) mods.add('mod');
  if (mac && event.ctrlKey) mods.add('ctrl');
  if (event.altKey) mods.add('alt');
  if (event.shiftKey) mods.add('shift');
  return { key, mods };
}

export function ShortcutRecordingDialog({
  decl, overrides, onConfirm, onCancel,
}: {
  decl: ShortcutDecl;
  overrides: Record<string, string>;
  onConfirm: (overrides: Record<string, string>) => void;
  onCancel: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [state, setState] = useState<RecorderState>(() => recorderInitialState());
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    cancelArmedShortcut(); // §I.4: ownership change invalidates pending prefixes
  }, []);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      event.preventDefault();
      if (event.stopPropagation) event.stopPropagation();
      if (MODIFIER_KEYS.has(event.key) || (event.isComposing)) return;
      const stroke = strokeOf(event);
      if (stroke === null) return;
      setState((current) => recorderOnStroke(current, stroke, decl.id, overrides));
    };
    window.addEventListener('keydown', onKeydown, true); // capture owns the dialog
    return () => window.removeEventListener('keydown', onKeydown, true);
  }, [decl.id, overrides]);

  useEffect(() => {
    const tick = window.setInterval(() => {
      setState((current) => (recorderExpiredWindow(current, Date.now()) ? recorderOnTimeout(current) : current));
    }, 100);
    return () => window.clearInterval(tick);
  }, []);

  const conflict =
    state.validation.kind === 'exact'
      ? state.validation.replaceable
        ? t('settings.shortcuts.replaceable', { otherActionId: state.validation.otherActionId ?? '' })
        : t('settings.shortcuts.conflictInternal')
      : state.validation.kind === 'prefix'
        ? t('settings.shortcuts.conflictPrefix')
        : null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40" data-nnd-recording-overlay="">
      <div
        className="w-[420px] rounded-lg border border-border/60 bg-card p-4 shadow-2xl brightness-fix"
        data-nnd-settings-dim-target=""
      >
        <div className="mb-2 text-xs font-medium text-foreground">
          {t('settings.window.title')} — {t(decl.settingsLabelKey ?? 'shortcuts.label.focus_input')}
        </div>
        <div className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          {state.phase === 'await-second' ? t('settings.shortcuts.sequenceHint') : t('settings.shortcuts.recording')}
        </div>
        <div className="mb-3 flex min-h-12 items-center gap-2 rounded border border-border/40 bg-background/40 p-2">
          {state.chords.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">{t('settings.shortcuts.unassigned')}</span>
          ) : (
            <kbd className="rounded border border-border/50 bg-interactive-hover/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {displayCombo({ chords: state.chords }, false)}
            </kbd>
          )}
          {state.exceeded ? <span className="text-[11px] text-status-error">{t('settings.shortcuts.maxKeys')}</span> : null}
          {conflict !== null && state.phase === 'ready' ? <span className="text-[11px] text-status-warning">{conflict}</span> : null}
          {state.risk === 'browser-reserved' ? <span className="text-[11px] text-status-warning">{t('settings.shortcuts.risky')}</span> : null}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            className="rounded border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => setState((current) => recorderReset(current))}
          >
            Clear
          </button>
          <button type="button" className="rounded px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-primary/20 px-3 py-1 text-[11px] text-primary disabled:opacity-40"
            disabled={state.phase !== 'ready'}
            onClick={() => {
              const result = recorderConfirm(stateRef.current, decl.id, overrides);
              if (!result.blocked) onConfirm(result.overrides);
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

