/**
 * Chunk load recovery (doc 01 §4.6): dynamic-import failures are detected by
 * message patterns, retried once after 250 ms, then — outside VS Code —
 * exactly one location.reload() per signature per 30 s.
 */
const RELOAD_MARKER_KEY = 'notnative:chunk-import-reload';
const RELOAD_VALIDITY_MS = 30_000;

const FAILURE_PATTERNS: RegExp[] = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Loading chunk \d+ failed/i,
  /ChunkLoadError/i,
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

type ReloadMarker = { signature: string; timestamp: number };

function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  } catch {
    return 'dev';
  }
}

function tryScheduleReload(error: unknown): boolean {
  if (typeof window === 'undefined') return false;
  const first500 = String(error instanceof Error ? error.message : error).slice(0, 500);
  const signature = `${appVersion()}:${first500}`;
  try {
    const raw = window.sessionStorage.getItem(RELOAD_MARKER_KEY);
    if (raw) {
      const marker = JSON.parse(raw);
      if (
        marker.signature === signature &&
        Date.now() - marker.timestamp < RELOAD_VALIDITY_MS
      ) {
        return false; // already recovered once for this signature inside the window
      }
    }
    window.sessionStorage.setItem(
      RELOAD_MARKER_KEY,
      JSON.stringify({ signature, timestamp: Date.now() } satisfies ReloadMarker),
    );
  } catch {
    return false;
  }
  setTimeout(() => window.location.reload(), 0);
  return true;
}

export function lazyWithChunkRecovery<T>(factory: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await factory();
    } catch (firstError) {
      if (!isChunkLoadError(firstError)) throw firstError;
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        return await factory();
      } catch (secondError) {
        if (!isChunkLoadError(secondError)) throw secondError;
        const reloading = tryScheduleReload(secondError);
        if (!reloading) throw secondError; // caller's error boundary handles it
        // never resolve — the page is reloading
        return await new Promise<T>(() => undefined);
      }
    }
  };
}
