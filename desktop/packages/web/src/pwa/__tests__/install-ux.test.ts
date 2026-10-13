import { describe, expect, it, vi } from 'vitest';
import { showPwaInstallPrompt } from '../install-ux.ts';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

function installEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }> } {
  return Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome, platform: 'web' }),
  });
}

describe('PWA install UX', () => {
  it('defers the native prompt until an explicit toast action and only shows once per session', async () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const notify = vi.fn((_message: string, options: { action: { onClick: () => void }; duration: number }) => options);
    const dismiss = vi.fn();
    showPwaInstallPrompt(target, storage, notify, false, dismiss);
    const event = installEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(event.prompt).not.toHaveBeenCalled();
    const options = notify.mock.results[0]!.value as { action: { onClick: () => void }; duration: number };
    expect(options.duration).toBe(Infinity);
    options.action.onClick();
    options.action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(storage.getItem('pwa-install-toast-dismissed')).toBe('true');

    target.dispatchEvent(installEvent());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('retires the consumed prompt after the user declines the native dialog', async () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const notify = vi.fn((_message: string, options: { action: { onClick: () => void } }) => options);
    const dismiss = vi.fn();
    showPwaInstallPrompt(target, storage, notify, false, dismiss);
    const event = installEvent('dismissed');
    target.dispatchEvent(event);
    (notify.mock.results[0]!.value as { action: { onClick: () => void } }).action.onClick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(storage.getItem('pwa-install-toast-dismissed')).toBe('true');
    target.dispatchEvent(installEvent());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('persists a dismissal and suppresses prompts for standalone installs', () => {
    const target = new EventTarget();
    const storage = memoryStorage();
    const notify = vi.fn((_message: string, options: { cancel: { onClick: () => void } }) => options);
    showPwaInstallPrompt(target, storage, notify);
    target.dispatchEvent(installEvent());
    (notify.mock.results[0]!.value as { cancel: { onClick: () => void } }).cancel.onClick();
    showPwaInstallPrompt(target, storage, notify);
    target.dispatchEvent(installEvent());
    expect(notify).toHaveBeenCalledOnce();

    const standaloneTarget = new EventTarget();
    showPwaInstallPrompt(standaloneTarget, memoryStorage(), notify, true);
    standaloneTarget.dispatchEvent(installEvent());
    expect(notify).toHaveBeenCalledOnce();
  });

  it('keeps the optional prompt working when session storage throws', () => {
    const target = new EventTarget();
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const notify = vi.fn();
    showPwaInstallPrompt(target, storage, notify);
    target.dispatchEvent(installEvent());
    expect(notify).toHaveBeenCalledOnce();
  });
});
