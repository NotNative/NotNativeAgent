// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageTypeScript, parsePageType, performPageType } from '../page-type.ts';

afterEach(() => { document.body.innerHTML = ''; Reflect.deleteProperty(document, 'elementFromPoint'); });

function field(): HTMLInputElement {
  const input = document.createElement('input'); input.id = 'query';
  input.scrollIntoView = vi.fn();
  input.getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 20 } as DOMRect);
  document.elementFromPoint = vi.fn().mockReturnValue(input);
  document.body.append(input);
  return input;
}

describe('exact-page guest typing', () => {
  it('requires exact URL and one visible ordinary field, then emits input/change without echoing text', () => {
    const input = field(); const inputEvent = vi.fn(); const changeEvent = vi.fn();
    input.addEventListener('input', inputEvent); input.addEventListener('change', changeEvent);
    expect(performPageType('#query', 'https://other.example/', 'hello')).toMatchObject({ error: expect.any(String) });
    expect(input.value).toBe('');
    const result = performPageType('#query', location.href, 'hello');
    expect(input.value).toBe('hello');
    expect(inputEvent).toHaveBeenCalledOnce(); expect(changeEvent).toHaveBeenCalledOnce();
    expect(result).toEqual({ selector: '#query', urlBefore: location.href, typed: true, settled: false });
    expect(JSON.stringify(result)).not.toContain('hello');
    expect(parsePageType(result, '#query', location.href)).toEqual(result);
  });

  it('rejects sensitive, disabled, duplicate, covered and non-field targets', () => {
    const input = field();
    input.type = 'password'; expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    input.type = 'text'; input.autocomplete = 'one-time-code';
    expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    input.autocomplete = 'off'; input.disabled = true;
    expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    input.disabled = false; input.readOnly = true;
    expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    input.readOnly = false; input.name = 'api-token';
    expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    input.name = ''; document.elementFromPoint = vi.fn().mockReturnValue(document.body);
    expect(performPageType('#query', location.href, 'x')).toHaveProperty('error');
    document.elementFromPoint = vi.fn().mockReturnValue(input);
    const other = document.createElement('input'); other.className = 'field'; input.className = 'field'; document.body.append(other);
    expect(performPageType('.field', location.href, 'x')).toHaveProperty('error');
    expect(performPageType('body', location.href, 'x')).toHaveProperty('error');
    expect(input.value).toBe('');
  });

  it('rechecks the field after scrolling can change it', () => {
    const input = field();
    input.scrollIntoView = () => { input.type = 'password'; };
    expect(performPageType('#query', location.href, 'secret')).toMatchObject({ error: expect.any(String) });
    expect(input.value).toBe('');
  });

  it('rejects an ordinary text input whose associated label identifies a secret', () => {
    const input = field(); input.id = 'field';
    const label = document.createElement('label'); label.htmlFor = 'field'; label.textContent = 'Password';
    document.body.append(label);
    expect(performPageType('#field', location.href, 'secret')).toHaveProperty('error');
    expect(input.value).toBe('');
    label.remove();
    const named = document.createElement('span'); named.id = 'field-caption'; named.textContent = 'API key';
    input.setAttribute('aria-labelledby', named.id); document.body.append(named);
    expect(performPageType('#field', location.href, 'secret')).toHaveProperty('error');
    expect(input.value).toBe('');
  });

  it('supports one visible textarea without submitting its form', () => {
    const form = document.createElement('form'); const area = document.createElement('textarea'); area.id = 'draft';
    area.scrollIntoView = vi.fn();
    area.getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 40 } as DOMRect);
    document.elementFromPoint = vi.fn().mockReturnValue(area);
    const submit = vi.fn(); form.addEventListener('submit', submit); form.append(area); document.body.append(form);
    expect(performPageType('#draft', location.href, 'draft')).toMatchObject({ typed: true });
    expect(area.value).toBe('draft'); expect(submit).not.toHaveBeenCalled();
  });

  it('serializes a self-contained script and rejects extra or leaked result fields', () => {
    const input = field();
    const execute = new Function(`return ${pageTypeScript('#query', location.href, 'quoted " text')}`) as () => unknown;
    const result = execute();
    expect(input.value).toBe('quoted " text');
    expect(parsePageType(result, '#query', location.href)).toEqual(result);
    expect(parsePageType({ ...result as object, text: input.value }, '#query', location.href)).toBeNull();
  });
});
