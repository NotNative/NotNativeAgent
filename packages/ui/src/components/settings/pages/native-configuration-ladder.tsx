// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeConfigurationView } from '../../../lib/nnd/configuration.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

// Mirrors NNA src/config.js recovery validation: the ladder is an ordered list
// of 'nudge' | 'compact' actions, one to four of them, and its length must
// cover the local retry limit minus one (the engine then slices it to exactly
// that). turn_wall_clock_ms accepts 1000..86400000 with 0 and null meaning
// unset. The engine revalidates every draft on save.
export const LADDER_PATH = 'recovery.ladder';
export const TURN_WALL_CLOCK_PATH = 'recovery.turn_wall_clock_ms';
const LADDER_ACTIONS = ['nudge', 'compact'] as const;

export function ladderDraftValid(draft: string, localLimit: number): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(draft); } catch { return false; }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4) return false;
  if (!parsed.every(item => (LADDER_ACTIONS as readonly unknown[]).includes(item))) return false;
  return parsed.length >= Math.max(1, localLimit - 1);
}

function draftLadder(draft: string): string[] {
  try {
    const parsed = JSON.parse(draft);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch { return []; }
}

export function LadderDraftInput({ model, view }: { model: ControlsModel; view: NativeConfigurationView }): ReactNode {
  const { t } = useI18n();
  const guard = (ladder: string[]): void => { invalidateNativePreview(model); model.setDraft(JSON.stringify(ladder)); };
  const ladder = draftLadder(model.draft);
  const append = (action: string): void => { if (ladder.length < 4) guard([...ladder, action]); };
  const move = (index: number, delta: number): void => {
    const next = [...ladder];
    const item = next.splice(index, 1)[0] ?? '';
    next.splice(index + delta, 0, item);
    guard(next);
  };
  return <>
    <p className="text-muted-foreground">{t('settings.nativeRecovery.ladderHint')}</p>
    <div className="flex flex-wrap items-center gap-1">
      {ladder.map((action, index) => <span key={`${action}:${index}`}
        className="flex items-center gap-1 rounded border border-border px-1 py-0.5">
        {action}
        <button type="button" aria-label={t('settings.nativeRecovery.moveUp')} disabled={index === 0 || model.busy}
          onClick={() => move(index, -1)}>↑</button>
        <button type="button" aria-label={t('settings.nativeRecovery.moveDown')}
          disabled={index === ladder.length - 1 || model.busy} onClick={() => move(index, 1)}>↓</button>
        <button type="button" aria-label={t('settings.nativeRecovery.removeStep')}
          disabled={model.busy} onClick={() => guard(ladder.filter((_, at) => at !== index))}>×</button>
      </span>)}
    </div>
    <div className="flex gap-1">
      {LADDER_ACTIONS.map(action => <button type="button" key={action} disabled={ladder.length >= 4 || model.busy}
        onClick={() => append(action)}>{t('settings.nativeRecovery.addAction')} {action}</button>)}
    </div>
  </>;
}

export function localRetryLimit(view: NativeConfigurationView): number {
  const row = view.fields.find(field => field.path === 'recovery.local_retry_limit')?.effective;
  return row?.present && 'value' in row && typeof row.value === 'number' ? row.value : 3;
}

export function ladderLength(view: NativeConfigurationView): number {
  const row = view.fields.find(field => field.path === LADDER_PATH)?.effective;
  return row?.present && 'value' in row && Array.isArray(row.value) ? row.value.length : 0;
}
