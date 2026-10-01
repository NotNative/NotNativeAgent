// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, type Dispatch } from 'react';
import { browserQrRenderer, renderPairingQr } from '../../lib/pairing-qr.ts';
import { describePairingError } from './pairingText.ts';
import type { PairingLive } from './pairingLive.ts';
import type { PairingAction } from './pairingReducer.ts';

/**
 * The QR is rendered for exactly the link we offer as text, and only while it
 * can still be redeemed. A failed render clears the image rather than keeping
 * the previous code, which may already be spent.
 */
export function usePairingQr(live: PairingLive, dispatch: Dispatch<PairingAction>): void {
  const link = live.model.created?.link ?? '';
  const settled = live.model.closeReason !== null;
  const { renderQr } = live.props;
  const encodedRef = useRef('');
  useEffect(() => {
    if (link === '' || settled) return;
    // The link is unique per pairing, so this is "already encoded this code".
    if (encodedRef.current === link) return;
    encodedRef.current = link;
    const flow = live.flow;
    let cancelled = false;
    void (async () => {
      try {
        const renderer = renderQr === undefined ? await browserQrRenderer() : renderQr;
        const outcome = await renderPairingQr(link, renderer);
        if (cancelled || flow !== live.flow) return;
        dispatch(
          outcome.ok
            ? { type: 'qr', dataUrl: outcome.dataUrl, error: '' }
            : { type: 'qr', dataUrl: null, error: outcome.error.message },
        );
      } catch (caught) {
        if (cancelled || flow !== live.flow) return;
        dispatch({ type: 'qr', dataUrl: null, error: describePairingError(caught, live.text) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dispatch, link, live, renderQr, settled]);
}
