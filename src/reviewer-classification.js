// SPDX-License-Identifier: Apache-2.0
/**
 * How each tool request is classified before review.
 *
 * Why this is its own module: the classification decides whether a request is
 * approved outright or sent to semantic review, so it is the one place a reader
 * should be able to see every rule at once. Keeping it beside the reviewer made
 * both files long enough that a rule could be missed.
 *
 * Invariant: `risk: 'safe'` means no semantic review runs. A branch earns it only
 * by returning data that cannot become instruction authority — a file the
 * operator named, a clock, a bounded observation. Retrieved content never
 * qualifies on the ground that it looks harmless: page text and search results
 * can carry an injection, and only the *kind* of value returning (data, not
 * authority) justifies the fast path.
 */
import { safeDestination } from './reviewer-packet.js';
import { workspaceTransitionClassification } from './reliability/workspace-scope.js';

export function classify(request, definition) {
  if (!definition || request.toolName !== definition.name) return definitionMismatchClassification();
  const outside = resolvedOutsideWorkspace(request);
  if (definition.name === 'workspace_change') return workspaceTransitionClassification(outside);
  // A directory list is a read even though it shares the mutation tool's name.
  if ((definition.name === 'fs_directory' && request.args?.action === 'list')
    || (definition.sideEffect === 'read_only' && definition.scope === 'workspace')) {
    return Object.freeze({
      risk: 'safe', reason: outside ? 'host_read' : 'workspace_read',
      effect: 'read_only', scope: outside ? 'host' : 'workspace', complexity: 'simple',
    });
  }
  const readOnly = readOnlyClassification(request, definition);
  if (readOnly) return readOnly;
  if (definition.name === 'web_browse') return browserClassification(request);
  if (definition.name === 'desktop_browser') return hostedBrowserClassification(request);
  const localControl = localControlClassification(definition);
  if (localControl) return localControl;
  if (definition.scope === 'ephemeral_reference' && definition.name.startsWith('ref_')) return ephemeralReferenceClassification(definition);
  // Why: sealed conversation_work scope—not provider-name punctuation—is this authority boundary.
  if (definition.scope === 'conversation_work') {
    return Object.freeze({ risk: 'safe', reason: 'bounded_conversation_work', effect: definition.sideEffect, scope: 'conversation_work', complexity: 'simple' });
  }
  const directoryRemoval = directoryRemovalClassification(request, definition);
  if (directoryRemoval) return directoryRemoval;
  if (definition.scope === 'workspace' && ['reversible', 'irreversible'].includes(definition.sideEffect)) {
    const recovery = resolvedRecovery(request);
    if (!outside && ['git_tracked', 'new_target'].includes(recovery)) {
      return Object.freeze({ risk: 'reversible', reason: recovery, effect: 'reversible', scope: 'workspace', complexity: 'simple' });
    }
    return Object.freeze({
      risk: 'review_required', reason: outside ? 'host_mutation' : 'unverified_recovery',
      effect: definition.sideEffect, scope: outside ? 'host' : 'workspace', complexity: 'simple',
    });
  }
  if (definition.name === 'system_elevate') return elevationClassification();
  if (['process_run', 'shell_run'].includes(definition.name)) return processClassification(request);
  return Object.freeze({ risk: 'review_required', reason: 'uncertain_effect', effect: definition.sideEffect, scope: definition.scope, complexity: 'unknown' });
}

/**
 * Why these are safe without semantic review: each returns data the operator
 * asked for and nothing that can become instruction authority, so a review would
 * spend a model call to re-read a boundary the tool already holds. The table is
 * one place because the reason code is what a decision record explains, and a
 * scattered set of branches made two of them drift apart.
 */
const READ_ONLY_REASONS = Object.freeze([
  { scope: 'product_guidance', names: ['nna_search_guidance', 'nna_read_guidance'], reason: 'packaged_product_guidance' },
  { scope: 'runtime_diagnostics', names: ['nna_list_sessions', 'nna_diagnose_turn'], reason: 'redacted_runtime_diagnostics' },
  { scope: 'runtime_info', names: ['system_time'], reason: 'host_clock_observation' },
  { scope: 'mcp_control', names: ['nna_mcp_status', 'nna_mcp_test'], reason: 'configured_mcp_inspection' },
  { scope: 'web_search', names: ['web_search'], reason: 'configured_web_search' },
]);

function readOnlyClassification(request, definition) {
  if (definition.sideEffect !== 'read_only') return null;
  const entry = READ_ONLY_REASONS.find((item) => item.scope === definition.scope && item.names.includes(definition.name));
  if (entry) {
    return Object.freeze({ risk: 'safe', reason: entry.reason, effect: 'read_only', scope: entry.scope, complexity: 'simple' });
  }
  if (definition.name !== 'web_fetch' || !['public_network', 'trusted_private_origin'].includes(request.resolved?.destination)) return null;
  const privateOrigin = request.resolved.destination === 'trusted_private_origin';
  return Object.freeze({ risk: 'safe', reason: privateOrigin ? 'trusted_private_web_fetch' : 'validated_public_web_fetch',
    effect: 'read_only', scope: privateOrigin ? 'private_network' : 'public_network', complexity: 'simple' });
}

function localControlClassification(definition) {
  if (definition.sideEffect === 'read_only' && definition.scope === 'tool_catalog' && definition.name === 'tool_search') {
    return Object.freeze({ risk: 'safe', reason: 'bounded_tool_catalog', effect: 'read_only', scope: 'tool_catalog', complexity: 'simple' });
  }
  // Why: a question is operator speech, not an effect. Review posture never
  // gates it; escalation would put a permission prompt in front of the question.
  if (definition.sideEffect === 'read_only' && definition.scope === 'conversation_control' && definition.name === 'question') {
    return Object.freeze({ risk: 'safe', reason: 'operator_question', effect: 'read_only', scope: 'conversation_control', complexity: 'simple' });
  }
  // Why: turn_finish records an assertion for deterministic supervision; it does not grant
  // authority or cause an external effect. Sending that assertion to semantic review would
  // make terminal reliability depend circularly on another model response.
  if (definition.sideEffect !== 'read_only' || definition.scope !== 'conversation_control'
    || definition.name !== 'turn_finish') return null;
  return Object.freeze({ risk: 'safe', reason: 'typed_terminal_declaration', effect: 'read_only', scope: 'conversation_control', complexity: 'simple' });
}

function processClassification(request) {
  if (request.toolName === 'shell_run' && request.args.privilege === 'administrator') return elevationClassification();
  const complexity = request.resolved.reviewComplexity ?? 'unknown';
  if (request.resolved?.readOnly === true) return Object.freeze({ risk: 'safe',
    reason: request.resolved.reviewPurpose ?? 'process_observation', effect: 'read_only',
    scope: 'host', complexity });
  const detached = request.resolved?.reliabilitySignals?.includes('detached_process');
  const foregroundServer = request.resolved?.reliabilitySignals?.includes('long_running_foreground');
  return Object.freeze({
    risk: 'review_required',
    reason: detached ? 'detached_process_request'
      : foregroundServer ? 'long_running_foreground_request'
      : ['simple_argv', 'simple_shell'].includes(complexity) ? 'process_execution' : 'opaque_process_request',
    effect: 'unknown', scope: 'host', complexity,
    purpose: request.resolved.reviewPurpose ?? 'general_process',
  });
}

function definitionMismatchClassification() {
  return Object.freeze({ risk: 'prohibited', reason: 'definition_mismatch', effect: 'unknown', scope: 'unknown', complexity: 'unknown' });
}

function directoryRemovalClassification(request, definition) {
  if (definition.name !== 'fs_directory' || request.args?.action !== 'remove') return null;
  return Object.freeze({
    risk: 'review_required', reason: request.args?.recursive ? 'recursive_directory_removal' : 'directory_removal',
    effect: 'irreversible', scope: resolvedOutsideWorkspace(request) ? 'host' : 'workspace', complexity: 'simple',
  });
}

function ephemeralReferenceClassification(definition) {
  return Object.freeze({ risk: 'safe', reason: 'bounded_ephemeral_reference', effect: definition.sideEffect, scope: 'ephemeral_reference', complexity: 'simple' });
}

function elevationClassification() {
  return Object.freeze({
    risk: 'review_required', reason: 'privileged_execution', effect: 'unknown', scope: 'host',
    complexity: 'privileged_execution', purpose: 'host_elevation',
  });
}

/**
 * Why a hosted page read is deterministic safe while every other action is
 * reviewed: reading brings information in, and it arrives as untrusted data that
 * cannot become instruction authority (`context.js` marks every tool result
 * untrusted). An injected page can therefore only ever ask the agent to do
 * something, and that something is an action — reviewed against the operator's
 * intent, where it does not belong. What a reading fast path must never skip is
 * the destination of a request that leaves: `open` names a new address whose path
 * and query can carry data out, so it is judged from the URL and the method.
 */
function hostedBrowserClassification(request) {
  const resolved = request.resolved ?? {};
  const action = request.args?.action;
  const method = resolved.method === 'POST' ? 'POST' : 'GET';
  if (resolved.readOnly === true) {
    return Object.freeze({ risk: 'safe', reason: 'hosted_surface_page_observation',
      effect: 'read_only', scope: 'browser', method, complexity: 'simple' });
  }
  return Object.freeze({ risk: 'review_required',
    reason: action === 'open' ? 'hosted_surface_page_navigation' : 'interactive_browser_action',
    effect: 'unknown', scope: 'browser', method, complexity: 'simple',
    destination: typeof resolved.destination === 'string' ? safeDestination(resolved.destination) : null });
}

function browserClassification(request) {
  const resolved = request.resolved ?? {};
  const destination = resolved.destination ?? null;
  // Why the method travels with every browser decision: a read fetches, a
  // change posts, and the reviewer must see which one it is judging.
  const method = ['POST', 'GET'].includes(resolved.method) ? resolved.method : 'GET';
  if (resolved.readOnly === true && destination === 'managed_workspace_origin') return Object.freeze({ risk: 'safe', reason: 'managed_workspace_browser_navigation', effect: 'read_only', scope: 'workspace', method, complexity: 'simple' });
  if (resolved.readOnly === true && destination === 'reviewable_loopback_origin') {
    return Object.freeze({ risk: 'review_required', reason: 'loopback_browser_navigation', effect: 'read_only', scope: 'loopback', method, complexity: 'simple' });
  }
  if (resolved.readOnly === true && [null, 'public_network', 'trusted_private_origin'].includes(destination)) {
    return Object.freeze({ risk: 'safe', reason: 'bounded_browser_observation', effect: 'read_only', scope: destination === 'trusted_private_origin' ? 'private_network' : 'browser', method, complexity: 'simple' });
  }
  return Object.freeze({ risk: 'review_required', reason: 'interactive_browser_action', effect: 'unknown', scope: 'browser', method: 'POST', complexity: 'simple' });
}

function resolvedRecovery(request) {
  if (request.toolName === 'fs_copy_file') return request.resolved?.destination?.recovery ?? 'none';
  if (request.toolName === 'fs_move_file') {
    return request.resolved?.source?.recovery === 'git_tracked' && request.resolved?.destination?.recovery === 'new_target'
      ? 'git_tracked' : 'none';
  }
  return request.resolved?.recovery ?? 'none';
}

export function resolvedOutsideWorkspace(request) {
  const targets = [request.resolved, request.resolved?.source, request.resolved?.destination].filter(Boolean);
  return targets.some((target) => target.insideWorkspace === false);
}
