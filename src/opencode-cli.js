// SPDX-License-Identifier: Apache-2.0
// OpenCode service control: the Console-facing entry for the lifecycle the
// `nna opencode` CLI and the wiring service drive.
//
// Why a wrapper and not a direct import: the architecture boundary forbids the
// experience layer from importing the opencode surface directly, the same rule
// `gateway-cli.js` satisfies for the Telegram gateway. This module is the
// control-side owner, so the Console's `/opencode` command delegates here.
import { runOpencodeCommand } from './opencode/cli-operation.js';

export function runOpencodeServiceCommand(args, paths, options = {}) {
  return runOpencodeCommand({ serveAction: args[0] ?? 'status' }, paths, options);
}
