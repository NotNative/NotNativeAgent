// SPDX-License-Identifier: Apache-2.0

const PROCESS_TOOLS = new Set(['process_run', 'shell_run']);

export function processTerminationEvidence(result) {
  if (!PROCESS_TOOLS.has(result?.tool_name)) return null;
  const signal = typeof result.metadata?.signal === 'string' && /^SIG[A-Z0-9]{2,20}$/u.test(result.metadata.signal)
    ? result.metadata.signal : null;
  const exitCode = Number.isSafeInteger(result.metadata?.exitCode) ? result.metadata.exitCode : null;
  const kind = result.reason_code === 'process_output_too_large' ? 'output_limit'
    : result.status === 'timed_out' ? 'timeout'
    : signal ? 'signal' : exitCode !== null ? 'exit_code' : 'unknown';
  return Object.freeze({ kind, signal, exit_code: exitCode });
}
