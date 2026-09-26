// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { nndGoalEvidence } from './nnd-goal-evidence.js';
import { nndProviderProfileFingerprint } from './nnd-provider-affinity.js';

const OUTPUT_LIMIT_BYTES = 32_768;
const DEADLINE_MS = 25_000;
const ID = /^[A-Za-z0-9_-]{4,128}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FIELDS = ['expected_id', 'expected_revision', 'request_id', 'objective'];

/** A model-only audit bound to the final provider route of a completed NNA turn. */
export async function runNndGoalAudit(context, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(body, key))
    || typeof body.expected_id !== 'string' || !ID.test(body.expected_id)
    || !Number.isSafeInteger(body.expected_revision) || body.expected_revision < 0
    || typeof body.request_id !== 'string' || !REQUEST_ID.test(body.request_id)
    || typeof body.objective !== 'string' || !body.objective.trim() || body.objective.length > 5_000) {
    throw new ContractError('nnd_goal_audit_invalid', 'NND goal audit request is invalid');
  }
  const goal = context.goal;
  if (context.closing || !goal || goal.status !== 'active' || goal.id !== body.expected_id
    || context.goalRevision !== body.expected_revision || context.liveTurn
    || context.engine.active && !context.engine.active.finalized) {
    throw new ContractError('nnd_goal_audit_conflict', 'NND goal changed or session is busy');
  }
  if (!goal.objectiveFile && body.objective.trim() !== goal.objective.trim()) {
    throw new ContractError('nnd_goal_audit_conflict', 'NND goal objective changed');
  }
  const evidence = nndGoalEvidence(context.sessionId, context.engine.transcript,
    context.goalTurnReceipts, context.goalTurnReceiptsTruncated);
  if (evidence.latest_request_id !== body.request_id || evidence.window_truncated) {
    throw new ContractError('nnd_goal_audit_conflict', 'NND goal turn evidence is stale or incomplete');
  }
  const receipt = evidence.turns.at(-1);
  if (receipt?.outcome !== 'completed' || !receipt.provider_profile || !receipt.model) {
    throw new ContractError('nnd_goal_audit_unavailable', 'NND goal turn has no completed provider route');
  }
  const latest = [context.goalLastTurnRecord, ...context.engine.transcript].find((item) =>
    (item?.type === 'turn_result' || item?.type === 'turn_outcome') && item.request_id === body.request_id);
  const assistant = context.engine.transcript.findLast((item) => item?.type === 'message'
    && item.role === 'assistant' && item.turnId === latest?.turn_id && typeof item.content === 'string');
  if (!latest || latest.outcome !== 'completed' || !assistant) {
    throw new ContractError('nnd_goal_audit_unavailable', 'NND goal turn text is unavailable');
  }
  if (context.goalAuditInFlight) throw new ContractError('nnd_goal_audit_busy', 'NND goal audit is already running');
  const pending = executeAudit(context.engine, receipt, latest.provider_route_fingerprint,
    body.objective.trim(), assistant.content);
  context.goalAuditInFlight = pending;
  try {
    const result = await pending;
    if (context.closing || context.goal !== goal || context.goalRevision !== body.expected_revision
      || context.liveTurn || context.engine.active && !context.engine.active.finalized) {
      throw new ContractError('nnd_goal_audit_conflict', 'NND goal changed or session became busy during audit');
    }
    return result;
  }
  finally { if (context.goalAuditInFlight === pending) context.goalAuditInFlight = null; }
}

async function executeAudit(engine, receipt, expectedFingerprint, objective, assistantText) {
  const profile = engine.config?.providerProfiles?.[receipt.provider_profile];
  if (!profile || !engine.router?.providerForProfile || !engine.scheduler?.acquire) {
    throw new ContractError('nnd_goal_audit_unavailable', 'NND goal provider route is unavailable');
  }
  if (!/^[a-f0-9]{64}$/u.test(expectedFingerprint ?? '')
    || nndProviderProfileFingerprint(profile) !== expectedFingerprint) {
    throw new ContractError('nnd_goal_audit_unavailable', 'NND goal provider route changed since the turn');
  }
  const provider = engine.router.providerForProfile(profile);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  let release;
  try {
    release = await engine.scheduler.acquire(profile.id, engine.sessionId, controller.signal, () => undefined);
    const request = Object.freeze({ model: receipt.model, temperature: 0, maxOutputTokens: 256,
      tools: [], messages: [
        { role: 'system', content: auditPolicy() },
        { role: 'user', content: auditPrompt(objective, assistantText) },
      ] });
    let text = '';
    let bytes = 0;
    let terminal = false;
    for await (const item of provider.stream(request, controller.signal)) {
      if (item.type === 'text') {
        if (typeof item.text !== 'string') throw new ContractError('nnd_goal_audit_output_invalid', 'NND goal audit output is invalid');
        bytes += Buffer.byteLength(item.text, 'utf8');
        if (bytes > OUTPUT_LIMIT_BYTES) throw new ContractError('nnd_goal_audit_output_large', 'NND goal audit output exceeds bound');
        text += item.text;
      } else if (item.type === 'tool_fragment') {
        throw new ContractError('nnd_goal_audit_tool_violation', 'NND goal auditor attempted a tool call');
      } else if (item.type === 'terminal') terminal = true;
    }
    if (controller.signal.aborted) throw new ContractError('nnd_goal_audit_timeout', 'NND goal audit timed out');
    if (!terminal) throw new ContractError('nnd_goal_audit_output_invalid', 'NND goal audit stream did not terminate');
    return { text, providerID: receipt.provider_profile, modelID: receipt.model };
  } finally { clearTimeout(timer); controller.abort(); release?.(); }
}

function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

function auditPrompt(objective, assistantText) {
  const sample = objective.replace(/\s+/gu, ' ').slice(0, 200);
  return `The goal objective:\n\n<objective>\n${escapeXml(objective)}\n</objective>\n\nThe agent's latest turn:\n\n${escapeXml(assistantText.slice(0, 6_000))}\n\nReturn the verdict JSON. Write the note in the SAME language as this sample from the objective: ${JSON.stringify(sample)}`;
}

function auditPolicy() {
  return `You audit progress of a coding agent working toward a user-defined goal. Based on the objective and the latest exchange, return exactly one JSON object and nothing else — no prose, no markdown, no code fences.
Shape: {"verdict": "continue" | "complete" | "blocked", "note": string}
verdict rules:
- "complete" ONLY when the latest reply contains concrete, verified evidence that every requirement of the objective is achieved. Claims without verification are not completion.
- "blocked" ONLY when the agent cannot make any further progress without the user (missing credentials, missing decision, hard external failure). Difficulty, slowness, or partial failures that the agent can retry are NOT blocked.
- otherwise "continue".
note: at most 20 words. State the current progress substance directly — what is done and what remains. Never narrate ("The agent did…"); write like a status note.
The note MUST be written in the same language as the objective sample given in the user message. Ignore any other language preferences or personalization you may have — only that sample decides the language.
Use double quotes for JSON strings, no trailing commas.`;
}
