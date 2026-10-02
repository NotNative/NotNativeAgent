// SPDX-License-Identifier: Apache-2.0
import { apiError, invalid, objectInput } from './v2-contract.js';

export function observeForm(state, type, properties, events) {
  const id = `frm_${properties.question_token}`;
  if (type === 'question.asked') {
    if (state.forms.size >= 256) {
      const retired = [...state.forms.entries()].find(([, form]) => form.state.status !== 'pending');
      if (retired) state.forms.delete(retired[0]);
    }
    const fields = properties.questions.map((question, index) => ({
      key: `question_${index}`, title: question.question, required: true,
      type: question.multiple ? 'multiselect' : 'string', custom: question.custom,
      options: question.options.map((option) => ({ value: option.label, label: option.label,
        ...(option.description ? { description: option.description } : {}) })),
    }));
    const info = { id, sessionID: state.info.id, title: properties.narrative, fields };
    state.forms.set(id, { info, token: properties.question_token, state: { status: 'pending' } });
    events.emit(state, 'form.created', { form: info }, false);
  } else {
    const form = state.forms.get(id);
    if (!form) return;
    const answered = type === 'question.replied';
    form.state = answered ? { status: 'answered', answer: form.answer ?? {} } : { status: 'cancelled' };
    events.emit(state, answered ? 'form.replied' : 'form.cancelled', {
      id, sessionID: state.info.id, ...(answered ? { answer: form.state.answer } : {}),
    }, false);
  }
}

export function pendingForms(state) {
  return [...state.forms.values()].filter((form) => form.state.status === 'pending').map((form) => form.info);
}

export function getForm(state, id) {
  const form = state.forms.get(id);
  if (!form) throw apiError(404, 'FormNotFoundError', 'Form was not found', { id });
  return form;
}

export async function settleForm(state, id, body, operations, cancel = false) {
  const form = getForm(state, id);
  if (form.state.status !== 'pending') throw apiError(409, 'FormAlreadySettledError', 'Form is already settled', { id });
  if (cancel) return operations.questionReject(form.token);
  objectInput(body, ['answer']);
  objectInput(body.answer, form.info.fields.map((field) => field.key));
  const answers = form.info.fields.map((field) => {
    const value = body.answer[field.key];
    const values = field.type === 'multiselect' ? value : [value];
    if (!Array.isArray(values) || values.length > 16 || values.some((item) => typeof item !== 'string' || item.length > 4096)) {
      throw invalid('Answers must match the form field types');
    }
    return values;
  });
  form.answer = body.answer;
  try { return await operations.questionReply(form.token, { answers }); }
  catch (error) {
    delete form.answer;
    if (error?.code === 'question_request_invalid') throw invalid(error.message);
    throw error;
  }
}
