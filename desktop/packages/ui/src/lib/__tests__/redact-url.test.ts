// SPDX-License-Identifier: Apache-2.0
/**
 * P8-8 invariants sweep (§12.1 row): redactSensitiveUrl is the
 * client-side display redaction contract (doc 08 §6.5 payload row +
 * §12.1 "never log or leak" row): userinfo stripped, and query keys
 * matching /^(t|.*(?:token|auth|secret|api).*)$/i → [REDACTED]. The
 * helper is display-only — it must never surface the raw sensitive
 * values back and must not invent output for unparsable input.
 */
import { describe, expect, it } from 'vitest';
import { redactSensitiveUrl } from '../redact-url.ts';

describe('redactSensitiveUrl (§12.1 display redaction)', () => {
  it('strips userinfo and masks the doc-exact query key families', () => {
    expect(redactSensitiveUrl('https://user:pw@host.example/path'))
      .toBe('https://host.example/path');
    expect(redactSensitiveUrl('https://h.example/connect?t=one-time-token'))
      .toBe('https://h.example/connect?t=%5BREDACTED%5D');
    expect(redactSensitiveUrl('https://h.example/x?token=a&api=b&secret=c&auth=d'))
      .toBe('https://h.example/x?token=%5BREDACTED%5D&api=%5BREDACTED%5D&secret=%5BREDACTED%5D&auth=%5BREDACTED%5D');
    expect(redactSensitiveUrl('https://h.example/x?clientToken=a&bearerAuth=b'))
      .toBe('https://h.example/x?clientToken=%5BREDACTED%5D&bearerAuth=%5BREDACTED%5D');
    expect(redactSensitiveUrl('https://u:p@h.example/y?apiServer=A&k=v'))
      .toBe('https://h.example/y?apiServer=%5BREDACTED%5D&k=v');
  });

  it('is case-insensitive on keys and never leaks redacted values', () => {
    const out = redactSensitiveUrl('https://h.example/p?SECRET=z&Token=w&T=x');
    expect(out).not.toContain('z');
    expect(out).not.toContain('w');
    expect(out).toContain('%5BREDACTED%5D');
  });

  it('leaves benign tenants readable and returns unparsable input verbatim', () => {
    expect(redactSensitiveUrl('https://h.example/p?q=keep&r1=v')).toBe('https://h.example/p?q=keep&r1=v');
    expect(redactSensitiveUrl('http://192.168.1.5:4090/')).toBe('http://192.168.1.5:4090/');
    expect(redactSensitiveUrl('not a url')).toBe('not a url');
    expect(redactSensitiveUrl('')).toBe('');
  });
});
