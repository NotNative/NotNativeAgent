// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * PairingDialog has to follow the active catalog, while its existing English
 * component tests deliberately mount without the provider and exercise the
 * controller fallback.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PairingDialog } from '../PairingDialog.tsx';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { useI18nStore } from '../../../lib/i18n/store.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('PairingDialog i18n', () => {
  let root: Root | null = null;

  afterEach(async () => {
    if (root !== null) {
      await act(async () => root?.unmount());
      root = null;
    }
    await act(async () => {
      useI18nStore.getState().setLocale('en');
      await Promise.resolve();
    });
    window.localStorage.removeItem('notnative.i18n.v1');
  });

  it('renders localized disabled copy through the provider', async () => {
    await act(async () => {
      useI18nStore.getState().setLocale('de');
      await Promise.resolve();
    });
    const parent = document.createElement('div');
    document.body.append(parent);
    root = createRoot(parent);
    act(() => {
      root?.render(
        <I18nProvider>
          <PairingDialog open pairingAvailable={false} onClose={() => {}} />
        </I18nProvider>,
      );
    });
    const dialog = parent.querySelector('[data-testid="pairing-disabled"]');
    expect(dialog?.textContent).toBe('Pairing ist auf diesem Server deaktiviert. Aktivieren Sie es unter Einstellungen → Remote-Instanzen.');
  });
});
