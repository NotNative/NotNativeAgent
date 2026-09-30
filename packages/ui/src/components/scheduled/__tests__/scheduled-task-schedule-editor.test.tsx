// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Schedule-form + schedule-editor pins (doc 12 §H editor): pill labels
 * render the preference (12h/24h), weekday chips walk the locale's first
 * day, membership toggles keep the last required entry, the kind tabs
 * reseed drafts in the same zone, and the debounced preview paints only
 * the LATEST generation (E-09-26 previewed = armed).
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScheduledScheduleEditor, type ScheduledScheduleEditorProps } from '../scheduled-task-schedule-editor.tsx';
import {
  emptyDraft, localeFirstDay, timePillLabel, toggleMember, weekdayOrder,
  weekdayLabels, cronShapeOk, zoneChoices,
} from '../schedule-form.ts';
import type { TaskSchedule } from '../../../lib/scheduled-tasks-api.ts';
import { useI18nStore } from '../../../lib/i18n/store.ts';
import { BCP47ByLocale } from '../../../lib/i18n/runtime.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Preview = ScheduledScheduleEditorProps['preview'];
const okSlot = Date.UTC(2026, 0, 26, 9, 0);

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

let container: HTMLElement | null = null;
let root: Root | null = null;
const changes: TaskSchedule[] = [];

function EditorHarness({ initial, preview, preference }: {
  initial: TaskSchedule;
  preview: Preview;
  preference: 'auto' | '12h' | '24h';
}): ReactNode {
  const [value, setValue] = useState(initial);
  return (
    <ScheduledScheduleEditor value={value} preview={preview} timePreference={preference} delayMs={0}
      onChange={(next) => { changes.push(next); setValue(next); }} />
  );
}

function renderEditor(value: TaskSchedule, preview: Preview, preference: 'auto' | '12h' | '24h' = '24h'): void {
  if (root !== null) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<EditorHarness initial={value} preview={preview} preference={preference} />);
  });
}

const daily: TaskSchedule = { kind: 'daily', times: ['09:00'], timezone: 'UTC' };

beforeEach(() => {
  changes.length = 0;
  useI18nStore.setState({ locale: 'en' });
});

afterEach(() => {
  if (root !== null) { const closing = root; act(() => { closing.unmount(); }); root = null; }
  if (container !== null) { container.remove(); container = null; }
});

describe('schedule-form helpers', () => {
  it('time pill labels follow the preference, invalid input returns verbatim', () => {
    expect(timePillLabel('09:00', '24h')).toBe('09:00');
    expect(timePillLabel('9:00', '12h')).toMatch(/AM|PM/u);
    expect(timePillLabel('9:00', '12h')).toContain('9:00');
    expect(timePillLabel('wat', '12h')).toBe('wat');
    expect(timePillLabel('99:99', '24h')).toBe('99:99');
    expect(timePillLabel('24:00', '24h')).toBe('24:00');
    expect(timePillLabel('09:60', '12h')).toBe('09:60');
    // en boundaries (auto follows the locale's default = 12h).
    expect(timePillLabel('00:00', 'auto')).toBe('12:00 AM');
    expect(timePillLabel('12:00', 'auto')).toBe('12:00 PM');
    expect(timePillLabel('23:30', 'auto')).toBe('11:30 PM');
    // de-DE auto follows the locale's default = 24h; the numeric hour is the
    // §J.1 convention (time.ts formatTimeForPreference), so '00:30' -> '0:30'.
    useI18nStore.setState({ locale: 'de' });
    expect(timePillLabel('12:00', 'auto')).toBe('12:00');
    expect(timePillLabel('00:30', 'auto')).toBe('0:30');
    useI18nStore.setState({ locale: 'en' });
  });

  it('weekday walk order starts on the locale first day and rotates 7', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(weekdayOrder(0)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(weekdayOrder(6)).toEqual([6, 0, 1, 2, 3, 4, 5]);
    expect(localeFirstDay('en-US')).toBe(0);
    expect(localeFirstDay('de-DE')).toBe(1);
  });

  it('membership toggles never empty the list and keep sorted order', () => {
    expect(toggleMember(['09:00'], '09:30')).toEqual(['09:00', '09:30']);
    expect(toggleMember(['09:00', '09:30'], '09:00')).toEqual(['09:30']);
    expect(toggleMember(['09:00'], '09:00')).toEqual(['09:00']);
    expect(toggleMember([3, 1], 2)).toEqual([1, 2, 3]);
    expect(toggleMember([1], 1)).toEqual([1]);
    // a stored task may carry unsorted times; adding sorts the result copy.
    expect(toggleMember(['21:00', '07:00'], '09:00')).toEqual(['07:00', '09:00', '21:00']);
  });

  it('cron shape accepts 5-6 fields and enforces the 200-char cap', () => {
    expect(cronShapeOk('0 9 * * 1-5')).toBe(true);
    expect(cronShapeOk('0 9 * * 1-5 1970-2100')).toBe(true);
    expect(cronShapeOk('*')).toBe(false);
    expect(cronShapeOk('')).toBe(false);
    expect(cronShapeOk(`${'9 '.repeat(201)}*`)).toBe(false);
  });

  it('zone choices open with the local zone and UTC, unique', () => {
    const zones = zoneChoices();
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(zones[0] === resolved || zones[1] === 'UTC' || zones.includes('UTC')).toBe(true);
    expect(zones.slice(0, 2)).toContain('UTC');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('empty drafts seed the schedule kinds in the given zone', () => {
    expect(emptyDraft('daily', 'Asia/Tokyo')).toEqual({ kind: 'daily', times: ['09:00'], timezone: 'Asia/Tokyo' });
    const weekly = emptyDraft('weekly', 'UTC');
    expect(weekly).toMatchObject({ kind: 'weekly', times: ['09:00'], weekdays: [1], timezone: 'UTC' });
    const once = emptyDraft('once', 'UTC');
    expect(once).toMatchObject({ kind: 'once', time: '09:00', timezone: 'UTC' });
    expect((once as { date: string }).date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(emptyDraft('cron', 'UTC')).toEqual({ kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' });
  });

  it('once-date seeds the ZONE-LOCAL tomorrow, not the UTC tomorrow', () => {
    // First-principles zone wall date (en-GB parts, a different formatter
    // path than the implementation's en-CA), over now + 24 h.
    const zoneWallDate = (epoch: number, zone: string): string => {
      const table = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date(epoch));
      const pick = (type: string): string => table.find((part) => part.type === type)?.value ?? '';
      return `${pick('year')}-${pick('month')}-${pick('day')}`;
    };
    const withNow = (fixed: number, zone: string): string => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(fixed);
      try { return (emptyDraft('once', zone) as unknown as { date: string }).date; }
      finally { spy.mockRestore(); }
    };
    // UTC+14: zone wall of now+24 h is 2026-01-28 (01-27 04:00), while the
    // UTC-based seed would say 2026-01-27 (= zone today) - one day off.
    const plus14 = Date.UTC(2026, 0, 26, 14, 0);
    expect(withNow(plus14, 'Pacific/Kiritimati')).toBe(zoneWallDate(plus14 + 86_400_000, 'Pacific/Kiritimati'));
    expect(withNow(plus14, 'Pacific/Kiritimati')).toBe('2026-01-28');
    // UTC-10 mirror: zone tomorrow 2026-01-27 while the UTC seed says 01-28.
    const minus10 = Date.UTC(2026, 0, 27, 9, 0);
    expect(withNow(minus10, 'Pacific/Honolulu')).toBe(zoneWallDate(minus10 + 86_400_000, 'Pacific/Honolulu'));
    expect(withNow(minus10, 'Pacific/Honolulu')).toBe('2026-01-27');
  });

  it('unusable schedule zones seed the UTC-based once-date (registered fold)', () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 26, 14, 0));
    try {
      const draft = (emptyDraft('once', 'Mars/Olympus') as unknown as { date: string; timezone: string });
      expect(draft.date).toBe(new Date(Date.UTC(2026, 0, 26, 14, 0) + 86_400_000).toISOString().slice(0, 10));
      expect(draft.timezone).toBe('Mars/Olympus'); // the preview folds an invalid zone to empty (E-09-26)
    } finally { spy.mockRestore(); }
  });

  it('every shipped locale carries weekInfo, so the Monday fallback is unreachable', () => {
    for (const [id, tag] of Object.entries(BCP47ByLocale)) {
      const info = (new Intl.Locale(tag) as unknown as { weekInfo?: { firstDay: number } }).weekInfo;
      expect(info?.firstDay, `weekInfo for ${id} (${tag})`).toBeDefined();
      expect(localeFirstDay(tag), `firstDay for ${id}`).toBe((info!.firstDay ?? 1) % 7);
    }
  });
});

describe('ScheduledScheduleEditor (doc 12 §H)', () => {
  it('kind tabs reseed the draft of the new kind in the SAME zone', () => {
    renderEditor(daily, async () => ({ ok: true, slots: [] }));
    act(() => {
      document.querySelector('[data-testid="schedule-kind-weekly"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes[0]).toEqual({ kind: 'weekly', times: ['09:00'], weekdays: [1], timezone: 'UTC' });
  });

  it('daily pills toggle on, off, and refuse to empty the selection', () => {
    renderEditor(daily, async () => ({ ok: true, slots: [] }));
    act(() => {
      document.querySelector('[data-testid="pill-09:30"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes[0]?.kind === 'daily' && (changes[0] as { times: string[] }).times).toEqual(['09:00', '09:30']);
    const withTwo = changes[0]!;
    renderEditor(withTwo, async () => ({ ok: true, slots: [] }));
    act(() => {
      document.querySelector('[data-testid="pill-09:00"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes[1]?.kind === 'daily' && (changes[1] as { times: string[] }).times).toEqual(['09:30']);
    const single = { kind: 'daily', times: ['09:30'], timezone: 'UTC' } as TaskSchedule;
    renderEditor(single, async () => ({ ok: true, slots: [] }));
    act(() => {
      document.querySelector('[data-testid="pill-09:30"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes.length).toBe(3);
    expect(changes[2]!.kind === 'daily' && (changes[2] as { times: string[] }).times).toEqual(['09:30']);
  });

  it('weekly chips render the locale order exactly once each', () => {
    renderEditor(emptyDraft('weekly', 'UTC'), async () => ({ ok: true, slots: [] }));
    const chips = [...document.querySelectorAll('[data-testid^="weekday-"]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id !== 'weekday-chips');
    expect(chips.length).toBe(7);
    const days = chips.map((id) => Number((id ?? '').replace('weekday-', '')));
    expect(new Set(days).size).toBe(7);
    expect(days[0]).toBe(localeFirstDay(BCP47ByLocale.en));
  });

  it('renders non-ASCII weekday chips in the locale walk order', () => {
    useI18nStore.setState({ locale: 'de' });
    renderEditor(emptyDraft('weekly', 'UTC'), async () => ({ ok: true, slots: [] }));
    const chips = [...document.querySelectorAll('[data-testid^="weekday-"]')]
      .filter((node) => node.getAttribute('data-testid') !== 'weekday-chips');
    const order = weekdayOrder(localeFirstDay(BCP47ByLocale.de));
    expect(chips.map((node) => node.textContent)).toEqual(order.map((day) => weekdayLabels(BCP47ByLocale.de)[day]));
    expect(chips[0]?.textContent).toMatch(/\p{Script=Latin}/u);
    expect(chips.map((node) => node.textContent)).not.toContain('Sun');
  });

  it('once fields round-trip date and time through onChange', () => {
    renderEditor(emptyDraft('once', 'UTC'), async () => ({ ok: true, slots: [] }));
    act(() => {
      const date = document.querySelector('[data-testid="once-date"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(date, '2026-10-01');
      date.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(changes[0]).toMatchObject({ kind: 'once', date: '2026-10-01' });
    act(() => {
      const time = document.querySelector('[data-testid="once-time"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(time, '14:45');
      time.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(changes[1]).toMatchObject({ kind: 'once', time: '14:45' });
  });

  it('cron input flags a short shape and example chips reseed the expression', () => {
    renderEditor(emptyDraft('cron', 'UTC'), async () => ({ ok: true, slots: [] }));
    expect(document.querySelector('[data-testid="cron-invalid"]')).toBeNull();
    act(() => {
      const input = document.querySelector('[data-testid="cron-input"]') as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '*');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    expect(changes[0]).toMatchObject({ kind: 'cron', cron: '*' });
    renderEditor({ kind: 'cron', cron: '*', timezone: 'UTC' }, async () => ({ ok: true, slots: [] }));
    expect(document.querySelector('[data-testid="cron-invalid"]')?.textContent).toContain('cron fields');
    act(() => {
      document.querySelector('[data-testid="cron-example"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes[1]).toMatchObject({ kind: 'cron', cron: '0 * * * *' });
  });

  it('zone select changes carry the draft through', async () => {
    renderEditor(daily, async () => ({ ok: true, slots: [] }));
    const choices = zoneChoices().length;
    const options = (): number => document.querySelectorAll('option').length;
    expect(options()).toBe(choices); // UTC is a supported choice - no extra option
    act(() => {
      const select = document.querySelector('[data-testid="schedule-zone-select"]') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'Asia/Tokyo');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(changes[0]).toMatchObject({ kind: 'daily', timezone: 'Asia/Tokyo' });
    expect(options()).toBe(choices);
    // An unlisted VALUE (a stored draft's zone) renders EXTRA on top of the
    // catalogue - exactly once, never duplicating a listed entry - and the
    // extra option reappears whenever the value is unlisted again (props
    // drive the DOM; the select state itself is not the source of truth).
    const unlisted: TaskSchedule = { kind: 'daily', times: ['09:00'], timezone: 'Mars/Olympus' };
    renderEditor(unlisted, async () => ({ ok: true, slots: [] }));
    expect(options()).toBe(choices + 1);
    expect(document.querySelector('option')?.textContent).toBe('Mars/Olympus');
    act(() => {
      const select = document.querySelector('[data-testid="schedule-zone-select"]') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'Asia/Tokyo');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(changes[1]).toMatchObject({ kind: 'daily', timezone: 'Asia/Tokyo' });
    expect(options()).toBe(choices); // the extra option collapses with the listing
  });

  it('preview paints the latest generation only (stale resolve drops)', async () => {
    const deferred: Array<(slots: number[]) => void> = [];
    const preview = vi.fn((schedule: TaskSchedule): Promise<{ ok: true; slots: number[] }> =>
      new Promise((resolve) => { deferred.push((slots) => resolve({ ok: true, slots })); }));
    renderEditor(daily, preview as unknown as Preview);
    await act(async () => { await settle(); });
    expect(preview).toHaveBeenCalledTimes(1);
    act(() => {
      const select = document.querySelector('[data-testid="schedule-zone-select"]') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'Asia/Tokyo');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => { await settle(); });
    expect(preview).toHaveBeenCalledTimes(2);
    await act(async () => {
      deferred[1]!([okSlot + 1000]);
    });
    expect(document.querySelectorAll('[data-testid="schedule-preview-slot"]').length).toBe(1);
    await act(async () => {
      deferred[0]!([okSlot]);
    });
    expect(document.querySelectorAll('[data-testid="schedule-preview-slot"]').length).toBe(1);
    expect(document.querySelector('[data-testid="schedule-preview"]')?.textContent).toContain('Asia/Tokyo');
  });

  it('a failed preview answers the unavailable note, not an error', async () => {
    let rejecter: ((value: { ok: false; error: string; status: number }) => void) | null = null;
    const preview: Preview = () => new Promise((resolve) => { rejecter = resolve as typeof rejecter; });
    renderEditor(daily, preview, '24h');
    await act(async () => { await settle(); });
    await act(async () => {
      rejecter!({ ok: false, error: 'bad', status: 400 });
    });
    expect(document.querySelector('[data-testid="schedule-preview"]')?.textContent).toContain('preview unavailable');
    expect(document.querySelectorAll('[data-testid="schedule-preview-slot"]').length).toBe(0);
  });

  it('the preview rides the draft even when the client shape heuristic fails', async () => {
    // The cron hint is client-side only: live validation stays with the
    // server round-trip (E-09-26), so '*' is still dispatched for preview.
    const spy = vi.fn(async (): Promise<{ ok: true; slots: number[] }> => ({ ok: true, slots: [] }));
    renderEditor({ kind: 'cron', cron: '*', timezone: 'UTC' }, spy as unknown as Preview);
    await act(async () => { await settle(); });
    expect(spy).toHaveBeenCalledWith({ kind: 'cron', cron: '*', timezone: 'UTC' });
  });

  it('a later generation restores slots after an unavailable earlier one', async () => {
    const preview = vi.fn((): Promise<{ ok: true; slots: number[] } | { ok: false; error: string; status: number }> =>
      Promise.reject(new Error('unused')));
    preview.mockResolvedValueOnce({ ok: false, error: 'bad', status: 400 });
    preview.mockResolvedValueOnce({ ok: true, slots: [okSlot] });
    renderEditor(daily, preview as unknown as Preview);
    await act(async () => { await settle(); }); // first generation: unavailable
    expect(document.querySelector('[data-testid="schedule-preview"]')?.textContent).toContain('preview unavailable');
    act(() => {
      const select = document.querySelector('[data-testid="schedule-zone-select"]') as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, 'Asia/Tokyo');
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(async () => { await settle(); }); // second generation resolves ok
    expect(document.querySelectorAll('[data-testid="schedule-preview-slot"]').length).toBe(1);
    expect(document.querySelector('[data-testid="schedule-preview"]')?.textContent).not.toContain('preview unavailable');
  });

  it('a pending preview resolving after unmount paints nothing and stays silent', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    let resolveIt: (slots: number[]) => void = () => undefined;
    const preview: Preview = () => new Promise((resolve) => {
      resolveIt = resolve as unknown as typeof resolveIt;
    });
    renderEditor(daily, preview, '24h');
    await act(async () => { await settle(); });
    act(() => { root!.unmount(); });
    root = null;
    await act(async () => { resolveIt([okSlot]); await Promise.resolve(); });
    spy.mockRestore();
    // React 19 no-ops unmounted set-state silently; the pin guards that this
    // stays a no-op rather than re-arming the dev error.
    expect(errors).toEqual([]);
  });

  it('a successful slot renders both the viewer stamp and the schedule-zone wall time', async () => {
    renderEditor(daily, async () => ({ ok: true, slots: [okSlot] }), '24h');
    await act(async () => { await settle(); });
    const line = document.querySelector('[data-testid="schedule-preview-slot"]')?.textContent ?? '';
    expect(line).toContain('in UTC');
    expect(line.length).toBeGreaterThan(10);
  });
});
