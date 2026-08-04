// SPDX-License-Identifier: Apache-2.0
import { stat } from 'node:fs/promises';

export async function inspectDataPermissions(root, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return Object.freeze({
      status: 'unknown', root, enforcement: 'windows_installer_acl',
      warning: 'ACL verification requires the native Windows release audit',
    });
  }
  try {
    const info = await (options.stat ?? stat)(root);
    const exposed = info.mode & 0o077;
    return Object.freeze({
      status: exposed === 0 ? 'ready' : 'degraded', root,
      mode: `0${(info.mode & 0o777).toString(8)}`,
      ...(exposed === 0 ? {} : { warning: 'data root permits group or other access' }),
    });
  } catch (error) {
    return Object.freeze({ status: 'degraded', root, code: error.code ?? 'permission_check_failed' });
  }
}
