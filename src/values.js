// SPDX-License-Identifier: Apache-2.0

/** A plain record: a non-null object that is not an array. */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Freeze a value graph iteratively. A WeakSet makes shared references and
 *  cycles safe, and the explicit stack keeps depth bounded by memory rather
 *  than the call stack. */
export function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  const seen = new WeakSet();
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    Object.freeze(current);
    for (const child of Object.values(current)) stack.push(child);
  }
  return value;
}

/** Return a positive safe integer, or null for any other value. */
export function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
