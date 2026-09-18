// SPDX-License-Identifier: Apache-2.0
// Version advertised on the OpenCode wire surface. OpenChamber gates UI
// behavior on the version reported by /global/health, so this constant must
// track the newest known-good OpenCode release rather than NNA's own version.
export const WIRED_OPENCODE_VERSION = '1.18.31';
export const HANDSHAKE_LINE_PREFIX = 'opencode server listening on ';
export const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 0;
export const DEFAULT_BASIC_USERNAME = 'opencode';
export const DIAGNOSTICS_ROUTE = '/__nna/diagnostics';
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
