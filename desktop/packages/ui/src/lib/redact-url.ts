// SPDX-License-Identifier: Apache-2.0
/**
 * §12.1/§6.5 display redaction for host URLs: userinfo stripped and
 * sensitive query keys masked before a URL is rendered by a client face.
 * Values (not keys) carry the secret; the segment labels stay readable.
 * Unparsable input is returned verbatim — a display helper never mangles
 * what it cannot parse (the caller renders an origin label, not a URL).
 */
const SENSITIVE_QUERY_KEYS = /^(?:t|.*(?:token|auth|secret|api).*)$/i;

export function redactSensitiveUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username !== '') parsed.username = '';
  if (parsed.password !== '') parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.test(key)) parsed.searchParams.set(key, '[REDACTED]');
  }
  return parsed.toString();
}
