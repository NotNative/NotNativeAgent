// SPDX-License-Identifier: Apache-2.0
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError, requireExternalId } from '../ids.js';
import { userDataPaths } from '../product.js';
import { readJournalPrefix } from '../store.js';

export async function resumeWorkspaceConversation(workspace, sessionId) {
  requireExternalId(sessionId, 'session_id');
  if (workspace.sessions.has(sessionId)) {
    throw new ContractError('session_duplicate', 'conversation is already attached');
  }
  const config = workspace.activeConfig();
  if (config.persistence !== 'durable') {
    throw new ContractError('session_resume_unavailable', 'conversation resume requires durable persistence');
  }
  const root = workspace.options.storeRoot ?? userDataPaths().sessions;
  const path = join(root, `${sessionId}.journal.ndjson`);
  let info;
  try { info = await stat(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ContractError('session_missing', 'saved conversation was not found');
    throw error;
  }
  if (!info.isFile()) throw new ContractError('session_missing', 'saved conversation was not found');
  const created = (await readJournalPrefix(path, 1))[0]?.payload ?? {};
  if (created.executionManifest != null || created.mission != null) {
    throw new ContractError('session_host_required',
      'this conversation belongs to an authenticated host or mission and must be resumed there');
  }
  return workspace.create(`Resumed ${sessionId.slice(-12)}`, sessionId, { role: 'standard', config });
}
