// SPDX-License-Identifier: Apache-2.0
import { loadWebFetchConfig, normalizeTrustedOrigin, saveWebFetchConfig } from './web-fetch-config.js';

export async function runWebFetchCommand(args, paths) {
  const action = args[0] ?? 'status';
  const config = await loadWebFetchConfig(paths.webFetchConfig);
  if (action === 'status') return { config };
  const origin = normalizeTrustedOrigin(required(args[1]));
  if (action === 'trust') return { config: await saveWebFetchConfig(paths.webFetchConfig, {
    ...config, trusted_origins: [...config.trusted_origins, origin], updated_at: new Date().toISOString(),
  }) };
  if (action === 'revoke') return { config: await saveWebFetchConfig(paths.webFetchConfig, {
    ...config, trusted_origins: config.trusted_origins.filter((item) => item !== origin), updated_at: new Date().toISOString(),
  }) };
  throw Object.assign(new Error('invalid WebFetch command'), { code: 'invalid_web_fetch_command' });
}

function required(value) {
  if (!value) throw Object.assign(new Error('exact origin required'), { code: 'web_fetch_origin_required' });
  return value;
}
