// SPDX-License-Identifier: Apache-2.0

// Why: the failure-domain table is registry data, not registry logic; keeping it in
// its own module holds the generated code registry inside the reviewable size gate.
export const FAILURE_DOMAINS = Object.freeze({
  authorization: Object.freeze({ category: 'authorization', boundary: 'permission' }),
  contract: Object.freeze({ category: 'contract', boundary: null }),
  extension: Object.freeze({ category: 'extension', boundary: 'hook' }),
  internal: Object.freeze({ category: 'internal', boundary: null }),
  mcp: Object.freeze({ category: 'mcp', boundary: 'mcp' }),
  memory: Object.freeze({ category: 'memory', boundary: 'memory' }),
  persistence: Object.freeze({ category: 'persistence', boundary: 'persistence' }),
  provider: Object.freeze({ category: 'provider', boundary: 'provider' }),
  shutdown: Object.freeze({ category: 'internal', boundary: 'shutdown' }),
  tool: Object.freeze({ category: 'tool', boundary: 'tool' }),
});
