// SPDX-License-Identifier: Apache-2.0
import { SessionEngine } from './engine.js';
import { CanonicalIngress } from './ingress.js';
import { ContractError, newId } from './ids.js';
import { StructuredLog } from './structured-log.js';

const PROTOCOL_VERSION = '1.0';
const RECOVERABLE_OUTCOMES = new Set(['incomplete', 'needs_input', 'denied']);

export async function runPlainText(prompt, output, diagnostics, options) {
  validatePlainTextBoundary(output, diagnostics, options);
  let logger = null;
  let engine = null;
  let unregisterFatalCleanup = () => undefined;
  try {
    logger = await initializeLogger(options, diagnostics);
    const sessionId = options.sessionId ?? newId('session');
    engine = new SessionEngine({
      config: options.config, sessionId, surface: 'plain_text',
      storeRoot: options.storeRoot, providerFactory: options.providerFactory,
      reviewerRoot: options.reviewerRoot, semanticReviewer: options.semanticReviewer,
      output: async (record) => { logger?.record(record, { sessionId }); },
    });
    unregisterFatalCleanup = options.fatalBoundary?.registerCleanup(() => engine.shutdown({
      request_id: 'fatal_process_shutdown', type: 'shutdown',
    })) ?? unregisterFatalCleanup;
    await engine.initialize();
    const ingress = new CanonicalIngress(engine);
    const result = await ingress.submit({
      version: PROTOCOL_VERSION, type: 'submit', request_id: newId('text'), content: prompt,
    }, 'authenticated-stdio-host');
    if (result.text) output.write(`${result.text}\n`);
    return exitCode(result.outcome);
  } catch (error) {
    diagnostics.write(`nna text: ${error.code ?? 'internal_failure'}\n`);
    return 4;
  } finally {
    unregisterFatalCleanup();
    if (engine) {
      try { await engine.shutdown({ request_id: newId('text_shutdown'), type: 'shutdown' }); }
      catch (error) { writeDiagnostic(diagnostics, 'cleanup', error); }
    }
    if (logger) {
      try { await logger.flush(); }
      catch (error) { writeDiagnostic(diagnostics, 'log_flush', error); }
    }
  }
}

async function initializeLogger(options, diagnostics) {
  if (!options.logger && !options.logPath) return null;
  const logger = options.logger ?? new StructuredLog({ path: options.logPath });
  try { return await logger.initialize(); }
  catch {
    diagnostics.write('nna text: structured_log_unavailable\n');
    return null;
  }
}

function exitCode(outcome) {
  if (outcome === 'completed') return 0;
  if (RECOVERABLE_OUTCOMES.has(outcome)) return 3;
  if (outcome === 'cancelled') return 130;
  return 4;
}

function validatePlainTextBoundary(output, diagnostics, options) {
  if (!output || typeof output.write !== 'function'
    || !diagnostics || typeof diagnostics.write !== 'function'
    || !options || typeof options !== 'object') {
    throw new ContractError('plain_text_boundary_invalid', 'plain-text mode requires output, diagnostics, and options');
  }
}

function writeDiagnostic(diagnostics, stage, error) {
  diagnostics.write(`nna text ${stage}: ${error?.code ?? 'internal_failure'}\n`);
}
