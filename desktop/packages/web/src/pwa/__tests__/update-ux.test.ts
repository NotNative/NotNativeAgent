import { describe, expect, it, vi } from 'vitest';
import { showPwaUpdateWhenReady } from '../update-ux.ts';

describe('PWA update UX', () => {
  it('asks before activating an update, then reloads once control changes', () => {
    const container = Object.assign(new EventTarget(), { controller: null as ServiceWorker | null });
    const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const registration = Object.assign(new EventTarget(), {
      active: {} as ServiceWorker,
      waiting: worker,
      installing: null,
    }) as unknown as ServiceWorkerRegistration;
    const notify = vi.fn((_message: string, options: { action: { onClick: () => void } }) => options);
    const reload = vi.fn();

    showPwaUpdateWhenReady(registration, container, notify, reload);

    expect(notify).toHaveBeenCalledOnce();
    expect(worker.postMessage).not.toHaveBeenCalled();
    const options = notify.mock.results[0]?.value as { action: { onClick: () => void } };
    options.action.onClick();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'NOTNATIVE_ACTIVATE_UPDATE' });
    expect(reload).not.toHaveBeenCalled();

    container.dispatchEvent(new Event('controllerchange'));
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('does not announce a first install with no active worker', () => {
    const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const registration = Object.assign(new EventTarget(), { active: null, waiting: worker, installing: null }) as unknown as ServiceWorkerRegistration;
    const notify = vi.fn();
    showPwaUpdateWhenReady(registration, Object.assign(new EventTarget(), { controller: null }), notify as never, vi.fn());
    expect(notify).not.toHaveBeenCalled();
  });

  it('reloads immediately when another tab already activated and controls this page', () => {
    const worker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const container = Object.assign(new EventTarget(), { controller: null as ServiceWorker | null });
    const registration = Object.assign(new EventTarget(), {
      active: {} as ServiceWorker,
      waiting: worker,
      installing: null,
    }) as unknown as ServiceWorkerRegistration;
    const notify = vi.fn((_message: string, options: { action: { onClick: () => void } }) => options);
    const reload = vi.fn();

    showPwaUpdateWhenReady(registration, container, notify, reload);
    worker.state = 'activated';
    container.controller = worker as unknown as ServiceWorker;
    const options = notify.mock.results[0]?.value as { action: { onClick: () => void } };
    options.action.onClick();

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('sends the action to the latest waiting worker if the toast worker was superseded', () => {
    const oldWorker = Object.assign(new EventTarget(), { state: 'redundant', postMessage: vi.fn() });
    const latestWorker = Object.assign(new EventTarget(), { state: 'installed', postMessage: vi.fn() });
    const container = Object.assign(new EventTarget(), { controller: null as ServiceWorker | null });
    const registration = Object.assign(new EventTarget(), {
      active: {} as ServiceWorker,
      waiting: oldWorker,
      installing: null,
    }) as unknown as ServiceWorkerRegistration;
    const notify = vi.fn((_message: string, options: { action: { onClick: () => void } }) => options);

    showPwaUpdateWhenReady(registration, container, notify, vi.fn());
    Object.defineProperty(registration, 'waiting', { configurable: true, value: latestWorker });
    const options = notify.mock.results[0]?.value as { action: { onClick: () => void } };
    options.action.onClick();

    expect(oldWorker.postMessage).not.toHaveBeenCalled();
    expect(latestWorker.postMessage).toHaveBeenCalledWith({ type: 'NOTNATIVE_ACTIVATE_UPDATE' });
  });
});
