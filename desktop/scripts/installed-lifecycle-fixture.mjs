// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { attachNativeService } from '../packages/electron/native-service-client.mjs';
import { runInstalledUiAcceptance } from './installed-ui-acceptance.mjs';

async function authenticatedApi(selection) {
  const attached = await attachNativeService(selection);
  const response = await fetch(`${attached.origin}/auth/native-bootstrap`, {
    method: 'POST', headers: { Origin: attached.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: attached.ticket }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, 'Fixture authentication failed');
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  await response.arrayBuffer();
  return async (path, method = 'GET', body) => {
    const result = await fetch(`${attached.origin}${path}`, { method,
      headers: { Cookie: cookie, Origin: attached.origin, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
    assert.ok(result.ok, `Fixture request failed: ${method} ${path} (${result.status})`);
    return result.json();
  };
}

/** Uses an active zero-turn record, never an operator's archived conversation. */
export async function runInstalledLifecycleAcceptance(scenario, marker, reconnectScenario) {
  const anchor = resolve(process.argv[2]);
  const plan = await resolveActiveNndPackage(join(anchor, 'nna-service-selection.json'), anchor);
  const selection = { installRoot: plan.nnaInstallRoot, installation_id: plan.installationId,
    data_id: plan.dataId, incarnation_id: plan.incarnationId };
  const api = await authenticatedApi(selection);
  const inventory = await api('/api/v1/nnd/workspaces/admissions');
  const workspace = await api(`/api/native-workspace/admission?directory=${encodeURIComponent(inventory.attached.root)}`);
  const title = `Lifecycle acceptance ${randomUUID()}`;
  const session = await api('/api/session', 'POST', { title, directory: workspace.directory, workspace_id: workspace.workspace_id });
  assert.ok(session.id && !session.time?.archived, 'Fixture must be an active session');
  try {
    await runInstalledUiAcceptance(scenario, marker, reconnectScenario, { title, sessionId: session.id });
  } finally {
    // Invariant: restart invalidates the old origin and cookie; cleanup authenticates again.
    const cleanup = await authenticatedApi(selection);
    const archived = await cleanup(`/api/session/${session.id}`, 'PATCH', { time: { archived: Date.now() } });
    assert.ok(archived.time?.archived, 'Fixture archive must be acknowledged');
  }
}
