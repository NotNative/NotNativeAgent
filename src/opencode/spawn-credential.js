// SPDX-License-Identifier: Apache-2.0
/**
 * The Basic-auth password a spawning host hands down, if any.
 *
 * Why this is its own module: the rule is small but its failure mode is silent. A
 * host generates its own credential and passes it in the child environment; serving
 * with the password from NNA's config instead makes every request the host sends
 * answer 401, which reads as a broken child rather than a credential disagreement.
 * Keeping the rule separate is what lets it be asserted directly instead of inferred
 * from a server that happened to start.
 */

/**
 * @param {{serveStdioLease?: boolean}} options the parsed invocation
 * @param {{environment?: Record<string, string|undefined>}} scope
 * @returns {string|null} the host's password, or null when this process keeps its own
 */
export function spawnCredentialFor(options, scope = {}) {
  // Why only under the lease: a detached daemon owns its credential through NNA's
  // config. Only a spawned child takes the host's, because only then is the host the
  // party authenticating against it.
  if (options?.serveStdioLease !== true) return null;
  const environment = scope.environment ?? process.env;
  // Why both names: OpenCode 2 reads OPENCODE_PASSWORD before the legacy
  // OPENCODE_SERVER_PASSWORD, and a host sets both so an older reader cannot pick up
  // a stale value. Reading them in the same order keeps one answer.
  const value = environment.OPENCODE_PASSWORD ?? environment.OPENCODE_SERVER_PASSWORD;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
