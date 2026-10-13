// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { waitForNativeModelReady } from '../setup-readiness.ts';

const ready = { data: { nnd: { engine: 'nna', primaryModel: { providerID: 'local', modelID: 'test' } } } };

it('waits for the activated NNA model before allowing a browser refresh', async () => {
  const read = vi.fn().mockResolvedValueOnce({ error: 'setup required' })
    .mockResolvedValueOnce({ data: { nnd: { engine: 'nna' } } }).mockResolvedValue(ready);
  const wait = vi.fn().mockResolvedValue(undefined);
  await waitForNativeModelReady(new AbortController().signal, read, wait);
  expect(read).toHaveBeenCalledTimes(3);
  expect(wait).toHaveBeenCalledTimes(2);
});

it('stops before another read when the runtime changes', async () => {
  const controller = new AbortController();
  const read = vi.fn().mockResolvedValue({ error: 'setup required' });
  const wait = vi.fn().mockImplementation(async () => { controller.abort(); });
  await expect(waitForNativeModelReady(controller.signal, read, wait)).rejects.toThrow('native-setup-cancelled');
  expect(read).toHaveBeenCalledTimes(1);
});

it('does not accept a non-native or model-less configuration', async () => {
  const read = vi.fn().mockResolvedValue({ data: { nnd: { engine: 'nna' } } });
  await expect(waitForNativeModelReady(new AbortController().signal, read, async () => {}))
    .rejects.toThrow('native-model-not-ready');
  expect(read).toHaveBeenCalledTimes(20);
});
