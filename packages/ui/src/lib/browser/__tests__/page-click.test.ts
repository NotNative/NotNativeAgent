// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageClickScript, parsePageClick, performPageClick } from '../page-click.ts';

afterEach(() => { document.body.innerHTML = ''; Reflect.deleteProperty(document, 'elementFromPoint'); });

describe('exact-page guest click', () => {
  it('requires the observed URL and a visible, enabled target', () => {
    const button = document.createElement('button'); button.id = 'send';
    button.getBoundingClientRect = () => ({ x: 10, y: 10, width: 40, height: 20 } as DOMRect);
    button.scrollIntoView = vi.fn(); button.click = vi.fn();
    document.elementFromPoint = vi.fn().mockReturnValue(button);
    document.body.append(button);
    expect(performPageClick('#send', 'https://other.example/')).toMatchObject({ error: expect.stringContaining('page changed') });
    expect(button.click).not.toHaveBeenCalled();
    button.disabled = true;
    expect(performPageClick('#send', location.href)).toMatchObject({ error: expect.stringContaining('disabled') });
    button.disabled = false;
    const result = performPageClick('#send', location.href);
    expect(result).toEqual({ selector: '#send', urlBefore: location.href, activated: true, settled: false });
    expect(button.click).toHaveBeenCalledOnce();
    expect(parsePageClick(result, '#send', location.href)).toEqual(result);
  });

  it('serializes selector data safely and rejects malformed guest results', () => {
    const script = pageClickScript('#send', location.href);
    expect(script).toContain(JSON.stringify('#send'));
    expect(parsePageClick({ selector: '#send', urlBefore: location.href, activated: true, settled: true }, '#send', location.href)).toBeNull();
    expect(parsePageClick({ selector: '#send', urlBefore: 'https://other.example/', activated: true, settled: false }, '#send', location.href)).toBeNull();
  });

  it('runs as a self-contained guest script and refuses an overlay covering the target', () => {
    const button = document.createElement('button'); button.id = 'send';
    const overlay = document.createElement('div');
    button.scrollIntoView = vi.fn(); button.click = vi.fn();
    button.getBoundingClientRect = () => ({ x: 10, y: 10, width: 40, height: 20 } as DOMRect);
    document.body.append(button, overlay);
    const hit = vi.fn().mockReturnValue(overlay);
    document.elementFromPoint = hit;
    const execute = new Function(`return ${pageClickScript('#send', location.href)}`) as () => unknown;
    expect(execute()).toEqual({ error: 'The selected element is covered by another element.' });
    expect(button.click).not.toHaveBeenCalled();
    hit.mockReturnValue(button);
    expect(execute()).toMatchObject({ activated: true, settled: false });
    expect(button.click).toHaveBeenCalledOnce();
  });
});
