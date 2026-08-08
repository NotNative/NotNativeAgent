// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { ToolChildState } from './lifecycle.js';
import {
  invalidRequestRecord, reviewStatus, toolDecisionState, toolRequestRecord,
  toolResultRecord, toolResultState, toolStatus,
} from './engine-records.js';
import { blockedResult, denialResult, invalidResult } from './tool-governor.js';
import { assertMissionBudget, missionConditionFailure, reserveAndPersistMissionTools } from './authority.js';
import { ToolResultCache } from './tool-result-cache.js';
import { assertTurnActive } from './turn-cancellation.js';
import { ContractError } from './ids.js';
import { buildReviewEvidence } from './review-evidence.js';

export class ToolLoop {
  constructor(options) {
    Object.assign(this, options);
    this.concurrency = boundedConcurrency(options.concurrency ?? 1);
    this.parallelLimit ??= async () => 1;
    this.results = new ToolResultCache();
  }

  restore(transcript) {
    this.results.restore(transcript);
  }

  async process(calls, active) {
    assertTurnActive(active);
    assertMissionBudget(active, calls.length);
    active.authority = await reserveAndPersistMissionTools(
      this.engine.authority, this.engine.config, calls.length,
      (record) => this.persist('mission_tool_calls_reserved', record),
    );
    active.toolCalls += calls.length;
    this.state.transition('validating_tool_requests', { trigger: 'tool_calls_sealed', turnId: active.turnId });
    const items = await this.#validate(calls, active);
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
    if (this.state.state !== 'processing_tool_results') {
      this.state.transition('processing_tool_results', { trigger: 'tools_settled', turnId: active.turnId });
    }
    let firstError = null;
    for (const item of items) {
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
    const missionFailure = missionToolDisposition(active, items);
    if (missionFailure) throw missionFailure;
    return items;
  }

  async #validate(calls, active) {
    const items = [];
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
        item.request = await this.tools.seal(call, this.toolContext(active));
        item.child.move('review_pending');
        await this.persist('tool_request', toolRequestRecord(item.request, active.turnId));
      } catch (error) {
        item.child.move('invalid');
        item.result = invalidResult(call, error);
        await this.persist('tool_request', invalidRequestRecord(call, lifecycle.id, active.turnId));
      }
      await this.publish('tool_request.started', 'tool_request', 'active', {
        ...active, toolRequestId: item.request?.id ?? lifecycle.id,
      });
      items.push(item);
    }
    return items;
  }

  async #review(item, active) {
    const execution = this.toolContext(active);
    const reviewEvidence = buildReviewEvidence(this.engine.transcript, {
      currentRequestId: item.request.id,
      currentTurnId: active.turnId,
      request: item.request,
      authenticatedIntent: active.authority?.intent,
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
      causalEvidence: reviewEvidence.evidence,
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
    }, correlation);
    try {
      await this.governor.beginExecution(item.request, item.decision, this.executionContext(active));
    } catch (error) {
      item.result = blockedResult(item.request, error);
      item.child.move('failed');
      this.telemetry?.record('tool.execution', 'failed', {
        tool_name: item.request.toolName, result: item.result,
      }, { ...correlation, durationMs: elapsedMs(started), reasonCode: item.result.reason_code });
      return;
    }
    item.child.move('running');
    await this.output(toolStatus(this.engine, active, item, 'running'));
    try {
      item.result = await this.governor.executePrepared(item.request, item.decision, active.controller.signal);
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
    await this.persist('tool_result', toolResultRecord(item, active.turnId));
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

function missionToolDisposition(active, items) {
  if (items.some((item) => item.result?.effect_certainty === 'unknown')) {
    return missionConditionFailure(active, 'unknown_effect');
  }
  if (items.some((item) => item.decision && item.decision.outcome !== 'approve')) {
    return missionConditionFailure(active, 'review_denial');
  }
  if (items.some((item) => ['failed', 'timed_out'].includes(item.result?.status))) {
    return missionConditionFailure(active, 'tool_failure');
  }
  if (items.some((item) => item.result?.status === 'cancelled')) {
    return missionConditionFailure(active, 'cancellation');
  }
  return null;
}

export function toolProgressEvidence(items, steeringApplied) {
  if (steeringApplied) return {
    value: `steering:${steeringApplied}`,
    detail: {
      kind: 'operator_steering', checkpoint: 'steering_consumed',
      summary: { consumed_messages: steeringApplied },
    },
  };
  const successes = items.filter((item) => item.result.status === 'succeeded');
  if (successes.length === 0) return null;
  const hash = createHash('sha256');
  const requestFingerprints = [];
  for (const item of successes) {
    hash.update(item.result.tool_name);
    hash.update(item.result.status);
    hash.update(stableJson(item.request?.args ?? {}));
    hash.update(item.result.content);
    requestFingerprints.push(createHash('sha256')
      .update(item.result.tool_name).update('\0').update(stableJson(item.request?.args ?? {})).digest('hex'));
  }
  return {
    value: hash.digest('hex'),
    detail: {
      kind: 'tool_results', checkpoint: 'tool_results_committed',
      summary: {
        successful_tool_calls: successes.length,
        tool_names: [...new Set(successes.map((item) => item.result.tool_name))].slice(0, 16),
        request_fingerprints: [...new Set(requestFingerprints)].slice(0, 16),
      },
    },
  };
}

export function toolContinuationHint(items, fallback = null) {
  const denied = items.filter((item) => ['deny_with_guidance', 'hard_deny'].includes(item.result?.status));
  if (denied.length === 0) return fallback;
  const immutable = denied.some((item) => item.result.status === 'hard_deny');
  return immutable
    ? 'A tool reached an immutable policy boundary. Do not retry it or ask for authorization to bypass it. Continue the active task within the remaining capabilities, and report the boundary only if it prevents the objective.'
    : 'A tool was denied. Treat the denial as a route constraint, not the end of the task. Do not repeat an equivalent call unchanged. Continue with a safer, narrower, or more reversible approach. Ask the operator only after reasonable alternatives are exhausted; if blocked, state the attempted operation, denial, and exact clarification needed.';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
