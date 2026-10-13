// SPDX-License-Identifier: Apache-2.0
/**
 * QR rendering for the pairing dialog (doc 08 §5.8). The contents are exactly
 * the link string — no envelope, no extra data — and the PNG is transient
 * React state, never a file. Error level L is deliberate: pairing payloads
 * are dense (multiple candidates + the EC JWK), so resolution wins over error
 * correction.
 *
 * `qrcode`'s browser build renders through `document.createElement('canvas')`,
 * so the renderer arrives through an injected seam and the module stays
 * importable (and testable) in a node environment.
 */

/** §5.8 fixed rendering options; a caller that changes them is off-spec. */
export const QR_RENDER_OPTIONS = {
  width: 1024,
  margin: 2,
  errorCorrectionLevel: 'L',
} as const;

export type QrDataUrlRenderer = (
  text: string,
  options: { width: number; margin: number; errorCorrectionLevel: 'L' },
) => Promise<string>;

export interface QrError {
  reason: 'empty-link' | 'too-large' | 'render-failed';
  message: string;
}

export type QrOutcome = { ok: true; dataUrl: string } | { ok: false; error: QrError };

/**
 * QR byte capacity is finite and the payload is dense by design; the practical
 * ceiling for a v40-L symbol is ~2953 bytes, so an over-long link is refused
 * rather than rendered as an unscannable symbol.
 */
export const QR_MAX_LINK_BYTES = 2953;

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length;
  return text.length;
}

function qrFailure(reason: QrError['reason'], message: string): QrOutcome {
  return { ok: false, error: { reason, message } };
}

/**
 * Renders the link to a data URL. Never throws: a camera-hostile environment
 * (no canvas, blocked) answers with a reason so the dialog keeps showing the
 * copyable link, which §5.8 requires alongside the QR.
 */
export async function renderPairingQr(
  link: string,
  render: QrDataUrlRenderer | null,
): Promise<QrOutcome> {
  if (link.trim() === '') return qrFailure('empty-link', 'Nothing to render');
  const bytes = utf8ByteLength(link);
  if (bytes > QR_MAX_LINK_BYTES) {
    return qrFailure('too-large', `Connection link is ${bytes} bytes, above the QR limit`);
  }
  if (render === null) {
    return qrFailure('render-failed', 'QR rendering is unavailable in this environment');
  }
  try {
    const dataUrl = await render(link, QR_RENDER_OPTIONS);
    if (typeof dataUrl !== 'string' || dataUrl === '') {
      return qrFailure('render-failed', 'QR renderer returned nothing');
    }
    return { ok: true, dataUrl };
  } catch (error) {
    return qrFailure('render-failed', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Lazy browser binding for the real renderer. It is only resolved when the
 * dialog actually needs a picture, keeping the module (and every node test)
 * off the canvas path entirely.
 */
export async function browserQrRenderer(): Promise<QrDataUrlRenderer> {
  const module = await import('qrcode');
  const api = (module as { default?: { toDataURL?: unknown }; toDataURL?: unknown });
  const toDataURL = api.toDataURL ?? api.default?.toDataURL;
  if (typeof toDataURL !== 'function') {
    throw new Error('qrcode browser build exposes no toDataURL');
  }
  return (text, options) => (toDataURL as (
    value: string,
    opts: Record<string, unknown>,
  ) => Promise<string>)(text, {
    width: options.width,
    margin: options.margin,
    errorCorrectionLevel: options.errorCorrectionLevel,
  });
}
