// SPDX-License-Identifier: Apache-2.0
/** DirectoryRequests gates (doc 06 §2.1): one in-flight read per key,
 * joiners await the same promise, force replaces the slot, clear() drops
 * everything so scope changes cannot publish stale completions. */
import { describe, expect, it, vi } from 'vitest';
import { DirectoryRequests } from '../directory-requests.ts';

function deferred(): { promise: Promise<number>; resolve: (v: number) => void } {
  let resolve!: (v: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('DirectoryRequests (§2.1 step 2)', () => {
  it('coalesces concurrent callers into one in-flight read', async () => {
    const requests = new DirectoryRequests();
    const loader = vi.fn(async () => {
      const gate = deferred();
      gate.resolve(1);
      return 1;
    });
    const [a, b] = await Promise.all([requests.run('dir', loader), requests.run('dir', loader)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('force replaces the slot without coalescing into the old flight', async () => {
    const requests = new DirectoryRequests();
    const loader = vi.fn(async () => 1);
    const first = requests.run('dir', loader);
    const second = requests.run('dir', loader, true);
    expect(second).not.toBe(first);
    await Promise.all([first, second]);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(requests.has('dir')).toBe(false); // last completion cleans its own slot
  });

  it('clear() drops all slots (scope change / unmount)', async () => {
    const requests = new DirectoryRequests();
    await requests.run('dir', vi.fn(async () => 1));
    requests.clear();
    expect(requests.has('dir')).toBe(false);
    await requests.run('dir', vi.fn(async () => 2));
    void 0;
  });
});
