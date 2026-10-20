// SPDX-License-Identifier: Apache-2.0
import { deflateRawSync } from 'node:zlib';
import { ContractError } from './ids.js';

const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const MAX_ARCHIVE_INPUT = 16_777_216;
const MAX_STREAMED_ENTRY_INPUT = 67_108_864;
const MAX_STREAMED_ARCHIVE_INPUT = 536_870_912;
// Invariant: a full support export has two entries per session plus two root entries.
const MAX_ARCHIVE_ENTRIES = 2 * 1025 + 2;

export function createZip(entries, date = new Date()) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new ContractError('zip_entries_invalid', 'support archive entry count exceeds its bound');
  }
  let total = 0;
  const inputs = entries.map((entry) => {
    if (!entry || (typeof entry.content !== 'string' && !Buffer.isBuffer(entry.content))) {
      throw new ContractError('zip_entry_invalid', 'support archive content must be text or a buffer');
    }
    total += Buffer.byteLength(entry.content);
    if (total > MAX_ARCHIVE_INPUT) throw new ContractError('zip_input_too_large', 'support archive input exceeds bound');
    return entry;
  });
  const prepared = inputs.map((entry) => prepareEntry(entry, date));
  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of prepared) {
    const localRecord = localHeader(entry);
    local.push(localRecord, entry.compressed);
    central.push(centralHeader(entry, offset));
    offset += localRecord.length + entry.compressed.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([...local, directory, endRecord(prepared.length, directory.length, offset)]);
}

// Why: support bundles can contain many independently bounded sessions. Write
// each compressed entry before loading the next one instead of retaining all
// session evidence in a single in-memory archive buffer.
export function createZipWriter(handle, date = new Date()) {
  const central = [];
  let inputBytes = 0;
  let offset = 0;
  let finished = false;
  return Object.freeze({
    async append(entry) {
      if (finished || central.length >= MAX_ARCHIVE_ENTRIES) {
        throw new ContractError('zip_entries_invalid', 'support archive entry count exceeds its bound');
      }
      if (!entry || (typeof entry.content !== 'string' && !Buffer.isBuffer(entry.content))) {
        throw new ContractError('zip_entry_invalid', 'support archive content must be text or a buffer');
      }
      const bytes = Buffer.byteLength(entry.content);
      if (bytes > MAX_STREAMED_ENTRY_INPUT) throw new ContractError('zip_entry_too_large', 'support archive entry exceeds its bound');
      inputBytes += bytes;
      if (inputBytes > MAX_STREAMED_ARCHIVE_INPUT) throw new ContractError('zip_input_too_large', 'support archive input exceeds its bound');
      const prepared = prepareEntry(entry, date);
      const header = localHeader(prepared);
      central.push(centralHeader(prepared, offset));
      await writeFully(handle, header);
      await writeFully(handle, prepared.compressed);
      offset += header.length + prepared.compressed.length;
    },
    async finish() {
      if (finished || central.length === 0) throw new ContractError('zip_entries_invalid', 'support archive has no entries');
      finished = true;
      const directory = Buffer.concat(central);
      await writeFully(handle, directory);
      await writeFully(handle, endRecord(central.length, directory.length, offset));
      return offset + directory.length + 22;
    },
  });
}

async function writeFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > buffer.length - offset) {
      throw new ContractError('zip_write_incomplete', 'support archive write did not make progress');
    }
    offset += bytesWritten;
  }
}

function prepareEntry(entry, date) {
  if (!entry || typeof entry.name !== 'string' || !validEntryName(entry.name)) {
    throw new ContractError('zip_entry_invalid', 'support archive file name is invalid');
  }
  const name = Buffer.from(entry.name, 'utf8');
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
  const compressed = deflateRawSync(content, { level: 9 });
  const { time, day } = dosDate(date);
  return { name, content, compressed, crc: crc32(content), time, day };
}

function validEntryName(value) {
  if (value.length < 1 || value.length > 256 || value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => /^[A-Za-z0-9._-]{1,128}$/u.test(segment) && segment !== '.' && segment !== '..');
}

function localHeader(entry) {
  const header = Buffer.alloc(30 + entry.name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(DEFLATE, 8);
  writeEntryFields(header, entry, 10);
  header.writeUInt16LE(entry.name.length, 26);
  entry.name.copy(header, 30);
  return header;
}

function centralHeader(entry, offset) {
  const header = Buffer.alloc(46 + entry.name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(DEFLATE, 10);
  writeEntryFields(header, entry, 12);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(offset, 42);
  entry.name.copy(header, 46);
  return header;
}

function writeEntryFields(header, entry, offset) {
  header.writeUInt16LE(entry.time, offset);
  header.writeUInt16LE(entry.day, offset + 2);
  header.writeUInt32LE(entry.crc, offset + 4);
  header.writeUInt32LE(entry.compressed.length, offset + 8);
  header.writeUInt32LE(entry.content.length, offset + 12);
}

function endRecord(count, directorySize, directoryOffset) {
  const value = Buffer.alloc(22);
  value.writeUInt32LE(0x06054b50, 0);
  value.writeUInt16LE(count, 8);
  value.writeUInt16LE(count, 10);
  value.writeUInt32LE(directorySize, 12);
  value.writeUInt32LE(directoryOffset, 16);
  return value;
}

function dosDate(value) {
  const year = Math.max(1980, Math.min(2107, value.getFullYear()));
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function crc32(content) {
  let crc = 0xffffffff;
  for (const byte of content) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Object.freeze(Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
}));
