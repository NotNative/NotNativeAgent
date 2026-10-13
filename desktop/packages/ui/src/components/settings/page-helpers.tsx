// SPDX-License-Identifier: Apache-2.0
/**
 * Page helpers: the useSettingsField binding every settings page reads and
 * writes the registry-backed field with (the engine filters non-writables
 * and invalid values, so pages can bind raw controls).
 */
import { useSettingsStore, setSettingsField } from '../../lib/settings/store.ts';

export function useSettingsField<T>(key: string): { value: T | undefined; set: (next: T) => void } {
  const value = useSettingsStore((state) => state.doc[key] as T | undefined);
  return { value, set: (next: T) => setSettingsField(key, next) };
}
