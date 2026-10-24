// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import ts from 'typescript';

export function functionSpans(source, path) {
  const kind = ts.getScriptKindFromFileName(path);
  // Invariant: checkout line endings must not change the reviewed debt fingerprint.
  const normalized = source.replaceAll('\r\n', '\n');
  const parsed = ts.createSourceFile(path, normalized, ts.ScriptTarget.Latest, true,
    kind === ts.ScriptKind.Unknown ? ts.ScriptKind.TS : kind);
  const failure = parsed.parseDiagnostics.find((item) => item.category === ts.DiagnosticCategory.Error);
  if (failure) {
    const detail = ts.flattenDiagnosticMessageText(failure.messageText, ' ');
    throw new Error(`cannot measure ${path}: ${detail}`);
  }
  const spans = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const start = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
      const end = parsed.getLineAndCharacterOfPosition(node.body.end - 1).line + 1;
      const digest = createHash('sha256').update(node.getText(parsed)).digest('hex');
      spans.push({ start, length: end - start + 1, digest });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return spans;
}
