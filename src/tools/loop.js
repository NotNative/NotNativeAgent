// SPDX-License-Identifier: Apache-2.0
import { ToolChildState } from '../lifecycle.js';
import {
  invalidRequestRecord, reviewStatus, toolDecisionState, toolRequestRecord,
  toolResultRecord, toolResultState, toolStatus,
} from '../engine/records.js';
import { blockedResult, denialResult, invalidResult, toolSettlementTerminal } from './governor.js';
import { assertMissionBudget, missionConditionFailure, reserveAndPersistMissionTools } from '../authority.js';
import { ToolResultCache } from './result-cache.js';
import { assertTurnActive } from '../turn-cancellation.js';
import { ContractError } from '../ids.js';
import { buildReviewEvidence } from '../review-evidence.js';
import { WebUrlProvenance } from '../web-url-provenance.js';
import { missingFilesystemPrerequisite } from '../reliability/filesystem-recovery.js';
import { toolLifecycleStatus, toolReviewOutcome, toolTelemetryOutcome } from './tool-result-contract.js';
import { toolRequestFingerprint } from '../reliability/tool-progress.js';

const SUCCESSFUL_TOOL_CONTINUATION = null;

export class ToolLoop {
  constructor(options) {
    this.engine = options.engine;
    this.state = options.state;
    this.lifecycles = options.lifecycles;
    this.tools = options.tools;
    this.governor = options.governor;
    this.events = options.events;
    this.eventFactory = options.eventFactory;
    this.output = options.output;
    this.telemetry = options.telemetry;
    this.persist = options.persist;
    this.publish = options.publish;
    this.toolContext = options.toolContext;
    this.executionContext = options.executionContext;
    this.surface = options.surface;
    // Why: every parallel group crosses one resolver boundary. Keeping a separate
    // read-only knob here made two independently defaulted concurrency mechanisms.
    this.parallelLimit = options.parallelLimit ?? (async () => 1);
    this.results = new ToolResultCache();
    this.pendingSettlements = new Map();
  }

  restore(transcript, records = []) {
    this.results.restore(transcript);
    this.pendingSettlements = restoredPendingSettlements(records);
  }

  async reconcilePendingSettlements(active = null) {
    for (const [requestId, pending] of this.pendingSettlements) {
      try {
        await this.governor.reconcile(requestId, pending.terminal);
        await this.persist('tool_settlement_reconciled', {
          requestId, turnId: pending.turnId ?? active?.turnId ?? null,
          reconciledAt: new Date().toISOString(),
        });
        this.pendingSettlements.delete(requestId);
        recordSettlementTelemetry(this.telemetry, 'succeeded', {
          request_id: requestId, reconciliation: true,
        }, { turnId: active?.turnId ?? pending.turnId ?? null, toolRequestId: requestId });
      } catch (error) {
        // Security: an unsettled prior decision grants no authority. Keep its
        // durable reconciliation record without rerunning the completed tool.
        recordSettlementTelemetry(this.telemetry, 'failed', {
          request_id: requestId, reconciliation: true,
        }, {
          turnId: active?.turnId ?? pending.turnId ?? null, toolRequestId: requestId,
          reasonCode: error?.code ?? 'tool_settlement_failed',
        });
      }
    }
    return this.pendingSettlements.size;
  }

  async process(calls, active) {
    const items = [];
    try {
      assertTurnActive(active);
      await this.reconcilePendingSettlements(active);
      active.webUrlProvenance ??= new WebUrlProvenance(active.prompt ?? '');
      assertMissionBudget(active, calls.length);
      active.authority = await reserveAndPersistMissionTools(
        this.engine.authority, this.engine.config, calls.length,
        (record) => this.persist('mission_tool_calls_reserved', record),
      );
      active.toolCalls += calls.length;
      this.state.transition('validating_tool_requests', { trigger: 'tool_calls_sealed', turnId: active.turnId });
      await this.#validate(calls, active, items);
      const valid = items.filter((item) => item.request);
      if (valid.length > 0) await this.#reviewAndExecute(valid, active);
      assertTurnActive(active);
      if (this.state.state !== 'processing_tool_results') {
        this.state.transition('processing_tool_results', { trigger: 'tools_settled', turnId: active.turnId });
      }
      await this.#commitItems(items, active);
      const missionFailure = missionToolDisposition(active, items);
      if (missionFailure) throw missionFailure;
      return items;
    } catch (error) {
      if (!active.cancelled && !active.controller.signal.aborted) throw error;
      await this.#settleCancellation(items, active);
      throw new ContractError('turn_cancelled', 'turn was cancelled');
    }
  }

  async #validate(calls, active, items) {
    for (const call of calls) {
      const lifecycle = this.lifecycles.start('tool_call', active.stepId);
      const item = {
        call, lifecycle, child: new ToolChildState(), request: null,
        decision: null, result: null, finished: false,
      };
      try {
        const prior = this.results.lookup(call);
        if (prior) {
          item.result = prior;
          item.duplicate = true;
          this.lifecycles.finish(lifecycle.id, 'duplicate_ignored');
          item.finished = true;
          await this.output(toolStatus(this.engine, active, item, 'duplicate_ignored'));
          items.push(item);
          continue;
        }
        if (call.invalid) throw new ContractError(call.invalid.code, call.invalid.message);
        const request = await this.tools.seal(call, this.toolContext(active));
        const blockedAt = active.blockedToolRequests?.get(toolRequestFingerprint(request.toolName, request.args));
        if (blockedAt === (active.observableStateRevision ?? 0)) {
          throw new ContractError(
            'tool_exact_request_blocked',
            'This exact tool request already reached its no-effect retry boundary at the current observable state. Do not repeat it; change the action, target, arguments, tool, or verification method.',
          );
        }
        if (request.toolName === 'web.fetch') {
          item.urlProvenance = active.webUrlProvenance.classify(request.args.url);
          if (active.webUrlProvenance.hasFailed(request.args.url)) {
            throw new ContractError(
              'web_fetch_url_already_failed',
              'WebFetch already failed for this exact URL during the current turn. Do not retry WebFetch. If WebBrowse is available, use web.browse with action navigate on this same exact URL, then inspect the page. Only if browser navigation is unavailable or also fails should you use another exact URL returned by WebSearch or supplied by the user.',
            );
          }
        }
        item.request = request;
        item.child.move('review_pending');
        await this.persist('tool_request', toolRequestRecord(item.request, active.turnId, active.stepId));
      } catch (error) {
        item.child.move('invalid');
        item.result = invalidResult(call, error);
        await this.persist('tool_request', invalidRequestRecord(call, lifecycle.id, active.turnId, active.stepId));
      }
      await this.publish('tool_request.started', 'tool_request', 'active', {
        ...active, toolRequestId: item.request?.id ?? lifecycle.id,
      });
      if (item.request) await this.output(toolStatus(this.engine, active, item, 'review_pending'));
      items.push(item);
    }
  }

  async #commitItems(items, active) {
    let firstError = null;
    for (const item of items) {
      if (item.finished) continue;
      try {
        await this.#commit(item, active);
      } catch (error) {
        firstError ??= error;
        if (!item.finished) {
          this.lifecycles.finish(item.lifecycle.id, 'failed');
          item.finished = true;
        }
      }
    }
    if (firstError) throw firstError;
  }

  async #settleCancellation(items, active) {
    for (const item of items) {
      if (item.finished) continue;
      item.result ??= cancelledToolResult(item);
    }
    await this.#commitItems(items, active);
  }

  async #review(item, active) {
    const execution = this.toolContext(active);
    const reviewEvidence = buildReviewEvidence(this.engine.transcript, {
      currentRequestId: item.request.id,
      currentTurnId: active.turnId,
      request: item.request,
      authenticatedIntent: active.authority?.intent,
      conversationIntent: active.conversationIntent,
      approvedProposal: active.approvedProposal,
      justification: '',
    });
    this.telemetry?.record('review.context_retrieval', 'succeeded', {
      records_scanned: reviewEvidence.metadata.recordsScanned,
      scan_truncated: reviewEvidence.metadata.scanTruncated,
      recent_records: reviewEvidence.metadata.recentRecords,
      history_matches: reviewEvidence.metadata.historyMatches,
      matched_record_indexes: reviewEvidence.metadata.matchedRecordIndexes,
      relevance_scores: reviewEvidence.metadata.relevanceScores,
      packet_bytes: reviewEvidence.metadata.packetBytes,
      packet_truncated: reviewEvidence.metadata.packetTruncated,
    }, {
      spanId: `review-context:${item.request.id}`, parentSpanId: active.stepId,
      turnId: active.turnId, stepId: active.stepId, toolRequestId: item.request.id,
    });
    const context = {
      ...execution,
      authority: active.authority, definition: this.tools.definition(item.request.toolName),
      surface: this.surface, justification: '', signal: active.controller.signal,
      causalEvidence: reviewEvidence.evidence, conversationIntent: active.conversationIntent,
      approvedProposal: active.approvedProposal,
    };
    const event = this.eventFactory.create(
      'permission.pre', 'permission', 'pre', active, { request_id: item.request.id },
    );
    item.decision = await this.governor.review(item.request, context, event);
    item.child.move(toolDecisionState(item.decision.outcome));
    if (item.decision.outcome !== 'approve') item.result = denialResult(item.request, item.decision);
    await this.persist('lifecycle_event', event);
    await this.#permissionTerminal(item, active);
    await this.output(reviewStatus(this.engine, active, item));
    if (item.decision.outcome === 'approve') {
      await this.output(toolStatus(this.engine, active, item, 'approved'));
    }
  }

  async #permissionTerminal(item, active) {
    const terminal = this.eventFactory.create(
      'permission.terminal', 'permission', 'terminal',
      { ...active, toolRequestId: item.request.id }, {}, item.decision.outcome,
    );
    await this.events.dispatch(terminal);
    await this.persist('lifecycle_event', terminal);
  }

  async #execute(item, active) {
    const spanId = `tool-execution:${item.request.id}`;
    const started = process.hrtime.bigint();
    const correlation = {
      spanId, parentSpanId: item.lifecycle.id, turnId: active.turnId,
      stepId: active.stepId, toolRequestId: item.request.id,
    };
    this.telemetry?.record('tool.execution', 'started', {
      tool_name: item.request.toolName, args: item.request.args,
      resolved: item.request.resolved, decision: item.decision,
      ...(item.urlProvenance ? { url_provenance: item.urlProvenance } : {}),
    }, correlation);
    try {
      await this.governor.beginExecution(item.request, item.decision, this.executionContext(active));
    } catch (error) {
      item.result = blockedResult(item.request, error);
      active.webUrlProvenance.observe(item.request, item.result);
      item.child.move('failed');
      this.telemetry?.record('tool.execution', 'failed', {
        tool_name: item.request.toolName, result: item.result,
      }, { ...correlation, durationMs: elapsedMs(started), reasonCode: item.result.reason_code });
      return;
    }
    await this.publish('tool_execution.started', 'tool_request', 'active', {
      ...active, toolRequestId: item.request.id,
    });
    item.child.move('running');
    await this.output(toolStatus(this.engine, active, item, 'running'));
    try {
      item.result = await this.governor.executePrepared(item.request, item.decision, active.controller.signal);
      active.webUrlProvenance.observe(item.request, item.result);
      item.child.move(toolResultState(item.result));
      this.telemetry?.record('tool.execution', toolTelemetryOutcome(item.result), {
        tool_name: item.request.toolName, result: item.result,
      }, {
        ...correlation, durationMs: elapsedMs(started), outcome: item.result.status,
        reasonCode: item.result.reason_code, effectCertainty: item.result.effect_certainty,
      });
    } catch (error) {
      this.telemetry?.record('tool.execution', active.cancelled ? 'cancelled' : 'failed', {
        tool_name: item.request.toolName,
        failure: { code: error?.code ?? 'tool_execution_failed', name: error?.name ?? 'Error' },
      }, { ...correlation, durationMs: elapsedMs(started), reasonCode: error?.code });
      throw error;
    }
  }

  async #reviewAndExecute(items, active) {
    for (let index = 0; index < items.length;) {
      assertTurnActive(active);
      const parallelGroup = this.#parallelGroup(items[index]);
      let end = index + 1;
      if (parallelGroup !== null) {
        while (end < items.length && this.#parallelGroup(items[end]) === parallelGroup) end += 1;
      }
      if (this.state.state === 'validating_tool_requests' || this.state.state === 'executing_tools') {
        this.state.transition('awaiting_tool_approval', {
          trigger: 'mandatory_review', turnId: active.turnId,
        });
      }
      const group = items.slice(index, end);
      for (const item of group) { assertTurnActive(active); await this.#review(item, active); }
      const approved = group.filter((item) => item.decision?.outcome === 'approve');
      if (approved.length === 0) { index = end; continue; }
      this.state.transition('executing_tools', { trigger: 'approved_tools', turnId: active.turnId });
      // Invariant: every approval is obtained immediately before its execution group. A long
      // earlier tool cannot consume the approval lifetime of a later independent request.
      if (parallelGroup === null) {
        await this.#execute(approved[0], active); index = end; continue;
      }
      const limit = boundedParallelLimit(
        await this.parallelLimit(parallelGroup, active.controller.signal),
      );
      await boundedParallel(approved, limit, (item) => this.#execute(item, active));
      index = end;
    }
  }

  #parallelGroup(item) {
    const definition = this.tools.definition(item.request.toolName, item.request.definitionVersion);
    if (definition?.sideEffect === 'read_only') return 'read_only';
    return definition?.parallelGroup ?? null;
  }

  async #commit(item, active) {
    if (item.duplicate) return;
    this.results.record(item.call, item.result);
    await this.persist('tool_result', toolResultRecord(item, active.turnId, active.stepId));
    if (item.result.ledger_started) {
      try {
        await this.governor.settle(item.result);
      } catch (error) {
        const pending = Object.freeze({
          requestId: item.result.request_id, turnId: active.turnId,
          terminal: toolSettlementTerminal(item.result),
          reasonCode: error?.code ?? 'tool_settlement_failed',
        });
        await this.persist('tool_settlement_pending', pending);
        this.pendingSettlements.set(pending.requestId, pending);
        recordSettlementTelemetry(this.telemetry, 'failed', {
          request_id: pending.requestId, reconciliation: false,
        }, {
          turnId: active.turnId, stepId: active.stepId, toolRequestId: pending.requestId,
          reasonCode: pending.reasonCode,
        });
      }
    }
    this.lifecycles.finish(item.lifecycle.id, item.result.status);
    item.finished = true;
    await this.publish('tool_request.terminal', 'tool_request', 'terminal', {
      ...active, toolRequestId: item.request?.id ?? null,
    }, item.result.status, {
      cwd: this.engine.config.workspaceRoot, event: 'tool.call', phase: 'post',
      prompt: active.prompt ?? '', tool_name: item.result.tool_name,
      tool_input: item.request?.args ?? item.call.args ?? {},
      tool_output: item.result.content, is_error: item.result.status !== 'succeeded',
      model_name: active.modelName ?? '', loaded_skills: this.engine.skills?.loadedIds() ?? [],
    });
    await this.output(toolStatus(this.engine, active, item, item.result.status));
  }
}

function restoredPendingSettlements(records) {
  const pending = new Map();
  for (const record of records) {
    if (record?.type === 'tool_settlement_pending' && typeof record.payload?.requestId === 'string') {
      pending.set(record.payload.requestId, Object.freeze(record.payload));
    } else if (record?.type === 'tool_settlement_reconciled' && typeof record.payload?.requestId === 'string') {
      pending.delete(record.payload.requestId);
    }
  }
  return pending;
}

function recordSettlementTelemetry(telemetry, status, detail, correlation) {
  try { telemetry?.record('tool.settlement', status, detail, correlation); }
  catch { /* Observability cannot change a durable settlement outcome. */ }
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

async function boundedParallel(items, limit, operation) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]; index += 1;
      await operation(item);
    }
  });
  await Promise.all(workers);
}

function boundedParallelLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new ContractError('tool_concurrency_invalid', 'parallel tool limit must be between one and sixteen');
  }
  return value;
}

function cancelledToolResult(item) {
  return Object.freeze({
    request_id: item.request?.id ?? null,
    provider_call_id: item.request?.providerCallId ?? item.call.providerCallId ?? null,
    tool_name: item.request?.toolName ?? item.call.name ?? null,
    status: 'cancelled', content: 'tool execution was cancelled',
    truncated: false, elapsed_ms: 0, effect_certainty: 'none',
    untrusted: true, reason_code: 'tool_cancelled', ledger_started: false,
  });
}

function missionToolDisposition(active, items) {
  if (items.some((item) => item.result?.effect_certainty === 'unknown')) {
    return missionConditionFailure(active, 'unknown_effect');
  }
  if (items.some((item) => item.decision && item.decision.outcome !== 'approve')) {
    return missionConditionFailure(active, 'review_denial');
  }
  if (items.some((item) => ['failed', 'completed_nonzero', 'timed_out'].includes(item.result?.status))) {
    return missionConditionFailure(active, 'tool_failure');
  }
  if (items.some((item) => item.result?.status === 'cancelled')) {
    return missionConditionFailure(active, 'cancellation');
  }
  return null;
}

export function toolContinuationHint(items, fallback = null) {
  const truncatedArguments = items.find((item) => item.result?.reason_code === 'tool_arguments_truncated');
  if (truncatedArguments) {
    return 'The provider output limit cut off the tool arguments before the JSON closed. Action-repair mode now persists for this turn and disables private thinking on subsequent action steps. Retry with one concise bounded call. For edits, use the smallest unique anchor and replacement, and split larger changes across calls.';
  }
  const missingParent = items.map(missingFilesystemPrerequisite).find(Boolean);
  if (missingParent) {
    return `A required ancestor directory is missing. The next filesystem mutation must be ${missingParent.tool} with exactly ${JSON.stringify({ action: 'create', path: missingParent.path })}. `
      + 'That tool creates the complete path recursively. Do not retry the blocked file operation or repeat directory listings until this exact prerequisite succeeds.';
  }
  const failedFetch = items.find((item) => item.result?.tool_name === 'web.fetch'
    && ['failed', 'invalid_request', 'timed_out'].includes(item.result?.status));
  if (failedFetch) {
    return 'WebFetch could not retrieve that exact URL. Do not retry it with WebFetch and do not synthesize a replacement path. WebFetch and WebBrowse are independent retrieval paths: if WebBrowse is available, your next recovery call should use web.browse with action navigate on the same exact URL, then inspect the page if navigation succeeds. Only if browser navigation is unavailable or also fails should you choose another exact URL returned by WebSearch or supplied by the user. Do not end the research merely because WebFetch failed.';
  }
  const failedProcess = items.filter((item) => ['process.run', 'shell.run'].includes(item.result?.tool_name)
    && ['failed', 'completed_nonzero'].includes(item.result?.status));
  if (failedProcess.length > 0) {
    const exits = failedProcess.map((item) => {
      const code = item.result?.metadata?.exitCode;
      const signal = item.result?.metadata?.signal;
      return `${item.result.tool_name}: ${signal ? `signal ${signal}` : `exit ${code ?? 'nonzero'}`}`;
    });
    return `The command completed without an accepted success status (${exits.join(', ')}). Treat its stdout and stderr as diagnostic progress, not successful verification evidence. If the program documents that exit code as an expected result, declare it in accepted_exit_codes on a focused call. Otherwise correct the command, arguments, or underlying condition before retrying; do not repeat the same invocation unchanged.`;
  }
  const invalid = items.filter((item) => item.result?.status === 'invalid_request');
  if (invalid.length > 0) {
    if (invalid.some((item) => item.result?.tool_name === 'work.plan')) {
      return 'The durable plan update was invalid. Treat plan synchronization as bookkeeping, not as completion of or a blocker to independent substantive work. Correct the exact field reported by the tool. Use work.task_update when only one existing task status changed; use work.plan only for a complete snapshot change. If another independent task action remains available, continue it before retrying plan synchronization. Do not repeat unchanged arguments.';
    }
    const failures = [...new Set(invalid.map((item) => `${item.result.tool_name ?? 'tool'}: ${item.result.reason_code ?? 'invalid_request'}`))];
    return `The tool request was invalid (${failures.join(', ')}). Read the returned tool error for the exact field, expected value, and received value; correct that argument and retry the operation. Do not repeat unchanged arguments. Context reduction cannot repair a schema mismatch.`;
  }
  const visual = [...items].reverse().find((item) => item.result?.status === 'succeeded'
    && item.result?.tool_name === 'image.inspect');
  if (visual) {
    const verdict = visual.result.metadata?.visualVerdict ?? 'uncertain';
    if (verdict === 'pass') return 'The newest visual inspection passed the requested criteria. Finish unless another explicit acceptance criterion remains unverified.';
    if (verdict === 'minor_caveat') return 'The newest visual inspection found only a minor caveat. Do not start an open-ended polish loop; finish with a qualified note unless that caveat violates an explicit acceptance criterion.';
    if (verdict === 'material_issue') return 'The newest visual inspection found a material visible issue. Make one targeted correction and obtain newer visual evidence, or finish only with an honest qualification if no safe correction remains.';
    return 'The newest visual inspection was uncertain. Do not claim a visual pass from DOM text or reasoning; obtain one newer focused image inspection after a material change, or qualify the result.';
  }
  const denied = items.filter((item) => toolLifecycleStatus(item.result) === 'denied');
  if (denied.length === 0) {
    return items.length > 0 && items.every((item) => item.result?.status === 'succeeded')
      ? SUCCESSFUL_TOOL_CONTINUATION : fallback;
  }
  const immutable = denied.some((item) => toolReviewOutcome(item.result) === 'hard_deny');
  return immutable
    ? 'A tool reached an immutable policy boundary. Do not retry it or ask for authorization to bypass it. Continue the active task within the remaining capabilities, and report the boundary only if it prevents the objective.'
    : 'A tool was denied. Treat the denial as a route constraint, not the end of the task. Do not repeat an equivalent call unchanged. Continue with a safer, narrower, or more reversible approach. Ask the operator only after reasonable alternatives are exhausted; if blocked, state the attempted operation, denial, and exact clarification needed.';
}
