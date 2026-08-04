// SPDX-License-Identifier: Apache-2.0
import { deflateRawSync } from 'node:zlib';
import { ContractError } from './ids.js';

const UTF8_FLAG = 0x0800;
const DEFLATE = 8;
const MAX_ARCHIVE_INPUT = 16_777_216;

export function createZip(entries, date = new Date()) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32) {
    throw new ContractError('zip_entries_invalid', 'support archive requires one to thirty-two files');
  }
  const prepared = entries.map((entry) => prepareEntry(entry, date));
  const total = prepared.reduce((sum, entry) => sum + entry.content.length, 0);
  if (total > MAX_ARCHIVE_INPUT) throw new ContractError('zip_input_too_large', 'support archive input exceeds bound');
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

function prepareEntry(entry, date) {
  if (!entry || typeof entry.name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(entry.name)) {
    throw new ContractError('zip_entry_invalid', 'support archive file name is invalid');
  }
  const name = Buffer.from(entry.name, 'utf8');
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
  const compressed = deflateRawSync(content, { level: 9 });
  const { time, day } = dosDate(date);
  return { name, content, compressed, crc: crc32(content), time, day };
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
