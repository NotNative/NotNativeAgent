// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tool-registry.js';

test('optional LSP diagnostics fail clearly when no server is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lsp-empty-'));
  await writeFile(join(root, 'file.js'), 'const value = 1;');
  const registry = new ToolRegistry(root, { lspConfigPath: join(root, 'missing-lsp.json') });
  await registry.initialize();
  await assert.rejects(registry.definition('code.diagnostics').validate({ path: 'file.js' }), { code: 'lsp_not_configured' });
});

test('LSP diagnostics use bounded stdio protocol and return attributed findings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-lsp-'));
  const serverPath = join(root, 'fake-lsp.cjs');
  const configPath = join(root, 'lsp.json');
  await writeFile(join(root, 'file.js'), 'const value = ;');
  await writeFile(serverPath, fakeServerSource());
  await writeFile(configPath, JSON.stringify({ servers: [{
    id: 'fixture', command: process.execPath, args: [serverPath], extensions: ['.js'], language_id: 'javascript',
  }] }));
  const registry = new ToolRegistry(root, { lspConfigPath: configPath });
  await registry.initialize();
  const definition = registry.definition('code.diagnostics');
  const request = await definition.validate({ path: 'file.js' });
  const result = await definition.executor(request, new AbortController().signal);
  assert.equal(result.metadata.server, 'fixture');
  assert.equal(result.metadata.count, 1);
  assert.equal(result.metadata.new_count, 1);
  assert.equal(result.metadata.resolved_count, 0);
  assert.match(result.content, /fixture syntax error/u);
  const repeated = await definition.executor(request, new AbortController().signal);
  assert.equal(repeated.metadata.new_count, 0);
  assert.equal(repeated.metadata.unchanged_count, 1);
  assert.doesNotMatch(repeated.content, /fixture syntax error/u);
});

function fakeServerSource() {
  return String.raw`
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); parse(); });
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function parse() {
  while (true) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const header = buffer.subarray(0, end).toString('ascii');
    const match = /Content-Length: (\d+)/i.exec(header); if (!match) process.exit(2);
    const length = Number(match[1]); const start = end + 4; if (buffer.length < start + length) return;
    const message = JSON.parse(buffer.subarray(start, start + length)); buffer = buffer.subarray(start + length);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
    if (message.method === 'textDocument/didOpen') send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: message.params.textDocument.uri,
      diagnostics: [{ message: 'fixture syntax error', severity: 1, source: 'fixture', range: { start: { line: 0, character: 14 }, end: { line: 0, character: 15 } } }],
    } });
    if (message.method === 'shutdown') { send({ jsonrpc: '2.0', id: message.id, result: null }); process.exit(0); }
  }
}
`;
}
