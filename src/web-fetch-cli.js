// SPDX-License-Identifier: Apache-2.0
import { loadWebFetchConfig, normalizeTrustedOrigin, saveWebFetchConfig } from './web-fetch-config.js';

export async function runWebFetchCommand(args, paths) {
  const action = args[0] ?? 'status';
  const config = await loadWebFetchConfig(paths.webFetchConfig);
  if (action === 'status') return { config };
  const origin = normalizeTrustedOrigin(nonEmptyString(args[1]));
  if (action === 'trust') return persistOrigins(paths.webFetchConfig, config, [...config.trusted_origins, origin]);
  if (action === 'revoke') return persistOrigins(
    paths.webFetchConfig, config, config.trusted_origins.filter((item) => item !== origin),
  );
  throw Object.assign(new Error('invalid WebFetch command'), { code: 'invalid_web_fetch_command' });
}

async function persistOrigins(path, config, trustedOrigins) {
  return { config: await saveWebFetchConfig(path, {
    ...config, trusted_origins: trustedOrigins, updated_at: new Date().toISOString(),
  }) };
}

function nonEmptyString(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw Object.assign(new Error('exact origin required'), { code: 'web_fetch_origin_required' });
  }
  return value;
}
