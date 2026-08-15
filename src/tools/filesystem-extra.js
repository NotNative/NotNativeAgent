// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { ContractError } from '../ids.js';

export function filesystemExtraDefinitions(paths, changes, receipts) {
  return [metadataDefinition(paths), directoryDefinition(paths), copyDefinition(paths, changes, receipts), moveDefinition(paths, changes, receipts)];
}

function metadataDefinition(paths) {
  return definition('fs.metadata', 'Inspect bounded metadata for one accessible file or directory.', 'read_only', {
    path: { type: 'string', maxLength: 4096, description: 'Required path to one existing file or directory.' },
  }, ['path'], async (args) => ({ args: shape(args, ['path']), resolved: await paths.resolveMetadata(args.path) }),
  async (request) => ({ content: JSON.stringify({ ...request.resolved, path: request.args.path }), metadata: { path: request.args.path } }));
}

function directoryDefinition(paths) {
  return definition('fs.create_directory', 'Create one new directory beneath an accessible existing directory.', 'reversible', {
    path: { type: 'string', maxLength: 4096, description: 'Required path for the new directory. Its parent must already exist.' },
  }, ['path'], async (args) => ({ args: shape(args, ['path']), resolved: await paths.resolveNew(args.path) }),
  async (request, signal) => {
    abort(signal); await assertAbsent(request.resolved.path); await mkdir(request.resolved.path);
    return { content: 'directory created', metadata: { path: request.args.path } };
  });
}

function copyDefinition(paths, changes, receipts) {
  return fileTransferDefinition(paths, 'fs.copy_file', 'Copy one exact accessible file to a new destination.', async (source, destination) => copyFile(source, destination), changes, receipts);
}

function moveDefinition(paths, changes, receipts) {
  return fileTransferDefinition(paths, 'fs.move_file', 'Move one exact accessible file to a new destination.', async (source, destination) => rename(source, destination), changes, receipts);
}

function fileTransferDefinition(paths, name, purpose, operation, changes, receipts) {
  return definition(name, purpose, 'reversible', {
    source: { type: 'string', maxLength: 4096, description: 'Required path to the existing source file.' },
    destination: { type: 'string', maxLength: 4096, description: 'Required new destination path; it must not already exist.' },
  }, ['source', 'destination'], async (args) => {
    const normalized = shape(args, ['source', 'destination']);
    const source = await paths.withRecovery(await paths.resolveRead(args.source));
    if (source.size > 16_777_216) throw new ContractError('tool_target_too_large', 'file transfer exceeds 16 MiB');
    const destination = await paths.resolveNew(args.destination);
    const receipt = receipts.latest(source.path, { full: true });
    return {
      args: { ...normalized, expected_sha256: receipt.digest },
      resolved: { source, destination, readReceiptId: receipt.id },
    };
  }, async (request, signal) => {
    abort(signal); await assertHash(request.resolved.source.path, request.args.expected_sha256);
    await assertAbsent(request.resolved.destination.path); abort(signal);
    const before = await readFile(request.resolved.source.path);
    await operation(request.resolved.source.path, request.resolved.destination.path);
    changes?.record(request.resolved.destination.path, null, before, name);
    if (name === 'fs.move_file') changes?.record(request.resolved.source.path, before, null, name);
    return { content: `${name === 'fs.move_file' ? 'move' : 'copy'} completed`, metadata: { source: request.args.source, destination: request.args.destination } };
  });
}

function definition(name, purpose, sideEffect, properties, required, validate, executor) {
  return {
    name, version: 1, purpose, sideEffect, scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }, validate, executor,
  };
}

function shape(args, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('tool arguments must be an object');
  const missing = required.find((key) => !Object.hasOwn(args, key));
  if (missing) throw invalid(`required argument "${missing}" is missing`);
  const unknown = Object.keys(args).find((key) => !required.includes(key));
  if (unknown) throw invalid(`unknown argument "${unknown}"`);
  const invalidType = required.find((key) => typeof args[key] !== 'string');
  if (invalidType) throw invalid(`argument "${invalidType}" must be a string`);
  return Object.fromEntries(required.map((key) => [key, args[key]]));
}

async function assertHash(path, expected) {
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== expected) throw new ContractError('tool_revalidation_drift', 'source changed after review');
}

async function assertAbsent(path) {
  try { await stat(path); throw new ContractError('tool_revalidation_drift', 'destination was created after review'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function abort(signal) { if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled'); }
function invalid(message = 'filesystem operation arguments do not match the schema') {
  return new ContractError('tool_schema_invalid', message);
}
