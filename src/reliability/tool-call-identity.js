// SPDX-License-Identifier: Apache-2.0

const MAX_DEPTH = 24;
const MAX_NODES = 10_000;
const MAX_BYTES = 262_144;

// Why: streaming duplicate-stop and execution deduplication must use exactly the same identity.
// Invalid or excessive structures have no identity; validation, not deduplication, reports them.
export function toolCallIdentity(call) {
  if (call?.invalid || typeof call?.name !== 'string' || !call.name
    || !call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return null;
  const tokens = [];
  const stack = [{ value: call.args, depth: 0 }];
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (++nodes > MAX_NODES * 5 || current.depth > MAX_DEPTH) return null;
    if (current.token !== undefined) {
      bytes += Buffer.byteLength(current.token, 'utf8');
      if (bytes > MAX_BYTES) return null;
      tokens.push(current.token);
      continue;
    }
    const value = current.value;
    if (value === null || typeof value !== 'object') {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return null;
      if (typeof value === 'number' && !Number.isFinite(value)) return null;
      stack.push({ token: JSON.stringify(value) });
      continue;
    }
    const array = Array.isArray(value);
    if (array && value.length > MAX_NODES) return null;
    const keys = array ? Array.from({ length: value.length }, (_, index) => index) : Object.keys(value).sort();
    if (keys.length > MAX_NODES || stack.length + keys.length > MAX_NODES * 5) return null;
    stack.push({ token: array ? ']' : '}' });
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      if (index < keys.length - 1) stack.push({ token: ',' });
      stack.push({ value: value[keys[index]], depth: current.depth + 1 });
      if (!array) stack.push({ token: `${JSON.stringify(keys[index])}:` });
    }
    stack.push({ token: array ? '[' : '{' });
  }
  return `${call.name}\0${tokens.join('')}`;
}
