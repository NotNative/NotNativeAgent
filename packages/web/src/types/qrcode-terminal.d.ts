// SPDX-License-Identifier: Apache-2.0
/** Ambient types for `qrcode-terminal` (docs 08 S5.9 / doc 03 S10.1 CLI QR). */
declare module 'qrcode-terminal' {
  interface QrTerminalOptions {
    small?: boolean;
    [key: string]: unknown;
  }
  interface QrTerminalStatic {
    /** Throws synchronously on an unencodable input; delivers the code only. */
    generate(input: string, options: QrTerminalOptions, callback: (code: string) => void): void;
    generate(input: string, callback: (code: string) => void): void;
    setErrorLevel(level: 'verbose' | 'warn' | 'error'): void;
  }
  const qrcodeTerminal: QrTerminalStatic;
  export = qrcodeTerminal;
}
