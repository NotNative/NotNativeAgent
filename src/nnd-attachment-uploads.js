// SPDX-License-Identifier: Apache-2.0
/** Short-lived, session-owned browser uploads. Bytes never enter the command journal. */
import { createHash } from 'node:crypto';
import { ContractError } from './ids.js';
import { validateAttachmentBytes } from './attachments.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain']);
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 16_000_000;
const MAX_ITEMS = 128;
const TTL_MS = 10 * 60 * 1000;
const invalid = () => new ContractError('nnd_attachment_upload_invalid', 'Native attachment upload is invalid');

export class NndAttachmentUploads {
  #items = new Map();
  #bytes = 0;
  constructor(now = () => Date.now()) { this.now = now; }

  upload(sessionId, subjectId, input, configuredMaxBytes) {
    this.#prune();
    if (!record(input) || !exact(input, ['upload_id', 'filename', 'mime_type', 'data_url'])
      || !ID.test(input.upload_id ?? '') || !validName(input.filename)
      || !MIME.has(input.mime_type) || typeof input.data_url !== 'string'
      || input.data_url.length > 1_400_000) throw invalid();
    const prefix = `data:${input.mime_type};base64,`;
    if (!input.data_url.startsWith(prefix)) throw invalid();
    const encoded = input.data_url.slice(prefix.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw invalid();
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || bytes.length > configuredMaxBytes
      || bytes.toString('base64') !== encoded) throw new ContractError('attachment_size_invalid', 'Native attachment exceeds its size bound');
    validateAttachmentBytes(bytes, input.mime_type);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${sessionId}\0${input.upload_id}`;
    const prior = this.#items.get(key);
    if (prior) {
      if (prior.subjectId !== subjectId || prior.sha256 !== sha256 || prior.filename !== input.filename
        || prior.mimeType !== input.mime_type) throw new ContractError('nnd_attachment_upload_conflict', 'Upload identity has changed');
      return receipt(prior);
    }
    if (this.#items.size >= MAX_ITEMS || this.#bytes + bytes.length > MAX_TOTAL_BYTES
      || [...this.#items.values()].filter(item => item.sessionId === sessionId).length >= 16) {
      throw new ContractError('nnd_attachment_upload_capacity', 'Native attachment upload capacity is full');
    }
    const item = { sessionId, subjectId, id: input.upload_id, filename: input.filename,
      mimeType: input.mime_type, bytes, sha256, expiresAt: this.now() + TTL_MS, usedBy: null };
    this.#items.set(key, item); this.#bytes += bytes.length;
    return receipt(item);
  }

  assertRefs(sessionId, subjectId, requestId, refs) {
    this.#prune();
    if (!Array.isArray(refs) || refs.length > 16) throw invalid();
    const ids = new Set();
    for (const ref of refs) {
      if (!record(ref) || !exact(ref, ['upload_id']) || !ID.test(ref.upload_id ?? '')
        || ids.has(ref.upload_id)) throw invalid();
      ids.add(ref.upload_id);
      const item = this.#items.get(`${sessionId}\0${ref.upload_id}`);
      if (!item || item.expiresAt <= this.now()) throw new ContractError('nnd_attachment_upload_expired', 'Upload is unavailable; attach the file again');
      if (item.subjectId !== subjectId || item.usedBy && item.usedBy !== requestId) {
        throw new ContractError('nnd_attachment_upload_scope_denied', 'Upload belongs to another submission');
      }
    }
    return refs.map(ref => {
      const item = this.#items.get(`${sessionId}\0${ref.upload_id}`);
      return { upload_id: item.id, mime_type: item.mimeType };
    });
  }

  resolve(sessionId, uploadId, mimeType) {
    const item = this.#items.get(`${sessionId}\0${uploadId}`);
    if (!item || item.mimeType !== mimeType) throw new ContractError('nnd_attachment_upload_expired', 'Upload is unavailable; attach the file again');
    return { bytes: Buffer.from(item.bytes), filename: item.filename };
  }

  markUsed(sessionId, requestId, attachments) {
    for (const ref of attachments ?? []) {
      const item = this.#items.get(`${sessionId}\0${ref.upload_id}`);
      if (item) item.usedBy = requestId;
    }
  }

  release(sessionId, requestId) {
    for (const [key, item] of this.#items) {
      if (item.sessionId === sessionId && item.usedBy === requestId) this.#drop(key, item);
    }
  }

  clearSession(sessionId) {
    for (const [key, item] of this.#items) if (item.sessionId === sessionId) this.#drop(key, item);
  }

  clear() { this.#items.clear(); this.#bytes = 0; }

  #prune() {
    for (const [key, item] of this.#items) if (!item.usedBy && item.expiresAt <= this.now()) this.#drop(key, item);
  }

  #drop(key, item) { this.#items.delete(key); this.#bytes -= item.bytes.length; }
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function validName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== '.' && value !== '..' && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
}
function receipt(item) {
  return Object.freeze({ upload_id: item.id, sha256: item.sha256, filename: item.filename,
    mime_type: item.mimeType, bytes: item.bytes.length, expires_at: new Date(item.expiresAt).toISOString() });
}
