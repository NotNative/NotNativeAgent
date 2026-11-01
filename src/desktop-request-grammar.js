// SPDX-License-Identifier: Apache-2.0

// Native request identity grammars. Why: the desktop route, transaction, and
// activation surfaces validate the same operation identifiers; one definition
// keeps a bounded identifier from being accepted on one surface and refused on
// another. These are intentionally narrower than ids.js SAFE_ID (no dots or
// colons) because they name native operation records, not external ids.
export const DESKTOP_ID = /^[A-Za-z0-9_-]{1,128}$/u;
export const DESKTOP_OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
export const DESKTOP_REVISION = /^(?:absent|[a-f0-9]{64})$/u;
