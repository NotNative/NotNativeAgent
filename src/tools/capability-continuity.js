// SPDX-License-Identifier: Apache-2.0

const OPERATOR_TRUST = 'operator';
const WORK_PROVENANCE = 'conversation_work';
const MAX_QUERY_BYTES = 32_768;

export function capabilitySelectionQuery(context = []) {
  const latestIndex = findLatestOperator(context);
  if (latestIndex < 0) return '';
  const latest = bounded(context[latestIndex]?.content);
  if (!isTerseContinuation(latest)) return latest;
  const work = activeWorkIntent(context);
  if (work) return joinBounded(work, latest);
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const item = context[index];
    if (item?.trust !== OPERATOR_TRUST) continue;
    const prior = bounded(item.content);
    if (prior && !isTerseContinuation(prior)) return joinBounded(prior, latest);
  }
  return latest;
}

export function isTerseContinuation(value) {
  const text = bounded(value).toLowerCase().replace(/[.!?]+$/u, '').trim();
  if (!text || text.length > 160 || text.includes('\n')) return false;
  return /^(?:(?:yes|yeah|yep|ok(?:ay)?|agreed|sounds good|i agree)[, ]+)?(?:please )?(?:continue|proceed|resume|retry|go ahead|carry on|keep going|do it|make it so)(?: (?:with it|with that|from there|as planned|the task|the work))?$/u.test(text);
}

function findLatestOperator(context) {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    if (context[index]?.trust === OPERATOR_TRUST) return index;
  }
  return -1;
}

function activeWorkIntent(context) {
  const item = [...context].reverse().find((entry) => entry?.trust === 'kernel'
    && entry.provenance === WORK_PROVENANCE);
  if (!item) return '';
  const lineBreak = String(item.content ?? '').indexOf('\n');
  if (lineBreak < 0) return '';
  try {
    const work = JSON.parse(item.content.slice(lineBreak + 1));
    const goal = work?.goal?.status === 'active' ? bounded(work.goal.objective) : '';
    const tasks = Array.isArray(work?.tasks) ? work.tasks
      .filter((task) => task?.status !== 'completed').map((task) => bounded(task?.title)).filter(Boolean) : [];
    return joinBounded(goal, ...tasks);
  } catch {
    return '';
  }
}

function joinBounded(...values) {
  return bounded(values.filter(Boolean).join('\n'));
}

function bounded(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (Buffer.byteLength(text, 'utf8') <= MAX_QUERY_BYTES) return text;
  return Buffer.from(text, 'utf8').subarray(0, MAX_QUERY_BYTES).toString('utf8').replace(/\uFFFD$/u, '');
}
