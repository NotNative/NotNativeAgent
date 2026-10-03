// SPDX-License-Identifier: Apache-2.0
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { isNndLoopbackEndpoint } from './nnd-service-contract.js';

export const FRAME_LIMIT = 65_536;
const fail = () => { throw new Error('NND_SUPERVISED_PROTOCOL_INVALID'); };
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
async function canonicalRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value)) fail();
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) fail();
  return canonical;
}
function identity(prefix, path) {
  return prefix + createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
}
export async function validateBootstrap(value) {
  if (!exact(value, ['type','protocol','installation_id','data_id','generation','nna_install_root',
    'nna_data_root','nnd_data_root','ui_origin','engine','health_key']) || value.type !== 'bootstrap' || value.protocol !== '1.0'
    || typeof value.generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.generation)
    || !exact(value.engine, ['endpoint','token']) || !isNndLoopbackEndpoint(value.ui_origin)
    || !isNndLoopbackEndpoint(value.engine.endpoint) || typeof value.engine.token !== 'string'
    || !/^[A-Za-z0-9_-]{32,512}$/u.test(value.engine.token)
    || typeof value.health_key !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.health_key)
    || Buffer.from(value.health_key, 'base64url').toString('base64url') !== value.health_key) fail();
  const roots = await Promise.all([value.nna_install_root,value.nna_data_root,value.nnd_data_root].map(canonicalRoot));
  if (identity('nna_', roots[0]) !== value.installation_id || identity('data_', roots[1]) !== value.data_id) fail();
  return Object.freeze({ ...value, nna_install_root: roots[0], nna_data_root: roots[1], nnd_data_root: roots[2] });
}
export function validateControl(value, generation) {
  if (!exact(value, ['type','protocol','generation','request_id']) || value.protocol !== '1.0'
    || value.generation !== generation || !['stop','issue_ui_ticket'].includes(value.type)
    || typeof value.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.request_id)) fail();
  return value;
}

/** Bounded buffering even while the consumer is starting its listener. */
export function readPrivateFrames(input, onEnd) {
  let buffer = Buffer.alloc(0), ended = false, failure, waiter;
  const queue = [];
  const wake = () => { waiter?.(); waiter = undefined; };
  const finish = (error) => { if (ended) return; ended = true; failure = error; onEnd(); wake(); };
  const data = (chunk) => {
    if (ended) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > FRAME_LIMIT) { finish(new Error('NND_SUPERVISED_PROTOCOL_INVALID')); return; }
    let index;
    while ((index = buffer.indexOf(10)) !== -1) {
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, index));
        queue.push(JSON.parse(line));
        if (queue.length > 16) throw new Error();
      } catch { finish(new Error('NND_SUPERVISED_PROTOCOL_INVALID')); return; }
      buffer = buffer.subarray(index + 1);
    }
    wake();
  };
  const end = () => finish(buffer.length ? new Error('NND_SUPERVISED_PROTOCOL_INVALID') : undefined);
  const error = () => finish(new Error('NND_SUPERVISED_INPUT_FAILED'));
  input.on('data', data); input.once('end', end); input.once('error', error);
  return { async next() {
    while (!queue.length && !ended) await new Promise((resolve) => { waiter = resolve; });
    if (failure) throw failure;
    return queue.shift();
  }, cancel() { finish(new Error('NND_SUPERVISED_INPUT_CLOSED')); }, dispose() { input.off('data', data); input.off('end', end); input.off('error', error); input.pause(); } };
}
