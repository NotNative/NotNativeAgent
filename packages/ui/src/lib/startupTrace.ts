/**
 * Startup trace (doc 01 §4.7): ?startupTrace=1 or
 * localStorage.NOTNATIVE_STARTUP_TRACE=1. Ring buffer of ≤500 entries,
 * `t` = ms since first mark; console.table-ready summary helper.
 */
type TraceEntry = { t: number; name: string; data?: Record<string, unknown> };

const entries: TraceEntry[] = [];
const MAX_ENTRIES = 500;

const enabled = (() => {
  if (typeof window === 'undefined') return false;
  try {
    const query = new URLSearchParams(window.location.search).get('startupTrace');
    const stored = window.localStorage?.getItem?.('NOTNATIVE_STARTUP_TRACE');
    return query === '1' || stored === '1';
  } catch {
    return false;
  }
})();

let firstMarkAt = 0;

export function isStartupTraceEnabled(): boolean {
  return enabled;
}

export function markStartupTrace(name: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const now = Date.now();
  if (!firstMarkAt) {
    firstMarkAt = now;
    if (typeof window !== 'undefined') console.debug('[startupTrace] enabled — marks:');
  }
  entries.push({ t: now - firstMarkAt, name, data });
  if (entries.length > MAX_ENTRIES) entries.shift();
  console.debug(`[startupTrace] +${now - firstMarkAt}ms ${name}`);
}

export async function measureStartupTrace<T>(
  name: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled) return await fn();
  markStartupTrace(`${name}:start`);
  try {
    const result = await fn();
    markStartupTrace(`${name}:end`);
    return result;
  } catch (error) {
    markStartupTrace(`${name}:error`, { message: String(error) });
    throw error;
  }
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__NOTNATIVE_STARTUP_TRACE__ = entries;
  (window as unknown as Record<string, unknown>).__NOTNATIVE_STARTUP_TRACE_SUMMARY__ = () =>
    entries.filter((e) => e.name.includes(':'));
}
