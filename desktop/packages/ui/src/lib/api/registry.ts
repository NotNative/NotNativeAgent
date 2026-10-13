// SPDX-License-Identifier: Apache-2.0
import type { RuntimeAPIs } from './types.ts';

/** Global RuntimeAPIs registry (doc 01 §3.3: the UI imports it once at boot). */
let registered: RuntimeAPIs | null = null;

export function registerRuntimeAPIs(apis: RuntimeAPIs): void {
  registered = apis;
  if (typeof window !== 'undefined') window.__NOTNATIVE_RUNTIME_APIS__ = apis;
}

export function getRuntimeAPIs(): RuntimeAPIs {
  if (!registered && typeof window !== 'undefined') registered = window.__NOTNATIVE_RUNTIME_APIS__ ?? null;
  if (!registered) throw new Error('RuntimeAPIs not registered before app render');
  return registered;
}

export function tryGetRuntimeAPIs(): RuntimeAPIs | null {
  if (registered) return registered;
  return typeof window !== 'undefined' ? (window.__NOTNATIVE_RUNTIME_APIS__ ?? null) : null;
}
