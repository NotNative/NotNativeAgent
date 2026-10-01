// SPDX-License-Identifier: Apache-2.0
import { createManagedSshBundle } from './ssh-managed-bundle.mjs';
import { createManagedSshBundleUploader } from './ssh-managed-transfer.mjs';
import { createManagedSshLifecycle } from './ssh-managed-lifecycle.mjs';
import { createSshRemoteCommandRunner } from './ssh-remote-command.mjs';

/** Compose local payload creation, SSH transfer, and remote process lifecycle. */
export function createManagedSshRuntime({
  getBundlePaths,
  createBundle = createManagedSshBundle,
  uploadBundle = createManagedSshBundleUploader(),
  runRemoteScript = createSshRemoteCommandRunner(),
} = {}) {
  if (typeof getBundlePaths !== 'function') throw new TypeError('getBundlePaths is required');
  const lifecycle = createManagedSshLifecycle({ runRemoteScript });
  const persistentSessions = new Map();

  return {
    async start(instance, { port }) {
      if (instance?.remoteOpenchamber?.uploadBundleOverSsh !== true) {
        throw new Error('managed-ssh-bundle-upload-not-enabled');
      }
      const existing = persistentSessions.get(instance.id);
      if (existing && existing.instance.sshCommand === instance.sshCommand && existing.port === port) {
        return existing.session;
      }
      if (existing) {
        await lifecycle.stop(existing.instance, existing.session.transferId);
        persistentSessions.delete(instance.id);
      }
      const bundle = createBundle(getBundlePaths());
      const uploaded = await uploadBundle(instance, bundle);
      try {
        const started = await lifecycle.installAndStart(instance, { transferId: uploaded.transferId, port });
        persistentSessions.set(instance.id, { instance: { ...instance }, session: started, port });
        return started;
      }
      catch (error) {
        try { await lifecycle.stop(instance, uploaded.transferId); } catch { /* preserve the startup failure */ }
        throw error;
      }
    },
    async stop(instance, session) {
      const existing = persistentSessions.get(instance?.id);
      const target = existing?.session.transferId === session?.transferId ? existing.instance : instance;
      const result = await lifecycle.stop(target, session?.transferId);
      if (existing?.session.transferId === session?.transferId) persistentSessions.delete(instance.id);
      return result;
    },
  };
}
