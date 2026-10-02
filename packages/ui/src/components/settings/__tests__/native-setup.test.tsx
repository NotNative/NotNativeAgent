// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { NativeSetupPanel } from '../pages/native-setup.tsx';
import { requestNativeSetup, type NativeSetupStatus } from '../../../lib/nnd/setup.ts';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
const change = vi.hoisted(() => ({ callback: () => {}, runtime: 'a' }));
vi.mock('../../../lib/nnd/setup.ts', () => ({ requestNativeSetup: vi.fn() }));
vi.mock('../../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => change.runtime,
  onRuntimeEndpointChanged: (callback: () => void) => { change.callback = callback; return () => {}; } }));
const required: NativeSetupStatus = { service_state:'setup_required',configuration_state:'invalid',
  execution_state:'unavailable',provider_state:'unknown',failure_code:'nnd_setup_configuration_invalid' };
let root: Root; let container: HTMLDivElement;
function mount(onOpenConfiguration?: () => void) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');document.body.append(container);root=createRoot(container);
  act(() => root.render(<I18nProvider><NativeSetupPanel onOpenConfiguration={onOpenConfiguration} /></I18nProvider>));
}
function button(text: string) { return [...container.querySelectorAll('button')].find(item=>item.textContent===text)!; }
afterEach(()=>{act(()=>root?.unmount());container?.remove();vi.resetAllMocks();change.runtime='a';useAuthSessionStore.getState().markOk();});
it('reads only on mount and requires explicit single activation; 503 status remains visible',async()=>{
  vi.mocked(requestNativeSetup).mockResolvedValue({status:required,error:false});mount();await act(async()=>{});
  expect(requestNativeSetup).toHaveBeenCalledTimes(1);expect(vi.mocked(requestNativeSetup).mock.calls[0]![0]).toBe(false);
  expect(container.textContent).toContain('Provider connectivity: not checked');
  let finish!: (value: {status:NativeSetupStatus;error:boolean})=>void;
  vi.mocked(requestNativeSetup).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  act(()=>{button('Activate NNA execution').click();button('Activate NNA execution').click();});
  expect(requestNativeSetup).toHaveBeenCalledTimes(2);
  await act(async()=>finish({status:required,error:true}));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain('Invalid or missing');
});
it('aborts previous host request and ignores its late completion',async()=>{
  let finish!: (value: {status:NativeSetupStatus;error:boolean})=>void;
  vi.mocked(requestNativeSetup).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))
    .mockResolvedValue({status:required,error:false});mount();
  const signal=vi.mocked(requestNativeSetup).mock.calls[0]![1];
  await act(async()=>{change.runtime='b';change.callback();});expect(signal.aborted).toBe(true);
  await act(async()=>finish({status:{...required,service_state:'ready',configuration_state:'ready',execution_state:'ready'},error:false}));
  expect(container.textContent).toContain('Invalid or missing');expect(container.textContent).not.toContain('Ready');
});
it('cancels on unmount and keeps unavailable activation disabled',async()=>{
  vi.mocked(requestNativeSetup).mockResolvedValue({status:null,error:true});mount();await act(async()=>{});
  expect(button('Activate NNA execution').disabled).toBe(true);
  const signal=vi.mocked(requestNativeSetup).mock.calls[0]![1];
  // A completed request need not abort; the next pending request must.
  vi.mocked(requestNativeSetup).mockImplementation(()=>new Promise(()=>{}));
  act(()=>button('Refresh setup status').click());const pending=vi.mocked(requestNativeSetup).mock.calls[1]![1];
  act(()=>root.unmount());expect(pending.aborted).toBe(true);expect(signal.aborted).toBe(false);
});
it('auth expiry cancels activation and reauthentication only reads fresh status',async()=>{
  vi.mocked(requestNativeSetup).mockResolvedValue({status:required,error:false});mount();await act(async()=>{});
  let finish!: (value: {status:NativeSetupStatus;error:boolean})=>void;
  vi.mocked(requestNativeSetup).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  act(()=>button('Activate NNA execution').click());
  const signal=vi.mocked(requestNativeSetup).mock.calls.at(-1)![1];
  await act(async()=>useAuthSessionStore.getState().markExpired());
  expect(signal.aborted).toBe(true);
  expect(button('Refresh setup status').disabled).toBe(true);
  expect(button('Activate NNA execution').disabled).toBe(true);
  await act(async()=>finish({status:{...required,service_state:'ready',configuration_state:'ready',execution_state:'ready'},error:false}));
  expect(container.textContent).not.toContain('Ready');
  await act(async()=>useAuthSessionStore.getState().beginReauthentication());
  expect(requestNativeSetup).toHaveBeenCalledTimes(2);
  await act(async()=>useAuthSessionStore.getState().markOk());
  expect(requestNativeSetup).toHaveBeenCalledTimes(3);
  expect(vi.mocked(requestNativeSetup).mock.calls.at(-1)![0]).toBe(false);
  expect(container.textContent).toContain('Invalid or missing');
});
it.each(['nnd_setup_activation_timeout','nnd_setup_cleanup_failed'])('requires native restart after %s',async(failure_code)=>{
  vi.mocked(requestNativeSetup).mockResolvedValue({status:{...required,service_state:'failed',failure_code},error:false});
  mount();await act(async()=>{});
  expect(button('Activate NNA execution').disabled).toBe(true);
  expect(button('Refresh setup status').disabled).toBe(false);
  expect(container.textContent).toContain('Restart the selected native service');
});
it('offers a settings-window navigation action without changing native configuration',async()=>{
  const navigate=vi.fn();vi.mocked(requestNativeSetup).mockResolvedValue({status:required,error:false});
  mount(navigate);await act(async()=>{});
  act(()=>button('View native configuration').click());
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(requestNativeSetup).toHaveBeenCalledTimes(1);
});
