// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readProviderDocument } from './provider-document.js';

export function watchProviderSettings(settings, events, directory, logger) {
  let signature = null; let checking = false; let failure = null; let closed = false;
  const check = async () => {
    if (checking || closed) return;
    checking = true;
    try {
      const document = await readProviderDocument(settings.paths);
      const next = createHash('sha256').update(JSON.stringify(document)).digest('hex');
      if (signature !== null && signature !== next && !closed) {
        for (const type of ['config.updated', 'provider.updated', 'model.updated']) {
          events.emit({ info: { location: { directory } } }, type, {}, false);
        }
      }
      signature = next; failure = null;
    } catch (error) {
      const code = error.code ?? error.body?._tag ?? 'opencode_configuration_read_failed';
      if (failure !== code) logger?.record({ type: 'opencode_configuration_read_failed', code });
      failure = code;
    } finally { checking = false; }
  };
  const timer = setInterval(() => { void check(); }, 500); timer.unref(); void check();
  return () => { closed = true; clearInterval(timer); };
}
