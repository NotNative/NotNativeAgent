// SPDX-License-Identifier: Apache-2.0
import './helpers/env-boot.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV } from '../env.ts';
import { deriveRpContext } from '../lib/auth/rp-context.ts';

const prefs = join(ENV.dataDir, 'preferences.json'); const legacy = join(ENV.dataDir, 'settings.json');
afterEach(() => { for (const path of [prefs, legacy]) { try { unlinkSync(path); } catch { /* isolated file may be absent */ } } });
const request = () => deriveRpContext(new Headers({ host: 'localhost:3902' }), new URL('http://localhost:3902/auth/passkey'));
describe('passkey public origin', () => {
  it('reads canonical and legacy origins without changing the request-derived RP scope', () => {
    writeFileSync(legacy, JSON.stringify({ publicOrigin: 'https://public.example:8443' }));
    expect(request()).toEqual({ rpID: 'localhost', expectedOrigins: ['http://localhost:3902', 'https://public.example:8443'] });
    writeFileSync(prefs, JSON.stringify({ version: 1, fields: { publicOrigin: { value: 'https://new.example', updatedAt: '2026-10-01' } } }));
    expect(request().expectedOrigins).toEqual(['http://localhost:3902', 'https://new.example']);
  });
  it('deduplicates normalized origins and rejects malformed or insecure configured values', () => {
    const headers = new Headers({ host: 'localhost:3902' }); const url = new URL('http://localhost:3902/x');
    expect(deriveRpContext(headers, url, 'http://LOCALHOST:3902/').expectedOrigins).toEqual(['http://localhost:3902']);
    for (const value of [null, {}, 'https://x.example/path', 'http://public.example', 'https://user:secret@x.example',
      'https://x.example?query', 'https://x.example#fragment', 'https://x.example\n', 'not-a-url']) {
      expect(deriveRpContext(headers, url, value).expectedOrigins).toEqual(['http://localhost:3902']);
    }
  });
  it('does not treat an invalid canonical origin as permission to reuse a legacy origin', () => {
    writeFileSync(legacy, JSON.stringify({ publicOrigin: 'https://old.example' }));
    writeFileSync(prefs, JSON.stringify({ version: 1, fields: { publicOrigin: { value: 'https://bad.example/path' } } }));
    expect(request().expectedOrigins).toEqual(['http://localhost:3902']);
  });
});
