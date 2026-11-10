// SPDX-License-Identifier: Apache-2.0
// Compatibility: pinned to the published client contract used by OpenChamber.
// This identifies the protocol target; NNA is an independent implementation.
//
// Why the reported target tracks npm's @opencode/cli latest instead of a fixed
// pin: OpenChamber refuses a server whose major is not 2 or whose version is
// below MINIMUM_OPENCODE_VERSION, and its update toast compares the reported
// version against the registry's latest dist-tag — announcing a server that is
// older ("Version 2.2.7 available"). NNA is not that package and cannot be
// upgraded by it — the toast's own Update action fails closed for an external
// runtime — so the reported target is resolved from the registry at serve
// startup and the fixed value below is only the fallback when the registry
// cannot answer. Surfaces this build does not implement fail explicitly (see
// OPENCODE_PROTOCOL.md); a registry answer that breaks a real contract is a
// functional bug to fix in the surface, not a pin to chase.
export const WIRED_OPENCODE_VERSION = '2.2.7';
/** The oldest OpenChamber client contract this surface can serve. */
export const MINIMUM_OPENCODE_VERSION = '2.2.4';
export const HANDSHAKE_LINE_PREFIX = 'opencode server listening on ';
export const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 0;
export const DEFAULT_BASIC_USERNAME = 'opencode';
export const DIAGNOSTICS_ROUTE = '/__nna/diagnostics';
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

const REGISTRY_TIMEOUT_MS = 5_000;

/** Resolve the version this surface reports, from npm's `@opencode/cli`
 *  `latest` dist-tag.
 *
 *  Why resolved per serve boot rather than pinned in source: the only consumer
 *  of this number is a client compatibility gate and an update toast that
 *  compares against the registry itself, so a stale pin produces a permanent
 *  unactionable notice until a source change chases the registry. One bounded
 *  fetch per serve process is the whole cost.
 *
 *  Fail-closed to the pinned constant: an offline operator, a slow or
 *  unreachable registry, or a malformed answer must never block or break the
 *  surface — the fallback is a version known to clear the client's gates. A
 *  registry answer is accepted only when it is a 2.x semver at or above the
 *  minimum floor, because a future major is rejected by the same gate and a
 *  value below the floor makes the surface unreachable. */
export async function resolveWiredOpenCodeVersion(fetchImpl = globalThis.fetch, registryUrl = 'https://registry.npmjs.org/@opencode/cli/latest') {
  try {
    const response = await fetchImpl(registryUrl, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) return WIRED_OPENCODE_VERSION;
    const payload = await response.json();
    const version = typeof payload?.version === 'string' ? payload.version.trim().replace(/^v/u, '') : '';
    if (!/^2\.\d+\.\d+$/u.test(version)) return WIRED_OPENCODE_VERSION;
    if (compareVersionStrings(version, MINIMUM_OPENCODE_VERSION) < 0) return WIRED_OPENCODE_VERSION;
    return version;
  } catch {
    return WIRED_OPENCODE_VERSION;
  }
}

function compareVersionStrings(left, right) {
  const parts = (value) => value.split('.').map(Number);
  const [leftParts, rightParts] = [parts(left), parts(right)];
  for (let index = 0; index < 3; index += 1) {
    if ((leftParts[index] ?? 0) !== (rightParts[index] ?? 0)) return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
  }
  return 0;
}
