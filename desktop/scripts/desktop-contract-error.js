// SPDX-License-Identifier: Apache-2.0
/** Local adapter for the NNA activation contract's stable error shape. */
export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
    this.retryable = false;
  }
}
