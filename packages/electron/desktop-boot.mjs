// SPDX-License-Identifier: Apache-2.0

function normalizeTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/u, '');
  } catch { return ''; }
}

function localResult({ localRuntime, localAvailable, bootOutcome }) {
  return {
    runtime: localRuntime,
    bootOutcome: bootOutcome ?? { target: 'local', status: localAvailable ? 'ok' : 'unreachable' },
  };
}

function bootFailureStatus(status) {
  if (status === 'auth' || status === 'unreachable') return 'unreachable';
  if (status === 'update-recommended') return 'incompatible';
  return status === 'wrong-service' || status === 'incompatible' ? status : 'unreachable';
}

/** Pick a boot runtime without mutating stored preferences. Unhealthy or
 * incompatible remotes fall back to the healthy local desktop server. */
export async function resolveDesktopBootTarget({
  config, localRuntime, localAvailable, envTargetUrl = '', probeHost,
}) {
  const hasEnvTarget = typeof envTargetUrl === 'string' && Boolean(envTargetUrl.trim());
  const envTarget = normalizeTarget(envTargetUrl);
  if (hasEnvTarget) {
    if (!envTarget) return localResult({
      localRuntime, localAvailable,
      bootOutcome: { target: 'remote', status: 'wrong-service', hostId: '__env', localAvailable },
    });
    let probe;
    try { probe = await probeHost({ url: envTarget }); }
    catch { probe = { status: 'unreachable' }; }
    if (probe.status === 'ok') return {
      runtime: { apiBaseUrl: envTarget, clientToken: null, requestHeaders: {}, runtimeKey: `url:${new URL(envTarget).origin}` },
      bootOutcome: { target: 'remote', status: 'ok', hostId: '__env', url: envTarget },
    };
    return localResult({
      localRuntime, localAvailable,
      bootOutcome: { target: 'remote', status: bootFailureStatus(probe.status), hostId: '__env', url: envTarget, localAvailable },
    });
  }

  const hostId = config?.defaultHostId;
  if (!hostId || hostId === 'local') return localResult({ localRuntime, localAvailable });
  const host = Array.isArray(config?.hosts) ? config.hosts.find((entry) => entry.id === hostId) : null;
  if (!host) return localResult({
    localRuntime, localAvailable,
    bootOutcome: { target: 'remote', status: 'missing', hostId, localAvailable },
  });

  const targetUrl = normalizeTarget(host.apiUrl || host.url);
  if (!targetUrl) return localResult({
    localRuntime, localAvailable,
    bootOutcome: { target: 'remote', status: 'wrong-service', hostId, url: String(host.url ?? ''), localAvailable },
  });
  let probe;
  try {
    probe = await probeHost({
      url: targetUrl,
      clientToken: host.clientToken,
      requestHeaders: host.requestHeaders,
      expectedServerId: host.serverId,
    });
  } catch { probe = { status: 'unreachable' }; }
  if (probe.status === 'ok') return {
    runtime: {
      apiBaseUrl: targetUrl,
      clientToken: host.clientToken ?? null,
      requestHeaders: host.requestHeaders ?? {},
      runtimeKey: `host:${host.id}`,
    },
    bootOutcome: { target: 'remote', status: 'ok', hostId, url: targetUrl },
  };
  return localResult({
    localRuntime, localAvailable,
    bootOutcome: {
      target: 'remote',
      status: bootFailureStatus(probe.status),
      hostId, url: targetUrl, localAvailable,
    },
  });
}
