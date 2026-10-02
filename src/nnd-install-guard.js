// SPDX-License-Identifier: Apache-2.0
import { acquireNndServiceLock } from './nnd-service-lock.js';
import { exactRecord } from './nnd-service-contract.js';
import { createNndInstallMarker, clearNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';
import { assertNoNndInstallTransaction } from './nnd-install-storage.js';

export async function runNndInstallGuard(identity, { input = process.stdin, output = process.stdout, diagnostics = process.stderr } = {}) {
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  let release;
  const outputLost = () => release?.orphan();
  // Security: broken private pipes must not terminate the lease holder during installer parent loss.
  const diagnosticLost = () => {};
  output.on?.('error', outputLost); diagnostics.on?.('error', diagnosticLost);
  try {
    await assertNoNndInstallTransaction(identity);
    await assertNoNndMigration(identity);
    const marker = await createNndInstallMarker(identity);
    release = awaitInstallRelease(identity, input, diagnostics);
    output.write(`${JSON.stringify({ type: 'install_guard', protocol: '1.0',
      installation_id: identity.installation_id, data_id: identity.data_id })}\n`);
    await Promise.race([release.done, lease.lost.then((error) => { if (error) throw error; })]);
    await clearNndInstallMarker(marker);
  } finally {
    release?.cleanup(); await lease.close();
    output.off?.('error', outputLost); diagnostics.off?.('error', diagnosticLost);
  }
}
function awaitInstallRelease(identity, input, diagnostics) {
  let resolve, buffer = '', released = false, orphaned = false;
  const done = new Promise((finish) => { resolve = finish; });
  const orphan = () => {
    if (orphaned) return;
    orphaned = true; buffer = '';
    // Invariant: installer subprocesses can survive parent loss. EOF alone never proves writer quiescence.
    diagnostics.write('nna: nnd_install_guard_orphaned\n');
  };
  const data = (chunk) => {
    if (orphaned) return;
    if (released || Buffer.byteLength(buffer, 'utf8') + chunk.length > 1024) return orphan();
    buffer += chunk.toString('utf8');
    if (!buffer.includes('\n')) return;
    try {
      const newline = buffer.indexOf('\n');
      if (newline !== buffer.length - 1) return orphan();
      const frame = JSON.parse(buffer.slice(0, newline));
      if (!exactRecord(frame, ['type', 'installation_id', 'data_id']) || frame.type !== 'release'
        || frame.installation_id !== identity.installation_id || frame.data_id !== identity.data_id) return orphan();
      released = true; buffer = '';
    } catch { orphan(); }
  };
  const end = () => { if (released && !orphaned) resolve(); else orphan(); };
  input.on('data', data); input.once('end', end); input.once('error', orphan);
  if (input.readableEnded) end(); else input.resume();
  return { done, orphan, cleanup() { input.off('data', data); input.off('end', end); input.off('error', orphan); input.pause(); } };
}
