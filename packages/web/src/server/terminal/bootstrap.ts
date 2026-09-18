// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal subsystem bootstrap (doc 07 section 2.2): the real PTY factory
 * (node-pty, ConPTY on Windows). Tests inject their own PtyFactory.
 */
import { createNodePtyFactory, type PtyFactory } from './pty-backend.ts';
import { TerminalRuntime } from './session-core.ts';

export function createTerminalRuntime(factory: PtyFactory = createNodePtyFactory()): TerminalRuntime {
  return new TerminalRuntime(factory);
}
