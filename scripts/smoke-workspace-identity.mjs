// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/** A second, real directory cannot be selected by a browser request. */
export async function probeWorkspaceIdentity(call, workspace) {
  const other = join(workspace, 'other-repo');
  await mkdir(other);
  const response = await call('/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'wrong project', directory: other }),
  });
  assert.equal(response.status, 409, 'NND must reject a second workspace before native create');
  const catalog = await call('/api/session?roots=true');
  assert.equal(catalog.status, 200);
  assert.deepEqual(await catalog.json(), [], 'rejected second workspace must not create a session');
}
