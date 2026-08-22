// SPDX-License-Identifier: Apache-2.0
import { ToolChildState } from '../lifecycle.js';
import {
  invalidRequestRecord, reviewStatus, toolDecisionState, toolRequestRecord,
  toolResultRecord, toolResultState, toolStatus,
} from '../engine/records.js';
import { blockedResult, denialResult, invalidResult } from './governor.js';
import { assertMissionBudget, missionConditionFailure, reserveAndPersistMissionTools } from '../authority.js';
import { ToolResultCache } from './result-cache.js';
import { assertTurnActive } from '../turn-cancellation.js';
import { ContractError } from '../ids.js';
import { buildReviewEvidence } from '../review-evidence.js';
import { WebUrlProvenance } from '../web-url-provenance.js';
import { missingFilesystemPrerequisite } from '../reliability/filesystem-recovery.js';

const SUCCESSFUL_TOOL_CONTINUATION = 'Continue the existing active request from the newly committed tool results. Choose and perform the next useful action from this evidence. Do not greet, re-acknowledge the request, or repeat the existing plan. If a progress note is useful, state only what materially changed, then continue the work.';

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
    this.parallelLimit = options.parallelLimit;
    this.concurrency = boundedConcurrency(options.concurrency ?? 1);
    this.parallelLimit ??= async () => 1;
    this.results = new ToolResultCache();
  }

  restore(transcript) {
    this.results.restore(transcript);
  }

  async process(calls, active) {
    const items = [];
    try {
      assertTurnActive(active);
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
      if (valid.length > 0) {
        this.state.transition('awaiting_tool_approval', { trigger: 'mandatory_review', turnId: active.turnId });
        for (const item of valid) { assertTurnActive(active); await this.#review(item, active); }
      }
      assertTurnActive(active);
      const approved = valid.filter((item) => item.decision?.outcome === 'approve');
      if (approved.length > 0) {
        this.state.transition('executing_tools', { trigger: 'approved_tools', turnId: active.turnId });
        await this.#executeApproved(approved, active);
      }
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
      this.telemetry?.record('tool.execution', toolTelemetryStatus(item.result.status), {
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

  async #executeApproved(items, active) {
    for (let index = 0; index < items.length;) {
      assertTurnActive(active);
      const parallelGroup = this.#parallelGroup(items[index]);
      if (parallelGroup === null) {
        await this.#execute(items[index], active); index += 1; continue;
      }
      let end = index + 1;
      while (end < items.length && this.#parallelGroup(items[end]) === parallelGroup) end += 1;
      const limit = parallelGroup === 'read_only' ? this.concurrency
        : await this.parallelLimit(parallelGroup, active.controller.signal);
      await boundedParallel(items.slice(index, end), limit, (item) => this.#execute(item, active));
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
    let settlementError = null;
    if (item.result.ledger_started) {
      try {
        await this.governor.settle(item.result);
      } catch (error) {
        settlementError = error;
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
    if (settlementError) throw settlementError;
  }
}

function toolTelemetryStatus(status) {
  if (['succeeded', 'failed', 'cancelled', 'timed_out', 'unknown_effect'].includes(status)) return status;
  return status === 'denied' ? 'denied' : 'failed';
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

function boundedConcurrency(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new ContractError('tool_concurrency_invalid', 'tool concurrency must be between one and sixteen');
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

export { toolFailureFingerprint, toolProgressEvidence } from '../reliability/tool-progress.js';

export function toolContinuationHint(items, fallback = null) {
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
    const failures = [...new Set(invalid.map((item) => `${item.result.tool_name ?? 'tool'}: ${item.result.reason_code ?? 'invalid_request'}`))];
    return `The tool request was invalid (${failures.join(', ')}). Read the returned tool error for the exact field, expected value, and received value; correct that argument and retry the operation. Do not repeat unchanged arguments. Context reduction cannot repair a schema mismatch.`;
  }
  const denied = items.filter((item) => ['deny_with_guidance', 'hard_deny'].includes(item.result?.status));
  if (denied.length === 0) {
    return items.length > 0 && items.every((item) => item.result?.status === 'succeeded')
      ? SUCCESSFUL_TOOL_CONTINUATION : fallback;
  }
  const immutable = denied.some((item) => item.result.status === 'hard_deny');
  return immutable
    ? 'A tool reached an immutable policy boundary. Do not retry it or ask for authorization to bypass it. Continue the active task within the remaining capabilities, and report the boundary only if it prevents the objective.'
    : 'A tool was denied. Treat the denial as a route constraint, not the end of the task. Do not repeat an equivalent call unchanged. Continue with a safer, narrower, or more reversible approach. Ask the operator only after reasonable alternatives are exhausted; if blocked, state the attempted operation, denial, and exact clarification needed.';
}
