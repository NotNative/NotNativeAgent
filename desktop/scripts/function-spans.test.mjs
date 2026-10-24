// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { functionSpans } from './function-spans.js';

test('function spans ignore braces in regexes, strings, comments, and templates', () => {
  const source = [
    'function inspect(value) {',
    '  const pattern = /a{2,3}/u;',
    '  const label = "}";',
    '  /* { } */',
    '  const template = `before ${value} after }`;',
    '  return pattern.test(label + template);',
    '}',
  ].join('\n');
  assert.deepEqual(functionSpans(source, 'fixture.js').map(({ start, length }) => ({ start, length })),
    [{ start: 1, length: 7 }]);
});

test('long functions remain visible after regex and multiline literal content', () => {
  const source = [
    'export function inspect() {',
    '  const pattern = /a{2,3}/u;',
    '  const text = `',
    '  }',
    '  `;',
    ...Array.from({ length: 56 }, (_, index) => `  const line${index} = ${index};`),
    '  return pattern.test(text);',
    '}',
  ].join('\n');
  assert.deepEqual(functionSpans(source, 'fixture.ts').map(({ start, length }) => ({ start, length })),
    [{ start: 1, length: 63 }]);
});

test('function spans include nested arrows and reject malformed source', () => {
  const source = 'const outer = () => {\n  const inner = () => 1;\n  return inner();\n};';
  assert.deepEqual(functionSpans(source, 'fixture.tsx').map(({ start, length }) => ({ start, length })), [
    { start: 1, length: 4 }, { start: 2, length: 1 },
  ]);
  assert.throws(() => functionSpans('function broken( {', 'broken.ts'), /cannot measure broken\.ts/u);
});

test('fingerprints follow function content, not its position or length alone', () => {
  const source = 'function inspect() {\n  return true;\n}';
  const original = functionSpans(source, 'fixture.mjs')[0];
  const shifted = functionSpans(`// comment\n${source}`, 'fixture.mjs')[0];
  const changed = functionSpans(source.replace('true', 'null'), 'fixture.mjs')[0];
  assert.equal(shifted.start, original.start + 1);
  assert.equal(shifted.digest, original.digest);
  assert.equal(changed.length, original.length);
  assert.notEqual(changed.digest, original.digest);
  assert.equal(functionSpans(source.replaceAll('\n', '\r\n'), 'fixture.mjs')[0].digest, original.digest);
});

test('parser recognizes JS, TS, TSX, and MJS function bodies', () => {
  const fixtures = [
    ['fixture.js', 'function a() { return 1; }'],
    ['fixture.ts', 'function a(value: number): number { return value; }'],
    ['fixture.tsx', 'const A = () => <div>ok</div>;'],
    ['fixture.mjs', 'export function a() { return 1; }'],
  ];
  for (const [path, source] of fixtures) {
    assert.equal(functionSpans(source, path).length, 1, path);
  }
});
