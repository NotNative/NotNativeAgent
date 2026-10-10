// SPDX-License-Identifier: Apache-2.0
// Field maps and pure draft gates for the native configuration controls. The
// engine stays the authority; these mirrors only keep obvious drafts away from
// the preview wire.
export const MEMORY_LIMITS: Record<string, { label: 'settings.nativeMemory.timeout' | 'settings.nativeMemory.maxItems'
  | 'settings.nativeMemory.maxBytes'; min: number; max: number }> = {
  'memory.timeout_ms': { label: 'settings.nativeMemory.timeout', min: 50, max: 30000 },
  'memory.max_items': { label: 'settings.nativeMemory.maxItems', min: 1, max: 64 },
  'memory.max_bytes': { label: 'settings.nativeMemory.maxBytes', min: 1024, max: 262144 },
};
export const MEMORY_BOOLEAN: Record<string, 'settings.nativeMemory.enabled' | 'settings.nativeMemory.required'> = {
  'memory.enabled': 'settings.nativeMemory.enabled', 'memory.required': 'settings.nativeMemory.required',
};
export const PROVIDER_SCHEDULING: Record<string, { label: 'settings.nativeScheduling.concurrency' | 'settings.nativeScheduling.queueLimit'
  | 'settings.nativeScheduling.toolConcurrency'; min: number; max: number }> = {
  provider_concurrency: { label: 'settings.nativeScheduling.concurrency', min: 1, max: 16 },
  provider_queue_limit: { label: 'settings.nativeScheduling.queueLimit', min: 1, max: 4096 },
  // NNA bounds this at src/configuration-rules.js integer('tool_concurrency', 1, 1, 16):
  // a preview rejects out-of-range drafts with invalid_limit and /save revalidates;
  // src/tools/loop.js additionally throws tool_concurrency_invalid at runtime.
  tool_concurrency: { label: 'settings.nativeScheduling.toolConcurrency', min: 1, max: 16 },
};
export const RECOVERY_BUDGETS: Record<string, { label: 'settings.nativeRecovery.maxSteps' | 'settings.nativeRecovery.retryLimit';
  min: number; max: number }> = {
  'recovery.max_model_steps': { label: 'settings.nativeRecovery.maxSteps', min: 16, max: 100000 },
  'recovery.local_retry_limit': { label: 'settings.nativeRecovery.retryLimit', min: 2, max: 5 },
};
export const SESSION_DEADLINES: Record<string, { label: 'settings.nativeSessionDeadlines.approval'
  | 'settings.nativeSessionDeadlines.persistence' | 'settings.nativeSessionDeadlines.shutdown'; min: number; max: number }> = {
  approval_timeout_ms: { label: 'settings.nativeSessionDeadlines.approval', min: 1000, max: 3600000 },
  persistence_flush_timeout_ms: { label: 'settings.nativeSessionDeadlines.persistence', min: 100, max: 120000 },
  shutdown_timeout_ms: { label: 'settings.nativeSessionDeadlines.shutdown', min: 100, max: 120000 },
};
export const REVIEWER_RETENTION = { path: 'reviewer_ledger.retention_entries', min: 1, max: 100000 } as const;
export const boundedPositiveInteger = (draft: string, field: { min: number; max: number }) => /^[1-9]\d*$/u.test(draft)
  && Number(draft) >= field.min && Number(draft) <= field.max;
export const CONTEXT_BUDGETS: Record<string, { label: 'settings.nativeContext.bytes' | 'settings.nativeContext.compression'
  | 'settings.nativeContext.level2' | 'settings.nativeContext.level3' | 'settings.nativeContext.compaction';
  type: 'integer' | 'number'; min: number; max: number }> = {
  context_limit_bytes: { label: 'settings.nativeContext.bytes', type: 'integer', min: 65536, max: 16777216 },
  context_compression_threshold: { label: 'settings.nativeContext.compression', type: 'number', min: 0.20, max: 0.90 },
  context_compression_level_2_threshold: { label: 'settings.nativeContext.level2', type: 'number', min: 0.20, max: 0.99 },
  context_compression_level_3_threshold: { label: 'settings.nativeContext.level3', type: 'number', min: 0.20, max: 0.99 },
  context_compaction_threshold: { label: 'settings.nativeContext.compaction', type: 'number', min: 0.30, max: 0.99 },
};
export const CONTEXT_THRESHOLD_PATHS = ['context_compression_threshold', 'context_compression_level_2_threshold',
  'context_compression_level_3_threshold', 'context_compaction_threshold'] as const;
export const contextDraftValid = (draft: string, field: { type: 'integer' | 'number'; min: number; max: number }) =>
  field.type === 'integer' ? boundedPositiveInteger(draft, field)
    : /^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(draft) && Number(draft) >= field.min && Number(draft) <= field.max;
export const DREAM_LIMITS: Record<string, { label: 'settings.nativeDream.idle' | 'settings.nativeDream.interStage'
  | 'settings.nativeDream.inferenceIdle' | 'settings.nativeDream.hygieneIdle' | 'settings.nativeDream.retention'; min: number; max: number }> = {
  'dream.idle_ms': { label: 'settings.nativeDream.idle', min: 5000, max: 3600000 },
  'dream.inter_stage_ms': { label: 'settings.nativeDream.interStage', min: 1000, max: 300000 },
  'dream.inference_idle_ms': { label: 'settings.nativeDream.inferenceIdle', min: 10000, max: 3600000 },
  'dream.hygiene_idle_ms': { label: 'settings.nativeDream.hygieneIdle', min: 30000, max: 7200000 },
  'dream.retention_days': { label: 'settings.nativeDream.retention', min: 1, max: 365 },
};
export const RUNTIME_TIMEOUTS: Record<string, { label: 'settings.nativeTimeouts.connect' | 'settings.nativeTimeouts.semanticReview'; min: number; max: number }> = {
  provider_connect_timeout_ms: { label: 'settings.nativeTimeouts.connect', min: 100, max: 600000 },
  semantic_review_timeout_ms: { label: 'settings.nativeTimeouts.semanticReview', min: 100, max: 86400000 },
};
export const PROVIDER_DEADLINE: Record<string, { label: 'settings.nativeDeadline.global' | 'settings.nativeDeadline.primary'; min: number; max: number }> = {
  provider_timeout_ms: { label: 'settings.nativeDeadline.global', min: 100, max: 86400000 },
  'routes.primary.deadline_ms': { label: 'settings.nativeDeadline.primary', min: 100, max: 86400000 },
};
export const providerDeadlineValid = (draft: string) => /^(?:0|[1-9]\d*)$/u.test(draft) && (draft === '0'
  || Number(draft) >= 100 && Number(draft) <= 86400000);
export const STREAM_TIMEOUTS: Record<string, { label: 'settings.nativeStreamTimeouts.firstToken' | 'settings.nativeStreamTimeouts.idle';
  legacy: number; pairedDefault: number }> = {
  first_token_timeout_ms: { label: 'settings.nativeStreamTimeouts.firstToken', legacy: 30000, pairedDefault: 600000 },
  idle_timeout_ms: { label: 'settings.nativeStreamTimeouts.idle', legacy: 45000, pairedDefault: 300000 },
};
export const streamTimeoutValid = (draft: string, field: { legacy: number; pairedDefault: number }) => /^(?:0|[1-9]\d*)$/u.test(draft)
  && (draft === '0' || Number(draft) >= 100 && Number(draft) <= 86400000
    && Number(draft) !== field.legacy && Number(draft) !== field.pairedDefault);
