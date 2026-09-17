// SPDX-License-Identifier: Apache-2.0
/**
 * Appearance appliers (doc 14 §B.3/§B.4 + §G.4): the settings store's
 * typography/chrome fields drive document-level effects. `applyFontSize`
 * scales the rem root (all --text-* are rem-authored, so the whole rem UI
 * scales — §B.3 applyTypography); padding multiplies --padding-scale;
 * cornerRadius maps onto the B.2 ratio scale (delta E11).
 */
import { useSettingsStore } from './store.ts';
import { UI_FONT_OPTIONS, MONO_FONT_OPTIONS } from './font-options.ts';

export const DEFAULTS = { fontSize: 100, padding: 100, terminalFontSize: 14, editorFontSize: 13, cornerRadius: 18 };

export function applyFontChoice(uiFont: string | undefined, monoFont: string | undefined): void {
  const ui = UI_FONT_OPTIONS.find((option) => option.id === (uiFont ?? 'system')) ?? UI_FONT_OPTIONS[0]!;
  const mono = MONO_FONT_OPTIONS.find((option) => option.id === (monoFont ?? 'system-mono')) ?? MONO_FONT_OPTIONS[0]!;
  document.documentElement.style.setProperty('--font-sans', ui.stack);
  document.documentElement.style.setProperty('--font-mono', mono.stack);
  document.documentElement.style.setProperty('--font-heading', ui.stack);
}

function rem(px: number): string {
  return `${px / 16}rem`;
}

export function applyFontSize(percent: number | undefined): void {
  const scale = (percent ?? DEFAULTS.fontSize) / 100;
  document.documentElement.style.fontSize = `${(scale * 100).toFixed(2)}%`;
}

export function applyPaddingScale(percent: number | undefined): void {
  const scale = (percent ?? DEFAULTS.padding) / 100;
  document.documentElement.style.setProperty('--padding-scale', String(scale));
}

/** Radius remap onto the @theme scale points (B.2). */
export function applyCornerRadius(px: number | undefined): void {
  const value = px ?? DEFAULTS.cornerRadius;
  document.documentElement.style.setProperty('--radius-lg', rem(value));
  document.documentElement.style.setProperty('--radius-xl', rem((value * 12) / 9));
}

/** Apply every appearance field present in the current settings document. */
export function applyAppearanceFields(doc: Record<string, unknown> = {}): void {
  applyFontSize(doc['fontSize'] as number | undefined);
  applyPaddingScale(doc['padding'] as number | undefined);
  applyCornerRadius(doc['cornerRadius'] as number | undefined);
  applyFontChoice(doc['uiFont'] as string | undefined, doc['monoFont'] as string | undefined);
}

/** Live-drives the appliers from the settings store (bind once). */
export function bindAppearanceAppliers(): () => void {
  applyAppearanceFields(useSettingsStore.getState().doc);
  return useSettingsStore.subscribe(() => {
    applyAppearanceFields(useSettingsStore.getState().doc);
  });
}
