// SPDX-License-Identifier: Apache-2.0

const ESC = '\u001b';
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

export class RetainedTerminalScreen {
  constructor(output) {
    if (!output || typeof output.write !== 'function') {
      throw new TypeError('RetainedTerminalScreen requires a writable output');
    }
    this.output = output;
    this.lines = null;
  }

  invalidate() {
    this.lines = null;
  }

  paint(frame) {
    if (typeof frame !== 'string') throw new TypeError('terminal frame must be a string');
    const next = frame.replace(/\n$/u, '').split('\n');
    const previous = this.lines ?? [];
    const changed = [];
    const count = Math.max(previous.length, next.length);
    for (let index = 0; index < count; index += 1) {
      if (previous[index] !== next[index]) changed.push(index);
    }
    if (changed.length === 0) return false;
    const output = [SYNC_START];
    if (this.lines === null) output.push(`${ESC}[H${ESC}[J`);
    for (const index of changed) {
      output.push(`${ESC}[${index + 1};1H${ESC}[2K${next[index] ?? ''}`);
    }
    output.push(SYNC_END);
    this.output.write(output.join(''));
    this.lines = next;
    return true;
  }
}
