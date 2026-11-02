// SPDX-License-Identifier: Apache-2.0
/**
 * The schedule half of the task editor (doc 12 §H "Editor dialog"): kind
 * tabs (daily/weekly/once/cron), time pills rendered per the viewer's
 * 12h/24h preference, weekday chips ordered by the locale's first day,
 * once date/time inputs, a cron input with example chips + live shape
 * check, an IANA zone select, and the debounced next-4-runs preview that
 * asks the SERVER's preview route (previewed = armed, E-09-26). The
 * execution half (name/model/agent/prompt/goal) lands with the editor
 * dialog that hosts this component.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { TaskSchedule } from '../../lib/scheduled-tasks-api.ts';
import {
  CRON_EXAMPLES, PILL_CATALOG, cronShapeOk, emptyDraft, localeFirstDay,
  timePillLabel, toggleMember, weekdayLabels, weekdayOrder, zoneChoices,
} from './schedule-form.ts';
import { previewLine, useScheduledText, type ScheduledText } from './scheduledText.ts';
import { useI18nStore } from '../../lib/i18n/store.ts';
import { BCP47ByLocale } from '../../lib/i18n/runtime.ts';
import { useCurrentIntlLocale } from '../../lib/i18n/intl.ts';

const KINDS: Array<{ kind: TaskSchedule['kind']; labelKey: keyof ScheduledText }> = [
  { kind: 'daily', labelKey: 'kindDaily' }, { kind: 'weekly', labelKey: 'kindWeekly' },
  { kind: 'once', labelKey: 'kindOnce' }, { kind: 'cron', labelKey: 'kindCron' },
];
const EXAMPLE_LABEL_KEYS: Array<keyof ScheduledText> = [
  'exampleHourly', 'exampleEvery15', 'exampleWeekdays9',
  'exampleMondays', 'exampleMonthlyFirst',
];

export interface ScheduledScheduleEditorProps {
  value: TaskSchedule;
  onChange: (next: TaskSchedule) => void;
  /** The server preview (previewNextRuns); injected so tests stay hermetic. */
  preview: (schedule: TaskSchedule) => Promise<{ ok: true; slots: number[] } | { ok: false; error: string; status: number }>;
  timePreference: 'auto' | '12h' | '24h';
  delayMs?: number;
}

export function ScheduledScheduleEditor({
  value, onChange, preview, timePreference, delayMs = 250,
}: ScheduledScheduleEditorProps): ReactNode {
  const intlLocale = useCurrentIntlLocale();
  return (
    <div lang={intlLocale} data-testid="schedule-editor" className="flex flex-col gap-2 text-[length:var(--type-meta)] text-foreground">
      <KindTabs value={value} onChange={onChange} />
      <ZoneSelect value={value} onChange={onChange} />
      {value.kind === 'daily' ? <TimePillGrid selection={value.times} timePreference={timePreference}
        onToggle={(time) => onChange({ ...value, times: toggleMember(value.times, time) })} /> : null}
      {value.kind === 'weekly' ? <WeeklyFields value={value} onChange={onChange} timePreference={timePreference} /> : null}
      {value.kind === 'once' ? <OnceFields value={value} onChange={onChange} /> : null}
      {value.kind === 'cron' ? (
        <CronFields value={value} onChange={onChange} />
      ) : null}
      <PreviewBlock value={value} preview={preview} timePreference={timePreference} delayMs={delayMs} />
    </div>
  );
}

function KindTabs({ value, onChange }: { value: TaskSchedule; onChange: (next: TaskSchedule) => void }): ReactNode {
  const text = useScheduledText();
  return (
    <div className="flex gap-1" role="tablist" aria-label={text.scheduleKind}>
      {KINDS.map(({ kind, labelKey }) => (
        <button key={kind} type="button" role="tab" aria-selected={value.kind === kind}
          data-testid={`schedule-kind-${kind}`}
          className={`rounded px-2 py-1 text-[length:var(--type-meta)] ${value.kind === kind ? 'bg-card text-foreground' : 'bg-background text-muted-foreground hover:text-foreground'}`}
          onClick={() => onChange(emptyDraft(kind, value.timezone))}>
          {text[labelKey]}
        </button>
      ))}
    </div>
  );
}

function ZoneSelect({ value, onChange }: { value: TaskSchedule; onChange: (next: TaskSchedule) => void }): ReactNode {
  const choices = zoneChoices();
  const listed = choices.includes(value.timezone);
  const text = useScheduledText();
  return (
    <label className="flex items-center gap-2 text-[length:var(--type-meta)] text-muted-foreground">
      <span>{text.timezone}</span>
      <select value={value.timezone} data-testid="schedule-zone-select"
        onChange={(event) => onChange({ ...value, timezone: event.target.value })}
        className="max-w-full rounded-lg border border-border/10 bg-background px-2 py-1 text-[length:var(--type-meta)] text-foreground">
        {!listed && value.timezone.length > 0 ? <option value={value.timezone}>{value.timezone}</option> : null}
        {choices.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
      </select>
    </label>
  );
}

function TimePillGrid({ selection, onToggle, timePreference }: {
  selection: string[];
  onToggle: (time: string) => void;
  timePreference: 'auto' | '12h' | '24h';
}): ReactNode {
  return (
    <div className="max-h-40 overflow-y-auto rounded-lg border border-border/10 bg-background/60 p-2" data-testid="time-pill-grid">
      <div className="flex flex-wrap gap-1">
        {PILL_CATALOG.map((pill) => (
          <button key={pill} type="button" data-testid={`pill-${pill}`}
            className={`rounded px-1.5 py-0.5 text-[length:var(--type-micro)] ${selection.includes(pill) ? 'bg-primary/60 text-primary' : 'bg-card text-muted-foreground hover:text-foreground'}`}
            onClick={() => onToggle(pill)}>
            {timePillLabel(pill, timePreference)}
          </button>
        ))}
      </div>
    </div>
  );
}

function WeeklyFields({ value, onChange, timePreference }: {
  value: TaskSchedule & { kind: 'weekly' };
  onChange: (next: TaskSchedule) => void;
  timePreference: 'auto' | '12h' | '24h';
}): ReactNode {
  const text = useScheduledText();
  const storeLocale = BCP47ByLocale[useI18nStore.getState().locale] ?? BCP47ByLocale.en;
  const labels = weekdayLabels(storeLocale);
  const order = weekdayOrder(localeFirstDay(storeLocale));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1" data-testid="weekday-chips" aria-label={text.weekdays}>
        {order.map((day) => (
          <button key={day} type="button" data-testid={`weekday-${day}`}
            className={`rounded px-2 py-0.5 text-[length:var(--type-micro)] ${value.weekdays.includes(day) ? 'bg-primary/60 text-primary' : 'bg-card text-muted-foreground hover:text-foreground'}`}
            onClick={() => onChange({ ...value, weekdays: toggleMember(value.weekdays, day) })}>
            {labels[day]}
          </button>
        ))}
      </div>
      <TimePillGrid selection={value.times} timePreference={timePreference}
        onToggle={(time) => onChange({ ...value, times: toggleMember(value.times, time) })} />
    </div>
  );
}

function OnceFields({ value, onChange }: { value: TaskSchedule & { kind: 'once' }; onChange: (next: TaskSchedule) => void }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input type="date" value={value.date} data-testid="once-date"
        onInput={(event: FormEvent<HTMLInputElement>) => {
          if (event.currentTarget.value.length > 0) onChange({ ...value, date: event.currentTarget.value });
        }}
        className="rounded-lg border border-border/10 bg-background px-2 py-1 text-[length:var(--type-meta)] text-foreground" />
      <input type="time" value={value.time} data-testid="once-time"
        onInput={(event: FormEvent<HTMLInputElement>) => {
          if (event.currentTarget.value.length > 0) onChange({ ...value, time: event.currentTarget.value.slice(0, 5) });
        }}
        className="rounded-lg border border-border/10 bg-background px-2 py-1 text-[length:var(--type-meta)] text-foreground" />
    </div>
  );
}

function CronFields({ value, onChange }: { value: TaskSchedule & { kind: 'cron' }; onChange: (next: TaskSchedule) => void }): ReactNode {
  const text = useScheduledText();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input value={value.cron} data-testid="cron-input" aria-label={text.cronAria} spellCheck={false}
          onChange={(event) => onChange({ ...value, cron: event.target.value })}
          className="min-w-0 flex-1 rounded-lg border border-border/10 bg-background px-2 py-1 text-[length:var(--type-meta)] text-foreground" />
        {!cronShapeOk(value.cron) ? <span className="text-[length:var(--type-micro)] text-tone-warning" data-testid="cron-invalid">{text.cronInvalid}</span> : null}
      </div>
      <div className="flex flex-wrap gap-1" data-testid="cron-examples">
        {CRON_EXAMPLES.map((example, index) => (
          <button key={example.cron} type="button" data-testid="cron-example"
            className="rounded bg-card px-1.5 py-0.5 text-[length:var(--type-micro)] text-muted-foreground hover:text-foreground"
            onClick={() => onChange({ ...value, cron: example.cron })}>
            {text[EXAMPLE_LABEL_KEYS[index] ?? 'exampleHourly']}
          </button>
        ))}
      </div>
    </div>
  );
}

function PreviewBlock({ value, preview, timePreference, delayMs }: {
  value: TaskSchedule;
  preview: ScheduledScheduleEditorProps['preview'];
  timePreference: 'auto' | '12h' | '24h';
  delayMs: number;
}): ReactNode {
  const text = useScheduledText();
  const [slots, setSlots] = useState<number[]>([]);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const draft = JSON.stringify(value);
  useEffect(() => {
    sequence.current += 1;
    const mine = sequence.current;
    setFailed(false);
    const timer = setTimeout(() => {
      void preview(value).then((outcome) => {
        if (sequence.current !== mine) return;
        if (outcome.ok) {
          setSlots(outcome.slots);
          setFailed(false);
        } else {
          setSlots([]);
          setFailed(true);
        }
      }).catch(() => {
        if (sequence.current !== mine) return;
        setSlots([]);
        setFailed(true);
      });
    }, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, delayMs]);
  return (
    <div className="rounded-lg border border-border/10 bg-background/60 p-2 text-[length:var(--type-micro)]" data-testid="schedule-preview">
      <div className="text-muted-foreground">{text.nextRuns}</div>
      {slots.map((at) => (
        <div key={at} className="text-muted-foreground" data-testid="schedule-preview-slot">{previewLine(at, value.timezone, timePreference, text)}</div>
      ))}
      {slots.length === 0 ? <div className="text-foreground">{failed ? text.previewUnavailable : text.computing}</div> : null}
    </div>
  );
}
