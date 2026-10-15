// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

/** Browser presentation choices do not change native workspace authority. */
export function useSidebarPreference<T>(name: string, initial: T, valid: (value: unknown) => value is T): [T, Dispatch<SetStateAction<T>>] {
  const key = `nnd.sidebar.v1:${getRuntimeKey()}:${name}`;
  const read = (): T => {
    try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null'); return valid(value) ? value : initial; }
    catch { return initial; }
  };
  const [value, setValue] = useState<T>(read);
  useEffect(() => { setValue(read()); }, [key]);
  const save: Dispatch<SetStateAction<T>> = update => setValue(current => {
    const next = typeof update === 'function' ? (update as (current: T) => T)(current) : update;
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Compatibility: unavailable storage preserves the current window's choice. */ }
    return next;
  });
  return [value, save];
}

export const oneOf = <T extends string>(...choices: T[]) => (value: unknown): value is T => choices.includes(value as T);
export const collapsedMap = (value: unknown): value is Record<string, true> => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length <= 256 && Object.values(value).every(item => item === true));
