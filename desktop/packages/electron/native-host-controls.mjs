// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readSelectedNativeRuntime } from './native-service-client.mjs';
import { resolveActiveNndPackage } from '../../scripts/resolve-active-nnd-package.mjs';
import { readLaunchPreferences, saveLaunchPreferences } from '../../scripts/launch-preferences.mjs';
import { runTrayAction } from '../../scripts/tray-action.mjs';
const execute = promisify(execFile);

export function createNativeHostControls({ selection, anchor, openBrowser, reconnect, beforeRestart }, ports = {}) {
  let busy = false;
  const context = async () => {
    const selected = selection();
    if (!selected) throw new Error('native-host-unavailable');
    const plan = await (ports.resolve ?? resolveActiveNndPackage)(join(anchor(), 'nna-service-selection.json'), anchor());
    if (plan.installationId !== selected.installation_id || plan.dataId !== selected.data_id
      || plan.incarnationId !== selected.incarnation_id) throw new Error('native-selection-identity-changed');
    const runtime = (ports.runtime ?? readSelectedNativeRuntime)(plan.nnaInstallRoot);
    return { plan, runtime, file: join(runtime.dataRoot, 'config', 'desktop-launch.json') };
  };
  const command = async (runtime, action) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NNA_|NND_|NOTNATIVE_)/iu.test(key)));
    const { stdout } = await (ports.execute ?? execute)(runtime.node, [runtime.cli, 'desktop', action], {
      cwd: runtime.root, env: { ...env, NNA_HOME: runtime.dataRoot }, windowsHide: true, shell: false, timeout: 30000, maxBuffer: 65536,
    });
    return JSON.parse(stdout);
  };
  return async (action, payload) => {
    const mutation = action !== 'read';
    if (mutation && busy) throw new Error('native-host-busy');
    if (mutation) busy = true;
    try {
      const { plan, runtime, file } = await context();
      if (action === 'read') {
        const status = await command(runtime, 'status');
        if (typeof status?.enabled !== 'boolean' || typeof status?.login?.installed !== 'boolean'
          || status.service?.installation_id !== plan.installationId || status.service?.data_id !== plan.dataId) throw new Error('native-host-status-invalid');
        return { ...readLaunchPreferences(file), enabled: status.enabled, login_installed: status.login.installed,
          login_supported: status.login.supported === true, version: runtime.version, generation: status.service.instance_id };
      }
      if (action === 'preferences') return saveLaunchPreferences(file, payload);
      if (action === 'login') {
        if (!payload || Object.keys(payload).join(',') !== 'enabled' || typeof payload.enabled !== 'boolean') throw new Error('native-host-input-invalid');
        const result = await command(runtime, payload.enabled ? 'enable' : 'disable');
        if (result?.enabled !== payload.enabled || result?.login?.installed !== payload.enabled) throw new Error('native-host-login-unconfirmed');
        return { enabled: result.enabled, login_installed: result.login.installed };
      }
      if (!['browser', 'restart'].includes(action) || payload != null) throw new Error('native-host-input-invalid');
      if (action === 'restart') await beforeRestart?.();
      const result = await (ports.tray ?? runTrayAction)(anchor(), action, {
        resolve: async () => { await context(); return plan; }, open: openBrowser,
      });
      if (action === 'restart') (ports.schedule ?? setTimeout)(() => { void reconnect(result.generation); }, 500);
      return result;
    } finally { if (mutation) busy = false; }
  };
}
