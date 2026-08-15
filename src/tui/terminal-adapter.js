// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { runtimeEnvironment } from '../environment-settings.js';
import { bindingBytes, DEFAULT_KEY_BINDINGS } from './key-bindings.js';

const ESC = '\u001b';
const MAX_INPUT_BYTES = 262_144;
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
export function terminalCapabilities(input, output, options = {}) {
  const tty = input.isTTY === true && output.isTTY === true;
  const environment = runtimeEnvironment(options.environment ?? process.env);
  const keyboardProtocol = resolveKeyboardProtocol(tty, options, options.environment ?? process.env);
  return Object.freeze({
    tty, color: tty && options.color !== false && !environment.noColor,
    unicode: options.unicode !== false, alternateScreen: tty && options.alternateScreen === true,
    mouse: tty && options.mouse !== false, hyperlinks: false,
    reducedMotion: options.reducedMotion === true || environment.reducedMotion,
    keyboardProtocol,
    width: output.columns ?? 80, height: output.rows ?? 24,
  });
}

function resolveKeyboardProtocol(tty, options, environment) {
  if (!tty || options.keyboardProtocol === false) return 'none';
  if (['kitty', 'xterm', 'none'].includes(options.keyboardProtocol)) return options.keyboardProtocol;
  // Windows Terminal 1.25+ implements the Kitty keyboard protocol. Older
  // versions safely ignore the negotiation sequence and retain the fallbacks.
  if (environment.WT_SESSION) return 'kitty';
  return 'none';
}

export class TerminalMode {
  #restored = false;
  #previousTitle = null;

  constructor(input, output, capabilities) {
    this.input = input;
    this.output = output;
    this.capabilities = capabilities;
  }

  enter() {
    if (!this.capabilities.tty) throw new ContractError('tty_required', 'interactive mode requires a terminal');
    if (process.platform === 'win32') {
      this.#previousTitle ??= process.title;
      process.title = 'NotNativeAgent';
    }
    this.input.setRawMode?.(true);
    this.#restored = false;
    this.input.resume();
    if (this.capabilities.alternateScreen) this.output.write(`${ESC}[?1049h`);
    const mouse = this.capabilities.mouse ? `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h` : '';
    this.output.write(`${keyboardProtocolEnter(this.capabilities.keyboardProtocol)}${ESC}[?25l${ESC}[?2004h${mouse}${ESC}[2J${ESC}[H`);
  }

  restore() {
    if (this.#restored) return;
    this.#restored = true;
    const mouse = this.capabilities.mouse ? `${ESC}[?1006l${ESC}[?1002l${ESC}[?1000l` : '';
    safeCall(() => this.output.write(`${ESC}[?2004l${mouse}${keyboardProtocolExit(this.capabilities.keyboardProtocol)}${ESC}[?25h`));
    if (this.capabilities.alternateScreen) safeCall(() => this.output.write(`${ESC}[?1049l`));
    else safeCall(() => this.output.write(`${ESC}[${this.capabilities.height};1H${ESC}[2K\n`));
    safeCall(() => this.input.setRawMode?.(false));
    safeCall(() => this.input.pause());
    if (process.platform === 'win32' && this.#previousTitle !== null) {
      safeCall(() => { process.title = this.#previousTitle; });
    }
  }
}

function keyboardProtocolEnter(protocol) {
  if (protocol === 'kitty') return `${ESC}[>1u`;
  if (protocol === 'xterm') return `${ESC}[>4;2m`;
  return '';
}

function keyboardProtocolExit(protocol) {
  if (protocol === 'kitty') return `${ESC}[<1u`;
  if (protocol === 'xterm') return `${ESC}[>4m`;
  return '';
}

function safeCall(operation) {
  try { operation(); } catch { /* terminal recovery is best-effort and must continue */ }
}

export class TerminalInputDecoder {
  #buffer = '';
  #paste = false;

  constructor(bindings = DEFAULT_KEY_BINDINGS) {
    this.setBindings({ ...DEFAULT_KEY_BINDINGS, ...bindings });
  }

  setBindings(bindings) {
    this.bindings = bindings;
  }

  push(chunk) {
    this.#buffer += Buffer.from(chunk).toString('utf8');
    if (Buffer.byteLength(this.#buffer) > MAX_INPUT_BYTES) {
      this.#buffer = ''; this.#paste = false;
      return [{ action: 'input_rejected', reason: 'paste_too_large' }];
    }
    const actions = [];
    while (this.#buffer.length > 0) {
      if (!this.#consumeOne(actions)) break;
    }
    return actions;
  }

  hasPendingEscape() {
    return !this.#paste && this.#buffer === ESC;
  }

  flushEscape() {
    if (!this.hasPendingEscape()) return [];
    this.#buffer = '';
    return [{ action: 'back' }];
  }

  #consumeOne(actions) {
    if (this.#paste) return this.#consumePaste(actions);
    if (this.#buffer.startsWith(PASTE_START)) {
      this.#buffer = this.#buffer.slice(PASTE_START.length); this.#paste = true; return true;
    }
    const mouse = mouseSequence(this.#buffer);
    if (mouse) {
      this.#buffer = this.#buffer.slice(mouse.bytes); actions.push(mouse.action); return true;
    }
    if (this.#buffer.startsWith(`${ESC}[<`) && !/[Mm]/u.test(this.#buffer)) return false;
    const enhancedKey = enhancedKeyboardSequence(this.#buffer, this.bindings);
    if (enhancedKey?.pending) return false;
    if (enhancedKey) {
      this.#buffer = this.#buffer.slice(enhancedKey.bytes);
      if (enhancedKey.action) {
        actions.push(enhancedKey.action === 'newline'
          ? { action: 'newline', text: '\n' }
          : { action: enhancedKey.action });
      }
      return true;
    }
    const sequence = keySequence(this.#buffer, this.bindings);
    if (sequence) {
      this.#buffer = this.#buffer.slice(sequence.bytes);
      actions.push(sequence.action === 'newline' ? { action: 'newline', text: '\n' } : { action: sequence.action });
      return true;
    }
    // In interactive terminals Enter is a carriage return. Submission must use
    // the conventional key even when an older configuration still names Ctrl+S.
    if (this.#buffer[0] === '\r') {
      this.#buffer = this.#buffer.slice(1); actions.push({ action: 'submit' }); return true;
    }
    // Ctrl+J is the explicit multiline action. Bracketed paste is handled above,
    // so pasted newlines continue to remain part of the editor without submitting.
    if (this.#buffer[0] === '\n') {
      this.#buffer = this.#buffer.slice(1); actions.push({ action: 'newline', text: '\n' }); return true;
    }
    if (this.#buffer[0] === '\u0016') {
      this.#buffer = this.#buffer.slice(1); actions.push({ action: 'paste_clipboard' }); return true;
    }
    if (this.#buffer[0] === ESC && this.#buffer.length < 3) return false;
    if (this.#buffer[0] === ESC) {
      this.#buffer = this.#buffer.slice(1); return true;
    }
    const point = [...this.#buffer][0];
    this.#buffer = this.#buffer.slice(point.length);
    actions.push({ action: 'insert', text: point });
    return true;
  }

  #consumePaste(actions) {
    const end = this.#buffer.indexOf(PASTE_END);
    if (end < 0) return false;
    actions.push({ action: 'paste', text: this.#buffer.slice(0, end) });
    this.#buffer = this.#buffer.slice(end + PASTE_END.length); this.#paste = false;
    return true;
  }
}

function enhancedKeyboardSequence(value, bindings) {
  const match = /^\u001b\[(\d+)(?::[\d:]*)?(?:;(\d+)(?::[\d:]*)?)?(?:;[\d:]*)?u/u.exec(value);
  if (!match) {
    // Raw terminal input may split one escape sequence across multiple data
    // events. Do not discard an incomplete CSI-u prefix before its final `u`.
    if (/^\u001b\[[\d:;]*$/u.test(value)) return { pending: true };
    return null;
  }
  const codepoint = Number(match[1]);
  const modifierBits = Math.max(0, Number(match[2] ?? 1) - 1);
  const shift = (modifierBits & 1) !== 0;
  const alt = (modifierBits & 2) !== 0;
  const ctrl = (modifierBits & 4) !== 0;
  let action = null;
  if (codepoint === 13) action = shift || alt ? 'newline' : 'submit';
  else if (codepoint === 27) action = 'back';
  else if (codepoint === 127) action = 'backspace';
  else if (codepoint === 9) {
    if (ctrl && shift) action = 'previous_tab';
    else if (ctrl) action = 'next_tab';
    else action = 'complete_command';
  } else if (ctrl && codepoint >= 65 && codepoint <= 122) {
    const letter = String.fromCodePoint(codepoint).toLowerCase().codePointAt(0);
    if (letter >= 97 && letter <= 122) {
      action = keySequence(String.fromCodePoint(letter - 96), bindings)?.action ?? null;
    }
  }
  return { bytes: match[0].length, action };
}

function mouseSequence(value) {
  const match = /^\u001b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/u.exec(value);
  if (!match) return null;
  const code = Number(match[1]);
  const wheel = (code & 64) !== 0;
  return {
    bytes: match[0].length,
    action: {
      action: 'mouse', button: code & 3, column: Number(match[2]), row: Number(match[3]),
      pressed: match[4] === 'M', shift: (code & 4) !== 0, alt: (code & 8) !== 0,
      ctrl: (code & 16) !== 0, motion: (code & 32) !== 0, wheel,
      wheelDirection: wheel ? (code & 1) === 0 ? 'up' : 'down' : null,
    },
  };
}

export function sanitizeTerminal(value) {
  return String(value).replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u009b]/gu, (character) => (
    character === ESC ? '␛' : `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  ));
}

function keySequence(value, bindings) {
  const controls = {
    [bindingBytes(bindings.submit)]: 'submit', [bindingBytes(bindings.cancel)]: 'cancel',
    [bindingBytes(bindings.help)]: 'help', [bindingBytes(bindings.allow_once)]: 'allow_once',
    [bindingBytes(bindings.deny)]: 'deny', [bindingBytes(bindings.reset_keys)]: 'reset_keys',
    [bindingBytes(bindings.newline)]: 'newline', [bindingBytes(bindings.undo)]: 'undo',
    [bindingBytes(bindings.toggle_activity)]: 'toggle_activity',
    [bindingBytes(bindings.new_tab)]: 'new_tab', [bindingBytes(bindings.close_tab)]: 'close_tab',
    [bindingBytes(bindings.previous_tab)]: 'previous_tab', [bindingBytes(bindings.next_tab)]: 'next_tab',
    [bindingBytes(bindings.cycle_review)]: 'cycle_review',
    [bindingBytes(bindings.scroll_page_up)]: 'scroll_page_up',
    [bindingBytes(bindings.scroll_page_down)]: 'scroll_page_down',
    [bindingBytes(bindings.scroll_bottom)]: 'scroll_bottom',
    '\u007f': 'backspace', [`${ESC}[3~`]: 'delete',
    [`${ESC}[D`]: 'left', [`${ESC}[C`]: 'right',
    [`${ESC}[1;2D`]: 'select_left', [`${ESC}[1;2C`]: 'select_right',
    [`${ESC}[1;5D`]: 'word_left', [`${ESC}[1;5C`]: 'word_right',
    [`${ESC}[1;6D`]: 'select_word_left', [`${ESC}[1;6C`]: 'select_word_right',
    [`${ESC}[1;2A`]: 'select_up', [`${ESC}[1;2B`]: 'select_down',
    [`${ESC}[H`]: 'home', [`${ESC}[F`]: 'end',
    [`${ESC}[1~`]: 'home', [`${ESC}[4~`]: 'end',
    [`${ESC}[1;5F`]: 'scroll_bottom',
    [`${ESC}\r`]: 'newline', [`${ESC}[13;2u`]: 'newline',
    [`${ESC}[13;2~`]: 'newline', [`${ESC}[27;2;13~`]: 'newline',
    [`${ESC}[9;5u`]: 'next_tab', [`${ESC}[9;6u`]: 'previous_tab',
    [`${ESC}[1;5I`]: 'next_tab', [`${ESC}[1;6Z`]: 'previous_tab',
    [`${ESC}1`]: 'tab_1', [`${ESC}2`]: 'tab_2', [`${ESC}3`]: 'tab_3',
    [`${ESC}4`]: 'tab_4', [`${ESC}5`]: 'tab_5', [`${ESC}6`]: 'tab_6',
    [`${ESC}7`]: 'tab_7', [`${ESC}8`]: 'tab_8',
    [`${ESC}[A`]: 'history_up', [`${ESC}[B`]: 'history_down', [`${ESC}[24~`]: 'reset_keys',
    '\t': 'complete_command',
  };
  for (const [bytes, action] of Object.entries(controls)) {
    if (value.startsWith(bytes)) return { bytes: bytes.length, action };
  }
  return null;
}
