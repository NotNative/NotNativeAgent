// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side twin of the composer's OpenCode argument expansion (doc 12
 * §B.8/§D.3): `$ARGUMENTS` = the whole argument string; `$1..$N` = quoted or
 * bare words, the LAST placeholder absorbing the remainder; no placeholder
 * = the arguments append after the template. Mirrors the ui expansion rules
 * without importing the Vite-flavored graph (NOTES/02 D15).
 */
interface ArgumentWord {
  text: string;
}

/** Quoted ("…"/'…') or bare words, in order. */
export function splitCommandArgs(args: string): ArgumentWord[] {
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  const words: ArgumentWord[] = [];
  for (const match of args.matchAll(pattern)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    if (text !== '' || match[1] === '' || match[2] === '') words.push({ text });
  }
  return words;
}

function hasPlaceholders(template: string): boolean {
  return /\$ARGUMENTS|\$\d+/u.test(template);
}

function applyPositional(template: string, words: ArgumentWord[]): string {
  let highest = 0;
  for (const match of template.matchAll(/\$(\d+)/gu)) highest = Math.max(highest, Number(match[1]));
  return template.replace(/\$(\d+)/gu, (_match, digits: string) => {
    const position = Number(digits);
    if (position < 1 || position > words.length) return '';
    if (position < highest) return words[position - 1]!.text;
    // LAST placeholder absorbs the remainder (§B.8 last-position rule)
    return words.slice(position - 1).map((word) => word.text).join(' ');
  });
}

/**
 * §B.8 expansion, verbatim grammar. A malformed template never blocks the
 * dispatch — the template rides through untouched with the args appended.
 */
export function expandCommandTemplate(template: string, args: string): string {
  if (!hasPlaceholders(template)) {
    const tail = args.trim();
    return tail === '' ? template : `${template} ${tail}`;
  }
  if (template.includes('$ARGUMENTS')) return template.replaceAll('$ARGUMENTS', args);
  return applyPositional(template, splitCommandArgs(args));
}

/** First line of the invocation shape `/name args...`: the word after `/`. */
export function commandNameOf(text: string): string | null {
  const line = text.split('\n')[0] ?? '';
  const match = /^\/([^\s/]+)/u.exec(line);
  return match ? match[1]! : null;
}

/** Arguments = everything after the name token across the FULL text
 *  (registered choice: `$ARGUMENTS` = whole argument string, §B.8 — no
 *  second-line content can strand behind the route argument). */
export function commandArgsOf(text: string, name: string): string {
  const separator = `/${name}`;
  if (!text.startsWith(separator)) return '';
  return text.slice(separator.length).replace(/^[ \t]+/u, '');
}
