// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditDeprecatedIdentifiers, auditModelFacingDefinitions, countRationaleMarkers,
  scanJavaScriptIdentifiers, validateTerminologyContract,
} from '../scripts/controlled-language-gates.js';

function contract(overrides = {}) {
  return {
    schema: 'nna.controlled-technical-language.v1',
    standard: 'NNA-CTL/1',
    term_kinds: ['technical_noun'],
    model_facing_fields: ['guidance'],
    rationale_markers: ['Why'],
    terms: [{
      id: 'CTL-TERM-001', term: 'workflow lease', kind: 'technical_noun',
      definition: 'A bounded grant that makes one tool eligible for provider selection.',
      identifiers: ['grantWorkflowLease'],
    }],
    deprecated_identifiers: [{
      identifier: 'expose', replacement: 'grantWorkflowLease', reason: 'The old name is ambiguous.', baseline_occurrences: 1,
    }],
    ...overrides,
  };
}

test('a precise terminology contract is valid', () => {
  assert.deepEqual(validateTerminologyContract(contract()), []);
});

test('contract validation rejects duplicate identifiers and long definitions', () => {
  const longDefinition = `${Array.from({ length: 26 }, () => 'word').join(' ')}.`;
  const terms = [
    contract().terms[0],
    { id: 'CTL-TERM-002', term: 'tool lease', kind: 'technical_noun', definition: longDefinition, identifiers: ['grantWorkflowLease'] },
  ];
  const errors = validateTerminologyContract(contract({ terms }));
  assert.ok(errors.some((value) => value.includes('duplicates grantWorkflowLease')));
  assert.ok(errors.some((value) => value.includes('longer than 25 words')));
});

test('identifier scanning ignores prose but includes template expressions', () => {
  const source = [
    '// expose in a comment',
    'const text = "expose in a string";',
    'const template = `expose as text ${expose(value)}`;',
    'expose(value);',
  ].join('\n');
  assert.equal(scanJavaScriptIdentifiers(source).filter((value) => value === 'expose').length, 2);
});

test('deprecated identifier counts ratchet in both directions', () => {
  const equal = auditDeprecatedIdentifiers(contract(), [{ path: 'a.js', source: 'expose(value);' }]);
  assert.deepEqual(equal.errors, []);
  assert.equal(equal.advisories.length, 1);
  const increased = auditDeprecatedIdentifiers(contract(), [{ path: 'a.js', source: 'expose(value); expose(other);' }]);
  assert.match(increased.errors[0], /occurs 2 times/u);
  const improved = auditDeprecatedIdentifiers(contract(), [{ path: 'a.js', source: 'grantWorkflowLease(value);' }]);
  assert.match(improved.errors[0], /improved to 0 occurrences/u);
});

test('model-facing audit reports measurable candidates without judging prose intent', () => {
  const longPurpose = `${Array.from({ length: 26 }, (_, index) => `word${index}`).join(' ')}.`;
  const report = auditModelFacingDefinitions([{
    name: 'work.example', purpose: longPurpose,
    inputSchema: {
      type: 'object', description: 'A short object.', properties: {
        status: { type: 'string', description: 'A typed state value.' },
        nested: { type: 'object', properties: { result: { type: 'string', description: 'Observed content.' } } },
      },
    },
  }]);
  assert.deepEqual(report.stats, {
    tools: 1, proseFields: 4, proseSentences: 4, longProseCandidates: 1,
    unqualifiedBoundaryCandidates: 2, maximumSentenceWords: 26,
  });
  assert.deepEqual(report.long_prose_candidates, [{ tool: 'work.example', field: 'purpose', words: 26 }]);
  assert.deepEqual(report.unqualified_boundary_candidates, [
    { tool: 'work.example', field: 'inputSchema.properties.nested.properties.result' },
    { tool: 'work.example', field: 'inputSchema.properties.status' },
  ]);
});

test('rationale audit counts only explicit comment markers', () => {
  const counts = countRationaleMarkers(['Why', 'Security'], [{ path: 'a.js', source: [
    '// Why: preserve the contract.',
    'const text = "// Security: not a comment marker";',
    '/* Security: fail closed. */',
    '// Note: ordinary comment.',
  ].join('\n') }]);
  assert.deepEqual(counts, { Why: 1, Security: 1 });
});
