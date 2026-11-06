// SPDX-License-Identifier: Apache-2.0
// Compatibility: pinned to the published client contract used by OpenChamber.
// This identifies the protocol target; NNA is an independent implementation.
//
// Why 2.2.5: OpenChamber's installed desktop build (2.6.1) pins
// @opencode/client 2.2.5 and refuses a server whose major is not 2 or whose
// version is below MINIMUM_OPENCODE_VERSION 2.2.4. Reporting an older target
// makes the surface unreachable, and reporting a future major is rejected by the
// same gate, so this number is the client contract and nothing more. Surfaces
// this build does not implement fail explicitly (see OPENCODE_PROTOCOL.md).
export const WIRED_OPENCODE_VERSION = '2.2.5';
/** The oldest OpenChamber client contract this surface can serve. */
export const MINIMUM_OPENCODE_VERSION = '2.2.4';
export const HANDSHAKE_LINE_PREFIX = 'opencode server listening on ';
export const DEFAULT_SERVE_HOSTNAME = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 0;
export const DEFAULT_BASIC_USERNAME = 'opencode';
export const DIAGNOSTICS_ROUTE = '/__nna/diagnostics';
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
