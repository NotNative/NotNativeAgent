// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservation, namesScope, readingOf } from '../src/desktop-browser-observation.js';

const url = 'https://example.org/form';
const reading = (extra = {}) => ({ url, observationRevision: 4, observationId: '00000000-0000-4000-8000-000000000004',
  scope: 'document', ...extra });

test('a document snapshot covers any action on that exact page', () => {
  const observation = createObservation();
  observation.record(reading(), observation.consume('snapshot'));
  assert.equal(observation.check({ action: 'click', selector: '#anything', expectedUrl: url }), null);
  assert.equal(observation.check({ action: 'type', selector: '#q', expectedUrl: url }), null);
});

test('an action on another page or with no reading is refused', () => {
  const observation = createObservation();
  assert.match(observation.check({ action: 'click', selector: '#send', expectedUrl: url }), /requires a snapshot/u);
  observation.record(reading(), observation.consume('snapshot'));
  assert.match(observation.check({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/other' }),
    /requires a snapshot/u);
});

test('a scoped snapshot authorizes only the controls it reported', () => {
  const observation = createObservation();
  observation.record({ url, observationRevision: 4, observationId: '00000000-0000-4000-8000-000000000004',
    scope: '#checkout', elements: [{ selector: '#checkout > button.pay' }, { selector: '#checkout > input#card' }] },
  observation.consume('snapshot'));
  // Why: a selector the snapshot returned is evidence; one it did not is a guess
  // about layout, and clicking on a guess answered "ok" while nothing rendered.
  assert.equal(observation.check({ action: 'click', selector: '#checkout > button.pay', expectedUrl: url }), null);
  assert.equal(observation.check({ action: 'click', selector: '#checkout > form > button.pay', expectedUrl: url }), null);
  assert.match(observation.check({ action: 'click', selector: '#checkout .pay', expectedUrl: url }), /no observation/u);
  assert.match(observation.check({ action: 'click', selector: '#checkout > div:nth-of-type(3)', expectedUrl: url }), /no observation/u);
  assert.match(observation.check({ action: 'click', selector: '#elsewhere > button', expectedUrl: url }), /no observation/u);
});

test('an inspect is a reading of its own, so it needs no earlier one and keeps any reading', () => {
  const observation = createObservation();
  // Why: an inspect only reads one element's computed style. It changes nothing,
  // so it needs no receipt, and it does not spend one either — an agent may inspect
  // a control and then click the control it just read.
  assert.equal(observation.check({ action: 'inspect', selector: '#panel > button', expectedUrl: url }), null);
  observation.consume('inspect');
  assert.match(observation.check({ action: 'click', selector: '#panel > button', expectedUrl: url }), /requires a snapshot/u);
  observation.record({ url, observationRevision: 4, observationId: '00000000-0000-4000-8000-000000000004',
    scope: '#panel', elements: [{ selector: '#panel > button' }] }, observation.consume('snapshot'));
  observation.consume('inspect');
  assert.equal(observation.check({ action: 'click', selector: '#panel > button', expectedUrl: url }), null);
});

test('a capture spends its reading like any other action', () => {
  const observation = createObservation();
  observation.record(reading(), observation.consume('snapshot'));
  assert.equal(observation.check({ action: 'capture', expectedUrl: url }), null);
  observation.consume('capture');
  assert.match(observation.check({ action: 'capture', expectedUrl: url }), /requires a snapshot/u);
});

test('a reading that lands after something consumed the authority does not revive it', () => {
  const observation = createObservation();
  const authorized = observation.consume('snapshot');
  observation.consume('open');
  observation.record(reading(), authorized);
  assert.match(observation.check({ action: 'click', selector: '#send', expectedUrl: url }), /requires a snapshot/u);
});

test('a scope is named by identity, never by position or ancestry', () => {
  assert.equal(namesScope('#panel > button', '#panel'), true);
  assert.equal(namesScope('#panel', '#panel'), true);
  assert.equal(namesScope('#panel > div > button.a', '#panel'), true);
  assert.equal(namesScope('#panel button', '#panel'), false);
  assert.equal(namesScope('#panel > :nth-of-type(2)', '#panel'), false);
  assert.equal(namesScope('#panel > div:nth-of-type(3) > button', '#panel'), false);
  assert.equal(namesScope('#panelx > button', '#panel'), false);
  assert.equal(namesScope('[data-testid="save"]', '[data-testid="pay"]'), false);
  assert.equal(namesScope('[data-testid="save"] > span', '[data-testid="save"]'), true);
});
