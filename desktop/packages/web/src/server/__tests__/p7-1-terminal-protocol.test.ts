// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal protocol gates (doc 07 sections 3.1/3.4/4.5/4.6): frame codec
 * tag/version/cap/BAD_FRAME; sanitizer strips query exchanges (OSC 10/11,
 * DSR/CPR/DA replies, 2031) with cross-chunk carry while ordinary CSI and
 * DECSET survive; UTF-8-safe tail; theme answering pre-attach (Fish DA1,
 * OSC rgb replies, 2031 report/notify, 996/997).
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { decodeFrame, encodeFrame, TERMINAL_WS_MAX_PAYLOAD_BYTES } from '../terminal/protocol.ts';
import { createHistorySanitizer, isQueryExchange, utf8SafeTail } from '../terminal/history.ts';
import { createThemeQuestionAnswerer } from '../terminal/theme-response.ts';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

describe('frame codec (section 3.1)', () => {
  it('roundtrips tagged JSON frames', () => {
    const frame = encodeFrame({ v: 3, t: 'write', s: 'one', d: 'hi' });
    expect(frame[0]).toBe(0x01);
    const decoded = decodeFrame(frame);
    expect(decoded.ok).toBe(true);
    if (decoded.ok && decoded.frame.t === 'write') {
      expect(decoded.frame.s === 'one').toBe(true);
      expect(decoded.frame.d).toBe('hi');
    }
    const attach = decodeFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify({ v: 3, t: 'attach', s: 'tab-3' }), 'utf8')]));
    expect(attach.ok).toBe(true);
  });

  it('rejects text frames, wrong tag, wrong version, empty writes as BAD_FRAME', () => {
    expect(decodeFrame('hello').ok).toBe(false);
    expect(decodeFrame(Buffer.from([0x02])).ok).toBe(false);
    expect(decodeFrame(Buffer.from([0x01, ...Buffer.from('{}', 'utf8')])).ok).toBe(false); // no v
    expect(decodeFrame(Buffer.from(new TextEncoder().encode(JSON.stringify({ v: 2, t: 'ping' })))).ok).toBe(false);
    expect(decodeFrame(Buffer.from(new TextEncoder().encode(JSON.stringify({ v: 3, t: 'write', s: 'x', d: '' })))).ok).toBe(false);
  });

  it('bounds client session ids (1..128) and write payloads on the intake grammar', () => {
    const tagged = (payload: object): Buffer => Buffer.from([0x01, ...Buffer.from(JSON.stringify(payload), 'utf8')]);
    expect(decodeFrame(tagged({ v: 3, t: 'attach', s: '' })).ok).toBe(false); // no session id -> BAD_FRAME (section 3.3)
    expect(decodeFrame(tagged({ v: 3, t: 'detach', s: 'x'.repeat(129) })).ok).toBe(false); // ids are <= 128 (section 4.1)
    expect(decodeFrame(tagged({ v: 3, t: 'write', s: 'x'.repeat(128), d: 'a' })).ok).toBe(true);
    expect(decodeFrame(tagged({ v: 3, t: 'write', s: 'x', d: 'a'.repeat(65_536) })).ok).toBe(true); // cap is CHARS (section 3.3/12)
    expect(decodeFrame(tagged({ v: 3, t: 'write', s: 'x', d: 'a'.repeat(65_537) })).ok).toBe(false);
    expect(decodeFrame(tagged({ v: 3, t: 'write', s: 'x'.repeat(65_537), d: 'a' })).ok).toBe(false);
  });
});

describe('history sanitizer (section 3.4)', () => {
  it('strips OSC 10/11 bodies, DA/DSR/CPR/2031 while ordinary CSI and DECSET survive', () => {
    const raw = [
      `${ESC}]10;?${BEL}`,
      `${ESC}]11;rgb:ffff/ffff/ffff${ST}`,
      `${ESC}[?1;2c`, // DA1 reply
      `${ESC}[0n`, // DSR status report
      `${ESC}[5;6R`, // CPR
      `${ESC}[?2031$p`, // DECRQM request
      `${ESC}[?2031;1$y`, // DECRQM report
      `${ESC}[?2031h`, // 2031 set
      `${ESC}[31mkept${ESC}[0m`, // ordinary SGR
      `${ESC}[?1004h${ESC}[?2004h`, // DECSET survive
      'plain text',
    ].join('');
    const sanitizer = createHistorySanitizer();
    expect(sanitizer.push(raw)).toBe(`${ESC}[31mkept${ESC}[0m${ESC}[?1004h${ESC}[?2004hplain text`);
    expect(sanitizer.flush()).toBe('');
  });

  it('carries incomplete sequences across chunks without half-cuts or duplication', () => {
    const sanitizer = createHistorySanitizer();
    expect(sanitizer.push(`abc${ESC}]11;rgb:ff/00/ff`)).toBe('abc'); // OSC body cut mid-sequence
    expect(sanitizer.push(' tail')).toBe(''); // an unterminated OSC swallows until its terminator
    expect(sanitizer.push(`${ST}done`)).toBe('done'); // body still stripped; post-terminator text survives
    const split = createHistorySanitizer();
    expect(split.push(`x${ESC}[3`)).toBe('x'); // CSI cut between params and final byte
    expect(split.push('1m tail')).toBe(`${ESC}[31m tail`); // SGR completes (3+1m) and SURVIVES once
  });

  it('classifies query exchanges only', () => {
    expect(isQueryExchange('[5n')).toBe(true);
    expect(isQueryExchange('[?2031h')).toBe(true);
    expect(isQueryExchange('[?25h')).toBe(false);
    expect(isQueryExchange('[38;2;12;34;56m')).toBe(false);
  });

  it('abandons runaway unterminated sequences instead of carrying them forever (E-07-6)', () => {
    const sanitizer = createHistorySanitizer();
    expect(sanitizer.push(`${ESC}]11;${'x'.repeat(9_000)}`)).toBe(''); // unterminated body beyond the limit: abandoned with its chunk
    expect(sanitizer.push('recovered tail')).toBe('recovered tail'); // the next chunk starts fresh, nothing carried
    expect(sanitizer.flush()).toBe('');
    expect(sanitizer.push(`a${ESC}]10;${'y'.repeat(9_000)} lost`)).toBe('a'); // abandonment eats forward from the escape, never back
    const bounded = createHistorySanitizer();
    expect(bounded.push(`lead${ESC}P`)).toBe('lead'); // sub-limit partial still carries across chunks
    expect(bounded.push('second-chunk')).toBe('');
    expect(bounded.flush()).toBe(`${ESC}Psecond-chunk`); // flush returns the carried raw tail
  });

  it('history tail keeps whole UTF-8 characters (512 KiB rule)', () => {
    const face = 'é'.repeat(10); // two-byte char, never split mid-continuation
    const tail = utf8SafeTail(`${face}${face}${face}`, 26);
    expect(tail.length).toBe(13); // exact whole-character cut
    expect(tail.split('é').length - 1).toBe(13);
  });

  it('reports payload cap from the doc', () => {
    expect(TERMINAL_WS_MAX_PAYLOAD_BYTES).toBe(65_536);
  });
});

describe('theme answering (section 4.6, pre-attach)', () => {
  const answerer = createThemeQuestionAnswerer({
    themeMode: 'dark',
    terminalBackground: '#101010',
    terminalForeground: 'rgb(255, 255, 255)',
  });

  it('answers DA1 (Fish startup) and DSR, stripping the queries', () => {
    const scan = answerer.push(`${ESC}[c${ESC}[5n next`);
    expect(scan.replies).toBe(`${ESC}[?1;2c${ESC}[0n`);
    expect(scan.clean).toBe(' next');
  });

  it('answers OSC 11 with computed rgb from the stored background', () => {
    const scan = answerer.push(`${ESC}]11;?${ST}`);
    expect(scan.replies).toBe(`${ESC}]11;rgb:1010/1010/1010${ST}`);
    expect(scan.clean).toBe('');
  });

  it('tracks Mode 2031 and answers the report + 996/997 theme reports', () => {
    expect(answerer.push(`${ESC}[?2031h`).clean).toBe('');
    expect(answerer.push(`${ESC}[?2031$p`).replies).toBe(`${ESC}[?2031;1$y`);
    expect(answerer.push(`${ESC}[?996n`).replies).toBe(`${ESC}[?997;1n`);
    expect(answerer.mode2031()).toBe(true);
  });

  it('strips CPR without answering (the renderer owns it once attached)', () => {
    const scan = answerer.push(`${ESC}[4;10R tail`);
    expect(scan.replies).toBe('');
    expect(scan.clean).toBe(' tail');
  });

  it('falls back white/black (never garbage) when a queried color is not stored', () => {
    const bare = createThemeQuestionAnswerer({ themeMode: 'dark' });
    expect(bare.push(`${ESC}]10;?${ST}`).replies).toBe(`${ESC}]10;rgb:ffff/ffff/ffff${ST}`);
    expect(bare.push(`${ESC}]11;?${BEL}`).replies).toBe(`${ESC}]11;rgb:0000/0000/0000${ST}`); // replies always ST (doc 4.6)
    const garbage = createThemeQuestionAnswerer({ themeMode: 'light', terminalBackground: 'not-a-color', terminalForeground: 'also-not-a-color' });
    expect(garbage.push(`${ESC}]10;?${ST}`).replies).toBe(`${ESC}]10;rgb:ffff/ffff/ffff${ST}`); // parse failure -> white
    expect(garbage.push(`${ESC}]11;?${ST}`).replies).toBe(`${ESC}]11;rgb:ffff/ffff/ffff${ST}`);
    const valid = createThemeQuestionAnswerer({ themeMode: 'dark', terminalBackground: '#101010', terminalForeground: 'rgb(255, 255, 255)' });
    expect(valid.push(`${ESC}]11;?${ST}`).replies).toBe(`${ESC}]11;rgb:1010/1010/1010${ST}`); // stored colors win when present
    expect(garbage.push(`${ESC}[c`).replies).toBe(`${ESC}[?1;2c`);
  });

  it('abandons a runaway unterminated OSC body instead of buffering it forever (E-07-6)', () => {
    const scanner = createThemeQuestionAnswerer({ themeMode: 'dark', terminalBackground: '#101010' });
    const bomb = scanner.push(`${ESC}]11;?${'z'.repeat(9_000)}`);
    expect(bomb.replies).toBe(''); // no terminator: the query is never classified, never answered
    expect(scanner.push(`${ESC}[5n fresh`).replies).toBe(`${ESC}[0n`); // state recovered for the next chunk
    expect(scanner.push(`${ESC}[5n fresh`).clean).toBe(' fresh');
  });
});
