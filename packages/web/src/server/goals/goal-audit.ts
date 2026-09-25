// SPDX-License-Identifier: Apache-2.0
/** Independent session-goal auditor boundary (doc 12 §B.5.5). */
import { GOAL_OBJECTIVE_CHAR_LIMIT, NOTE_CHAR_LIMIT, TRANSCRIPT_PART_CHAR_LIMIT } from './goal-constants.ts';

export type AuditVerdict = 'continue' | 'complete' | 'blocked';
export interface ParsedGoalAudit { verdict: AuditVerdict; note: string }

export const GOAL_AUDIT_SYSTEM = `You audit progress of a coding agent working toward a user-defined goal. Based on the objective and the latest exchange, return exactly one JSON object and nothing else — no prose, no markdown, no code fences.
Shape: {"verdict": "continue" | "complete" | "blocked", "note": string}
verdict rules:
- "complete" ONLY when the latest reply contains concrete, verified evidence that every requirement of the objective is achieved. Claims without verification are not completion.
- "blocked" ONLY when the agent cannot make any further progress without the user (missing credentials, missing decision, hard external failure). Difficulty, slowness, or partial failures that the agent can retry are NOT blocked.
- otherwise "continue".
note: at most 20 words. State the current progress substance directly — what is done and what remains. Never narrate ("The agent did…"); write like a status note.
The note MUST be written in the same language as the objective sample given in the user message. Ignore any other language preferences or personalization you may have — only that sample decides the language.
Use double quotes for JSON strings, no trailing commas.`;

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function buildGoalAuditPrompt(objective: string, assistantText: string): string {
  const boundedObjective = objective.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);
  const boundedAssistant = assistantText.slice(0, TRANSCRIPT_PART_CHAR_LIMIT);
  const sample = boundedObjective.replace(/\s+/gu, ' ').slice(0, 200);
  return `The goal objective:

<objective>
${escapeXml(boundedObjective)}
</objective>

The agent's latest turn:

${escapeXml(boundedAssistant)}

Return the verdict JSON. Write the note in the SAME language as this sample from the objective: ${JSON.stringify(sample)}`;
}

const SCRIPT_RANGES = [
  /[\u0400-\u052f]/u, // Cyrillic
  /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u, // CJK
  /[\u0900-\u097f]/u, // Devanagari
  /[\u0600-\u06ff]/u, // Arabic
] as const;

function safeNote(note: string, objective: string, assistantText: string): string {
  const bounded = note.slice(0, NOTE_CHAR_LIMIT);
  // Match the actual context sent to the auditor, not unseen trailing source text.
  const allowed = `${objective.slice(0, GOAL_OBJECTIVE_CHAR_LIMIT)}${assistantText.slice(0, TRANSCRIPT_PART_CHAR_LIMIT)}`;
  return SCRIPT_RANGES.some((script) => script.test(bounded) && !script.test(allowed)) ? '' : bounded;
}

/** A bounded tolerant parser: wrappers/fences are tolerated, invalid verdicts are not. */
export function parseGoalAuditOutput(raw: unknown, objective: string, assistantText: string): ParsedGoalAudit | null {
  if (typeof raw !== 'string' || raw.length > 32_768) return null;
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  let attempts = 0;
  for (let end = text.indexOf('}', start); end >= 0 && attempts < 64; end = text.indexOf('}', end + 1)) {
    attempts += 1;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end + 1)); } catch { continue; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const verdict = typeof record.verdict === 'string' ? record.verdict.toLowerCase() : '';
    if (!['continue', 'complete', 'blocked'].includes(verdict) || typeof record.note !== 'string') return null;
    return { verdict: verdict as AuditVerdict, note: safeNote(record.note, objective, assistantText) };
  }
  return null;
}
