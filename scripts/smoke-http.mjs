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
