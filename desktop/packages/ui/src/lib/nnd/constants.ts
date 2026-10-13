// SPDX-License-Identifier: Apache-2.0
/**
 * Harness-facing constants (doc 01 HP-1…HP-10 / doc 02 owns the contract).
 * THE coordination point with NotNativeAgent (NNA): wire-visible names live
 * here only, so a final naming pass coordinated with NNA is one-file work.
 */

const viteEnv: Record<string, string | undefined> | undefined = (
  import.meta as unknown as { env?: Record<string, string | undefined> }
).env;

/** HP-1: harness traffic shares the UI origin under /api (absolute when injected). */
export const DEFAULT_BASE_URL: string = viteEnv?.VITE_NND_URL || '/api';

/** HP-4: canonical directory scoping header (NNA naming pass may rename). */
export const DIRECTORY_HEADER = 'x-nnd-directory';
export const DIRECTORY_ENCODING_HEADER = 'x-nnd-directory-encoding';

/** HP-3: SDK read timeout; POSTs and /event URLs bypass. */
export const HARNESS_REQUEST_TIMEOUT_MS = 30_000;

/** HP-5: health probe timeout. */
export const HARNESS_HEALTH_TIMEOUT_MS = 4_000;

/** Harness event stream path (proxied under /api). */
export const EVENT_STREAM_PATH = '/api/event';

/** HP-8: URL-token query parameter for header-less transports. */
export const URL_TOKEN_PARAM = 'nn_url_token';

/** Mismatch guard (HP-4): thrown when the runtime changed between build and send. */
export const RUNTIME_CHANGED_MESSAGE = 'Message was not sent because the runtime changed.';
