// SPDX-License-Identifier: Apache-2.0
import { toast } from 'sonner';

type Notify = (message: string, options: { duration: number; action: { label: string; onClick: () => void } }) => unknown;

export function showPwaUpdateWhenReady(
  registration: ServiceWorkerRegistration,
  container: Pick<ServiceWorkerContainer, 'addEventListener' | 'controller'>,
  notify: Notify = toast,
  reload: () => void = () => window.location.reload(),
): void {
  let announced: ServiceWorker | null = null;
  let reloadWhenControlled = false;
  const announce = (worker: ServiceWorker | null): void => {
    if (!worker || !registration.active || worker === announced) return;
    announced = worker;
    notify('A NotNativeDesktop update is ready', {
      duration: Infinity,
      action: {
        label: 'Reload',
        onClick: () => {
          reloadWhenControlled = true;
          // Another tab may have accepted this update while this toast was
          // still visible. In that case the selected worker is already active
          // and this page may already be controlled by it; skipWaiting would
          // be too late to produce another controllerchange event.
          if (worker.state === 'activated') {
            if (container.controller === worker) {
              reloadWhenControlled = false;
              reload();
            }
            return;
          }

          // A newer install can replace the worker captured by this toast.
          // Ask the current waiting worker to activate when one is available.
          const currentWaiting = registration.waiting;
          (currentWaiting?.state === 'installed' ? currentWaiting : worker)
            .postMessage({ type: 'NOTNATIVE_ACTIVATE_UPDATE' });
        },
      },
    });
  };
  const watchInstalling = (): void => {
    const worker = registration.installing;
    if (!worker) return;
    const inspect = (): void => {
      if (worker.state === 'installed') announce(registration.waiting ?? worker);
    };
    worker.addEventListener('statechange', inspect);
    inspect();
  };

  container.addEventListener('controllerchange', () => {
    if (!reloadWhenControlled) return;
    reloadWhenControlled = false;
    reload();
  });
  registration.addEventListener('updatefound', watchInstalling);
  announce(registration.waiting);
}

export function registerPwaUpdateUX(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (typeof window === 'undefined' || !['http:', 'https:'].includes(window.location.protocol)) return;
  void navigator.serviceWorker.register('/service-worker.js').then((registration) => {
    showPwaUpdateWhenReady(registration, navigator.serviceWorker);
  }).catch(() => {
    // PWA update UX is optional; the application still works without it.
  });
}
