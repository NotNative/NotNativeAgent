// SPDX-License-Identifier: Apache-2.0
/** §G.7: synthetic client-side instruction wrapper; already-wrapped stays stable. */
const WRAP_HEAD = '<system-reminder>\n';
const WRAP_TAIL = '\n</system-reminder>';

export function wrapSystemReminder(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (trimmed.startsWith(WRAP_HEAD) && trimmed.endsWith(WRAP_TAIL)) return trimmed;
  return `${WRAP_HEAD}${trimmed}${WRAP_TAIL}`;
}
