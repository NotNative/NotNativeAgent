// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduled-task constants (doc 12 §C). The slack windows are the claim
 * contract's load-bearing numbers: a fired occurrence within the slack of its
 * computed time is still accepted, and two instances claiming the SAME slot
 * collide only inside the ± slack window; everything wider is a decision.
 */

/** A computed occurrence fires within 5 s of its slot and stays accepted. */
export const TASK_DUE_SLACK_MS = 5_000;
/** Cross-instance claim window: same observed slot with-in ± slack collides. */
export const TASK_CLAIM_WINDOW_MS = 5_000;
/** Cross-process config-lock wait budget before a claim attempt gives up. */
export const CONFIG_LOCK_WAIT_MS = 10_000;
/** A config lock older than this is stale and can be stolen. */
export const CONFIG_LOCK_STALE_MS = 60_000;
/** Lock retry cadence while a sibling holds the config lock. */
export const CONFIG_LOCK_RETRY_MS = 20;
/** Weekly next-run candidates scan today plus 14 more calendar days. */
export const TASK_CANDIDATE_DAYS = 14;
/** Task name cap: longer names are rejected, never clamped. */
export const TASK_NAME_MAX = 80;
/** Task id cap (uuid or `loop:<scope>:<name>` shapes). */
export const TASK_ID_MAX = 128;
/** Prompt cap for a task execution. */
export const TASK_PROMPT_MAX = 20_000;
/** Cron expression cap. */
export const TASK_CRON_MAX = 200;
/** Task stored lastError cap. */
export const TASK_LAST_ERROR_MAX = 2_000;
/** Execution provider/model id caps (storage-safety bound; same 256 scale as
 * the goal evidence profile). */
export const TASK_ROUTE_ID_MAX = 256;
/** Session title for a run: trimmed task name capped before the stamp. */
export const TASK_TITLE_NAME_MAX = 120;
/** Unknown-field preservation applies to the WHOLE task document; unknown
 * project-config keys around `scheduledTasks` survive writes untouched. */
export const SCHEDULED_TASKS_KEY = 'scheduledTasks';
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/u;
