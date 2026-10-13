// SPDX-License-Identifier: Apache-2.0
import { toast } from 'sonner';
import { translate } from '@notnative/ui/lib/i18n/store.ts';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type InstallNotice = (message: string, options: {
  duration: number;
  action: { label: string; onClick: () => void };
  cancel: { label: string; onClick: () => void };
}) => unknown;
type DismissNotice = (id: unknown) => void;

const SHOWN_KEY = 'pwa-install-toast-shown';
const DISMISSED_KEY = 'pwa-install-toast-dismissed';

export function showPwaInstallPrompt(
  target: Pick<EventTarget, 'addEventListener'>,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  notify: InstallNotice = toast,
  standalone = false,
  dismiss: DismissNotice = (id) => toast.dismiss(id as string | number),
): void {
  if (standalone || safeGet(storage, SHOWN_KEY) || safeGet(storage, DISMISSED_KEY)) return;
  let shownInMemory = false;
  target.addEventListener('beforeinstallprompt', (rawEvent) => {
    const event = rawEvent as InstallPromptEvent;
    event.preventDefault();
    if (shownInMemory || safeGet(storage, SHOWN_KEY) || safeGet(storage, DISMISSED_KEY)) return;
    shownInMemory = true;
    safeSet(storage, SHOWN_KEY);
    let toastId: unknown;
    let promptStarted = false;
    const finishPrompt = (): void => {
      safeSet(storage, DISMISSED_KEY);
      if (toastId !== undefined) dismiss(toastId);
    };
    toastId = notify(translate('pwa.install.message'), {
      duration: Infinity,
      action: {
        label: translate('pwa.install.action'),
        onClick: () => {
          if (promptStarted) return;
          promptStarted = true;
          try {
            void event.prompt().then(() => event.userChoice).then(finishPrompt, finishPrompt);
          } catch {
            // The browser can invalidate a deferred install event before the
            // user acts; keep the page usable if prompt() throws synchronously.
            finishPrompt();
          }
        },
      },
      cancel: {
        label: translate('pwa.install.dismiss'),
        onClick: () => safeSet(storage, DISMISSED_KEY),
      },
    });
  });
}

function safeGet(storage: Pick<Storage, 'getItem'>, key: string): boolean {
  try { return storage.getItem(key) === 'true'; } catch { return false; }
}

function safeSet(storage: Pick<Storage, 'setItem'>, key: string): void {
  try { storage.setItem(key, 'true'); } catch { /* installation remains optional */ }
}

export function registerPwaInstallUX(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  if (!['http:', 'https:'].includes(window.location.protocol)) return;
  if (window.__NOTNATIVE_ELECTRON__?.runtime === 'electron') return;
  try {
    showPwaInstallPrompt(window, window.sessionStorage, toast, window.matchMedia('(display-mode: standalone)').matches);
  } catch {
    // Storage may be disabled; the PWA install prompt remains optional.
  }
}
