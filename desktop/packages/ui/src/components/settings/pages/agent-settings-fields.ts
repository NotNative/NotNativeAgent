// SPDX-License-Identifier: Apache-2.0
/** Presentation metadata only. The native catalog and preview remain authoritative. */
export interface AgentSetting {
  path: string; label: string; help: string; group: 'policy' | 'context' | 'memory' | 'files';
  type: 'integer' | 'number' | 'boolean' | 'string' | 'enum' | 'array';
  min?: number; max?: number; zero?: boolean;
}
export const AGENT_SETTINGS: AgentSetting[] = [
  { path: 'attachments.enabled', label: 'Allow attachments', group: 'files', type: 'boolean', help: 'Allows native attachment admission. It does not bypass file validation or review.' },
  { path: 'attachments.retain', label: 'Retain managed attachment copies', group: 'files', type: 'boolean', help: 'Retains managed copies for the native attachment lifecycle. Original source files are unchanged.' },
  { path: 'attachments.max_bytes', label: 'Attachment byte ceiling', group: 'files', type: 'integer', min: 1024, max: 104857600,
    help: 'Maximum admitted attachment bytes. Plain-text files also have a separate 64 KiB bound.' },
  { path: 'application_system_prompt', label: 'Application instructions', group: 'policy', type: 'string',
    help: 'Operator instructions in the user configuration. These do not grant tool authority or replace mandatory review.' },
  { path: 'persistence', label: 'Conversation persistence', group: 'policy', type: 'enum',
    help: 'Durable keeps conversation records. Ephemeral does not retain the durable conversation transcript. Requires a new session.' },
  { path: 'recovery.max_model_steps', label: 'Maximum model steps', group: 'policy', type: 'integer', min: 16, max: 100000,
    help: 'Maximum model steps in one turn, including recovery work.' },
  { path: 'recovery.local_retry_limit', label: 'Local retry limit', group: 'policy', type: 'integer', min: 2, max: 5,
    help: 'Native preview checks that the recovery ladder covers this limit minus one.' },
  { path: 'recovery.ladder', label: 'Recovery actions', group: 'policy', type: 'array',
    help: 'Ordered actions for repeated failures. NNA validates coverage against the retry limit.' },
  { path: 'recovery.turn_wall_clock_ms', label: 'Turn time limit (ms)', group: 'policy', type: 'integer', min: 1000, max: 86400000, zero: true,
    help: 'Zero leaves the turn time limit unset. Cancellation and other runtime bounds still apply.' },
  { path: 'approval_timeout_ms', label: 'Approval wait (ms)', group: 'policy', type: 'integer', min: 1000, max: 3600000,
    help: 'Maximum wait for a permission response; this does not grant approval.' },
  { path: 'tool_concurrency', label: 'Concurrent tools', group: 'policy', type: 'integer', min: 1, max: 16,
    help: 'Maximum concurrent tool work. Delegated work still uses native review and cancellation.' },
  { path: 'context_limit_bytes', label: 'Context byte ceiling', group: 'context', type: 'integer', min: 65536, max: 16777216,
    help: 'Root context ceiling in bytes. Provider and route limits can reduce it; this cannot enlarge model capacity.' },
  { path: 'context_compression_threshold', label: 'First compression threshold', group: 'context', type: 'number', min: .2, max: .9,
    help: 'Fraction of context capacity, from 0 to 1. Thresholds must increase strictly.' },
  { path: 'context_compression_level_2_threshold', label: 'Second compression threshold', group: 'context', type: 'number', min: .2, max: .99,
    help: 'Native preview shows all four thresholds after resolution.' },
  { path: 'context_compression_level_3_threshold', label: 'Third compression threshold', group: 'context', type: 'number', min: .2, max: .99,
    help: 'Must follow the second compression threshold and precede full compaction.' },
  { path: 'context_compaction_threshold', label: 'Full compaction threshold', group: 'context', type: 'number', min: .3, max: .99,
    help: 'Full compaction begins at this fraction of the context ceiling.' },
  { path: 'memory.enabled', label: 'Optional memory retrieval', group: 'memory', type: 'boolean',
    help: 'Requires a configured memory adapter. Disabling also clears Require memory. Local NNA.md context is separate.' },
  { path: 'memory.required', label: 'Require memory', group: 'memory', type: 'boolean',
    help: 'Enabling also enables retrieval. A retrieval failure can then fail a turn; leave off for optional memory.' },
  { path: 'memory.timeout_ms', label: 'Memory retrieval timeout (ms)', group: 'memory', type: 'integer', min: 50, max: 30000,
    help: 'Bounds the optional adapter request.' },
  { path: 'memory.max_items', label: 'Maximum retrieved items', group: 'memory', type: 'integer', min: 1, max: 64,
    help: 'Bounds retrieved memory items per request.' },
  { path: 'memory.max_bytes', label: 'Maximum retrieved bytes', group: 'memory', type: 'integer', min: 1024, max: 262144,
    help: 'Bounds admitted memory content. Retrieved content cannot grant authority.' },
];
export const AGENT_SETTINGS_SEARCH = AGENT_SETTINGS.filter(field => field.group !== 'files').map(field => ({ id: `agent.${field.path}`,
  page: field.group === 'policy' ? 'agent-policy' as const : 'agent-context' as const,
  title: field.label, keywords: `${field.path} ${field.help} ${field.group}` }));

export function agentDraftValid(field: AgentSetting, draft: string): boolean {
  if (field.type === 'string') { try { return typeof JSON.parse(draft) === 'string' && JSON.parse(draft).length <= 4096; } catch { return false; } }
  if (field.type !== 'number' && field.type !== 'integer') return true;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(draft)) return false;
  const value = Number(draft);
  return (field.type !== 'integer' || Number.isInteger(value))
    && (field.zero && value === 0 || value >= field.min! && value <= field.max!);
}
