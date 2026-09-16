import { useConfigStore } from '../stores/useConfigStore.ts';
import { useTheme } from './ThemeProvider.tsx';
import { useI18n } from './I18nProvider.tsx';

export function HeaderBar() {
  const { t } = useI18n();
  const { mode, setMode } = useTheme();
  const connected = useConfigStore((s) => s.isConnected);
  const phase = useConfigStore((s) => s.connectionPhase);

  const pill = !connected
    ? { label: t('shell.offline'), cls: 'bg-red-500/15 text-red-400' }
    : phase === 'connected'
      ? { label: t('shell.connected'), cls: 'bg-emerald-500/15 text-emerald-400' }
      : { label: t('shell.connecting'), cls: 'bg-amber-500/15 text-amber-400' };

  return (
    <header className="flex h-12 items-center gap-3 border-b border-white/10 px-4">
      <span className="text-sm font-medium text-neutral-200">{t('app.title')}</span>
      <span className={`rounded-full px-2 py-0.5 text-[11px] ${pill.cls}`}>{pill.label}</span>
      <span className="ml-auto flex gap-2">
        <button
          onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
          className="text-neutral-500 hover:text-neutral-200"
          type="button"
        >
          {mode === 'dark' ? 'light' : 'dark'}
        </button>
      </span>
    </header>
  );
}


const RAIL_SURFACES: Array<{ id: string; label: string; glyph: string }> = [
  { id: 'context', label: 'Context', glyph: 'â—Ž' },
  { id: 'git', label: 'Git', glyph: 'â‘‚' },
  { id: 'pr', label: 'Pull requests', glyph: 'â‡„' },
  { id: 'diff', label: 'Diff', glyph: 'â‡†' },
  { id: 'editor', label: 'Files', glyph: 'â–¤' },
  { id: 'terminal', label: 'Terminal', glyph: 'â¯' },
  { id: 'notes', label: 'Notes', glyph: 'âœŽ' },
  { id: 'browser', label: 'Browser', glyph: 'â—' },
];

export function ContextRail() {
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-white/10 bg-neutral-950 py-2">
      {RAIL_SURFACES.map((surface) => (
        <button
          key={surface.id}
          title={`${surface.label} — lands with its phase`}
          className="h-8 w-8 rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          type="button"
        >
          {surface.glyph}
        </button>
      ))}
    </nav>
  );
}

