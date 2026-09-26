// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { collectPageInspection, pageInspectionScript, parsePageInspection } from '../page-inspection.ts';

afterEach(() => { document.body.innerHTML = ''; });

describe('read-only page inspection', () => {
  it('uses a serialized selector without evaluating authored code or exposing input values', () => {
    const input = document.createElement('input');
    input.id = 'secret'; input.value = 'private-value'; input.setAttribute('aria-label', 'Password');
    document.body.append(input);
    const script = pageInspectionScript('#secret');
    const execute = new Function('document', 'location', 'getComputedStyle', 'HTMLElement', `return ${script}`);
    const value = execute(document, window.location, window.getComputedStyle.bind(window), HTMLElement);
    expect(value.label).toBe('Password');
    expect(JSON.stringify(value)).not.toContain('private-value');
    expect(parsePageInspection(value, '#secret')?.selector).toBe('#secret');
    expect(collectPageInspection('[')).toEqual({ error: 'The CSS selector is invalid.' });
    expect(collectPageInspection('#missing')).toEqual({ error: 'No element matches the CSS selector.' });
  });

  it('rejects malformed guest style and stale selectors', () => {
    document.body.innerHTML = '<button id="send">Send</button>';
    const value = collectPageInspection('#send');
    expect(parsePageInspection(value, '#other')).toBeNull();
    expect(parsePageInspection({ ...value, style: { display: 'block' } }, '#send')).toBeNull();
    expect(parsePageInspection({ ...value, bounds: { x: Infinity, y: 0, width: 1, height: 1 } }, '#send')).toBeNull();
  });

  it('does not expose initial textarea or editable draft text as a label', () => {
    document.body.innerHTML = '<textarea id="draft">private draft</textarea><div contenteditable="true" id="editor">another private draft</div>';
    expect(collectPageInspection('#draft')).toMatchObject({ label: '' });
    expect(collectPageInspection('#editor')).toMatchObject({ label: '' });
  });
});
