// SPDX-License-Identifier: Apache-2.0
/**
 * DirectoryRequests (doc 06 §2.1 step 2): ONE in-flight read per directory
 * path; repeated callers await the same promise; `force=true` REPLACES the
 * slot; scope/dir change or unmount calls clear() so stale completions
 * cannot publish. Callers additionally check the runtime identity at
 * completion time (their scope ref).
 */
export class DirectoryRequests {
  private inflight = new Map<string, Promise<unknown>>();

  run<T>(key: string, loader: () => Promise<T>, force = false): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing !== undefined && !force) return existing as Promise<T>;
    const promise = loader().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise); // force replaces the slot; joiners stay on their own promise
    return promise as Promise<T>;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  clear(): void {
    this.inflight.clear();
  }
}
