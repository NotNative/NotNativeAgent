// SPDX-License-Identifier: Apache-2.0

const ESC = '\u001b';
const SYNC_START = `${ESC}[?2026h`;
const SYNC_END = `${ESC}[?2026l`;

export class RetainedTerminalScreen {
  constructor(output) {
    this.output = output;
    this.lines = null;
  }

  invalidate() {
    this.lines = null;
  }

  paint(frame) {
    const next = frame.replace(/\n$/u, '').split('\n');
    const previous = this.lines ?? [];
    const changed = [];
    const count = Math.max(previous.length, next.length);
    for (let index = 0; index < count; index += 1) {
      if (this.lines === null || previous[index] !== next[index]) changed.push(index);
    }
    if (changed.length === 0) return false;
    let output = SYNC_START;
    for (const index of changed) {
      output += `${ESC}[${index + 1};1H${ESC}[2K${next[index] ?? ''}`;
    }
    output += SYNC_END;
    this.output.write(output);
    this.lines = next;
    return true;
  }
}

