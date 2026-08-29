// SPDX-License-Identifier: Apache-2.0
import { portableExecutableName } from './executable-name.js';

const INLINE_FLAGS = Object.freeze({
  node: new Set(['-e', '--eval']), bun: new Set(['-e', '--eval']), deno: new Set(['eval']),
  python: new Set(['-c']), python3: new Set(['-c']), py: new Set(['-c']),
  ruby: new Set(['-e']), perl: new Set(['-e']), php: new Set(['-r']),
});

export function inlineInterpreterInvocation(executable, args = []) {
  const name = portableExecutableName(executable);
  const flags = INLINE_FLAGS[name];
  if (!flags || !Array.isArray(args) || !flags.has(String(args[0] ?? '').toLowerCase())) return false;
  return typeof args[1] === 'string' && args[1].length > 0;
}

export function inlineInterpreterGuidance() {
  return 'Avoid embedding generated multi-statement programs in node -e, python -c, or similar argv: JSON, argv, and language escaping compound. Store the source with ref.store. Pass its draft identifier as stdin_ref to process.run. Use the interpreter stdin form: node with args ["-"] or python with args ["-"]. Keep inline evaluation for short, simple expressions.';
}
