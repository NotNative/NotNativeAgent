// SPDX-License-Identifier: Apache-2.0
/**
 * Plan save queue (doc 06 §8.2/§8.3): per-key serialized write chains,
 * dedup by revision watermark (revision <= last returns the CURRENT chain;
 * a failed write clears the watermark only when still latest), pendingFor
 * awaits all settled writes (reset is the only watermark forgetter — fresh
 * load, §8.1), a queued write that finds the runtime switched DROPS itself
 * (live runtime source beats the stale per-key binding, §8.2).
 */
class PlanSaveQueue {
  private chains = new Map<string, Promise<void>>();
  private watermarks = new Map<string, number>();
  private runtimeKeys = new Map<string, string>();
  private runtimeSource: ((key: string) => string | undefined) | null = null;
  private onWriteError: ((key: string, error: unknown) => void) | null = null;

  bindRuntime(key: string, runtimeKey: string): void {
    this.runtimeKeys.set(key, runtimeKey);
  }

  /** Live runtime read (wins over the per-key binding — §8.2 drop check). */
  bindRuntimeSource(source: (key: string) => string | undefined): void {
    this.runtimeSource = source;
  }

  bindErrorHandler(fn: (key: string, error: unknown) => void): void {
    this.onWriteError = fn;
  }

  /** §8.2 schedule: revision-dedup + serialized chain per key. */
  schedule(key: string, revision: number, write: () => Promise<void>): Promise<void> {
    const last = this.watermarks.get(key);
    if (last !== undefined && revision <= last) return this.currentChain(key);
    this.watermarks.set(key, revision);
    const runtimeKey = this.resolveRuntime(key);
    const previous = this.currentChain(key);
    const chain = previous.then(() => {
      if (runtimeKey !== undefined && runtimeKey !== this.resolveRuntime(key)) {
        return; // runtime switched while queued: drop the write (§8.2)
      }
      return write().catch((error: unknown) => {
        if (this.watermarks.get(key) === revision) this.watermarks.delete(key);
        this.onWriteError?.(key, error);
        throw error;
      });
    });
    this.chains.set(key, chain.catch(() => undefined));
    return chain;
  }

  private currentChain(key: string): Promise<void> {
    return this.chains.get(key) ?? Promise.resolve();
  }

  private resolveRuntime(key: string): string | undefined {
    return this.runtimeSource?.(key) ?? this.runtimeKeys.get(key);
  }

  /** §8.2 pendingFor: await ALL settled writes for the key. The watermark is
   * NOT forgotten here — reset() does that after the fresh load (§8.1). */
  async pendingFor(key: string): Promise<void> {
    const captured = this.currentChain(key);
    await captured;
    if (this.chains.get(key) === captured) this.chains.delete(key); // a schedule may have enqueued DURING the await: keep it chained
  }

  reset(key: string): void {
    this.watermarks.delete(key);
  }
}

export function createPlanSaveQueue(): PlanSaveQueue {
  return new PlanSaveQueue();
}

export const PLAN_AUTOSAVE_DEBOUNCE_MS = 350;

/** §8.5 session plan path (Harness-adjacent): <sessionDirectory>/.opencode/
 * plans/<epoch-creation-ms>-<slug>.md — co-opted by this UI, not the harness. */
export function sessionPlanPath(sessionDirectory: string, createdAt: number, slug: string): string {
  const separator = sessionDirectory.includes('\\') || /^[a-zA-Z]:$/u.test(sessionDirectory) ? '\\' : '/';
  const base = sessionDirectory.endsWith('/') || sessionDirectory.endsWith('\\') ? sessionDirectory : `${sessionDirectory}${separator}`;
  return `${base}.opencode${separator}plans${separator}${createdAt}-${slug}.md`;
}

/** Stable v1 stand-in for the session epoch (full session resolution is
 * registered): deterministic per directory — FNV-1a spread over an epoch-ms
 * range — so a plan authored on save is found again on the next open. */
export function planEpochFor(directory: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < directory.length; index += 1) {
    hash ^= directory.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return 1_700_000_000_000 + (hash >>> 0);
}
