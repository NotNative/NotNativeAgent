import { createContext, useContext, type ReactNode } from 'react';

// P0 English-only stub; the i18n catalog format + 12 locales are doc 14 (P5).
const en: Record<string, string> = {
  'app.title': 'NotNativeDesktop',
  'shell.sessions': 'Sessions',
  'shell.newSession': 'New session',
  'shell.chatPlaceholder': 'Send a message to the harnessâ€¦',
  'shell.send': 'Send',
  'shell.noSession': 'No session selected',
  'shell.connecting': 'Connecting to harnessâ€¦',
  'shell.connected': 'Harness connected',
  'shell.offline': 'Harness offline',
  'shell.mockBanner': 'Mock harness â€” NotNativeAgent integration pending',
  'shell.recovery.title': 'Startup did not finish',
  'shell.recovery.retry': 'Retry',
};

interface I18nApi {
  t: (key: string) => string;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children?: ReactNode }) {
  const api: I18nApi = { t: (key) => en[key] ?? key };
  return <I18nContext value={api}>{children}</I18nContext>;
}

export function useI18n(): I18nApi {
  const api = useContext(I18nContext);
  if (!api) throw new Error('useI18n outside I18nProvider');
  return api;
}

