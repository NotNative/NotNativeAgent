// SPDX-License-Identifier: Apache-2.0
/** Return one bounded public code without exposing nested error messages. */
export function cliErrorCode(error) {
  if (typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,127}$/u.test(error.code)) return error.code;
  if (error instanceof AggregateError && error.errors.length > 0) {
    const codes = error.errors.map(cliErrorCode);
    if (codes.every(code => code === codes[0])) return codes[0];
  }
  return 'internal_failure';
}
