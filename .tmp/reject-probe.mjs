import assert from 'node:assert/strict';
import { createWireSession } from '../src/opencode/wire-session.js';

const record = { ocId: 'ses_t', directory: 'C:\\fx', projectID: 'p'.repeat(40), ingress: { submit: async () => ({ outcome: 'completed', text: '' }) } };
const ws = createWireSession({
  record, bus: { publishSession() {}, publishGlobal() {} }, version: '9',
  info: () => ({ id: 'ses_t' }),
});
try {
  ws.prompt([]);
  console.log('NO THROW');
} catch (error) {
  console.log('THREW', error.constructor.name, JSON.stringify(error.message), error instanceof Error);
  try {
    await assert.rejects(() => { throw error; }, /at least one text part/u);
    console.log('REJECTS MATCHES');
  } catch (nested) {
    console.log('REJECTS FAILED', nested.constructor.name, nested.message);
  }
}
