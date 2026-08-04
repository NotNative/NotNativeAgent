// SPDX-License-Identifier: Apache-2.0
import { SessionEngine } from './engine.js';
import { CanonicalIngress } from './ingress.js';
import { newId } from './ids.js';
import { StructuredLog } from './structured-log.js';

export async function runPlainText(prompt, output, diagnostics, options) {
  const logger = await initializeLogger(options, diagnostics);
  const sessionId = options.sessionId ?? newId('session');
  const engine = new SessionEngine({
    config: options.config, sessionId, surface: 'plain_text',
    storeRoot: options.storeRoot, providerFactory: options.providerFactory,
    reviewerRoot: options.reviewerRoot, semanticReviewer: options.semanticReviewer,
    output: async (record) => { logger?.record(record, { sessionId }); },
  });
  try {
    await engine.initialize();
    const ingress = new CanonicalIngress(engine);
    const result = await ingress.submit({
      version: '1.0', type: 'submit', request_id: newId('text'), content: prompt,
    }, 'authenticated-stdio-host');
    if (result.text) output.write(`${result.text}\n`);
    return exitCode(result.outcome);
  } catch (error) {
    diagnostics.write(`nna text: ${error.code ?? 'internal_failure'}\n`);
    return 4;
  } finally {
    if (engine.state.state !== 'shutting_down') {
      await engine.shutdown({ request_id: newId('text_shutdown'), type: 'shutdown' }).catch(() => undefined);
    }
    await logger?.flush().catch(() => undefined);
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
  if (['needs_input', 'denied'].includes(outcome)) return 3;
  if (outcome === 'cancelled') return 130;
  return 4;
}
