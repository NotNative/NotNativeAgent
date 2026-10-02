// SPDX-License-Identifier: Apache-2.0
// Compatibility: pinned to the published client contract used by OpenChamber.
// This identifies the protocol target; NNA is an independent implementation.
export const WIRED_OPENCODE_VERSION = '2.0.21';
export const HANDSHAKE_LINE_PREFIX = 'opencode server listening on ';
export const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 0;
export const DEFAULT_BASIC_USERNAME = 'opencode';
export const DIAGNOSTICS_ROUTE = '/__nna/diagnostics';
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
