// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const REDUCED_MOTION_VARIABLE = 'NNA_REDUCED_MOTION';

export function runtimeEnvironment(environment = process.env) {
  return Object.freeze({
    reducedMotion: optionalBoolean(environment[REDUCED_MOTION_VARIABLE], REDUCED_MOTION_VARIABLE),
    // NO_COLOR is a presence-based cross-tool convention; even an empty value disables color.
    noColor: environment.NO_COLOR !== undefined,
  });
}

function optionalBoolean(value, name) {
  if (value === undefined || value === '') return false;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new ContractError('environment_boolean_invalid', `${name} must be 0 or 1`);
}
