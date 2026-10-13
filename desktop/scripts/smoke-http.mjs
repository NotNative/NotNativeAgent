// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

export async function withTimeout(operation, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function json(call, path, initOrStatus, expectedStatus) {
  const init = typeof initOrStatus === 'number' ? undefined : initOrStatus;
  const status = typeof initOrStatus === 'number' ? initOrStatus : expectedStatus;
  const response = await call(path, init);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

export function eventReader(reader) {
  const decoder = new TextDecoder(); let pending = '';
  return async () => {
    for (;;) {
      const split = pending.indexOf('\n\n');
      if (split >= 0) {
        const frame = pending.slice(0, split); pending = pending.slice(split + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (data) return JSON.parse(data);
        continue;
      }
      const part = await reader.read();
      if (part.done) throw new Error('NNA event stream ended before the expected event');
      pending += decoder.decode(part.value, { stream: true });
      if (pending.length > 65_536) throw new Error('NNA event frame exceeded smoke bound');
    }
  };
}
