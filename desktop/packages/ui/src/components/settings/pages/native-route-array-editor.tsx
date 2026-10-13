// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import type { NativeEditableField } from '../../../lib/nnd/configuration-mutation.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { invalidateNativePreview, type ControlsModel } from './native-configuration-controls-model.ts';

// Mirrors NNA src/configuration-catalog-metadata.js route family arrays:
// required_capabilities takes up to six unique capability names, fallbacks up
// to four unique role names tried in order (cycle checks stay engine-side).
// Empty lists are legal for both. The engine revalidates every draft on save.
const CAPABILITIES = ['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation'];
const ROLES = ['primary', 'reviewer', 'subagent', 'vision'];

export function routeArrayConfig(path: string): { allowed: string[]; max: number } | null {
  if (path.endsWith('.required_capabilities')) return { allowed: CAPABILITIES, max: 6 };
  if (path.endsWith('.fallbacks')) return { allowed: ROLES, max: 4 };
  return null;
}

export function routeArrayValid(field: NativeEditableField, draft: string): boolean {
  const config = routeArrayConfig(field.path);
  if (!config) return true;
  // A blank seed (absent row) means the empty list, which is legal.
  if (draft.trim() === '') return true;
  let parsed: unknown;
  try { parsed = JSON.parse(draft); } catch { return false; }
  if (!Array.isArray(parsed)) return false;
  const items = parsed.map(item => typeof item === 'string' ? item : '');
  return items.length <= config.max && items.every(item => config.allowed.includes(item))
    && new Set(items).size === items.length;
}

function draftList(draft: string): string[] {
  if (draft.trim() === '') return [];
  try {
    const parsed = JSON.parse(draft);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch { return []; }
}

export function RouteArrayInput({ field, model }: { field: NativeEditableField; model: ControlsModel }): ReactNode {
  const { t } = useI18n();
  const config = routeArrayConfig(field.path);
  if (!config) return null;
  const guard = (list: string[]): void => { invalidateNativePreview(model); model.setDraft(JSON.stringify(list)); };
  const list = draftList(model.draft);
  const move = (index: number, delta: number): void => {
    const next = [...list];
    const item = next.splice(index, 1)[0] ?? '';
    next.splice(index + delta, 0, item);
    guard(next);
  };
  return <>
    <p className="text-muted-foreground">{t('settings.nativeRoutes.arrayHint')}</p>
    <div className="flex flex-wrap items-center gap-1">
      {list.map((item, index) => <span key={`${item}:${index}`}
        className="flex items-center gap-1 rounded border border-border px-1 py-0.5">
        {item}
        <button type="button" aria-label={t('settings.nativeRecovery.moveUp')} disabled={index === 0 || model.busy}
          onClick={() => move(index, -1)}>↑</button>
        <button type="button" aria-label={t('settings.nativeRecovery.moveDown')}
          disabled={index === list.length - 1 || model.busy} onClick={() => move(index, 1)}>↓</button>
        <button type="button" aria-label={t('settings.nativeRoutes.removeEntry')}
          disabled={model.busy} onClick={() => guard(list.filter((_, at) => at !== index))}>×</button>
      </span>)}
    </div>
    <div className="flex flex-wrap gap-1">{config.allowed.map(item => (
      <button type="button" key={item} disabled={list.length >= config.max || list.includes(item) || model.busy}
        onClick={() => guard([...list, item])}>{t('settings.nativeRecovery.addAction')} {item}</button>))}
    </div>
  </>;
}
