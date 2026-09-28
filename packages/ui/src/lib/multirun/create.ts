// SPDX-License-Identifier: Apache-2.0
/** UI-owned multi-run creation orchestration (doc 12 §E.1/§E.3). */
import { buildMultiRunSessionTitle, buildWorktreeName, normalizeGroupSlug } from './title.ts';
import type { Session } from '../nnd/types.ts';

export interface MultiRunModelSelection { providerID: string; modelID: string; displayName?: string; variant?: string; }
export interface MultiRunFileAttachment { mime: string; filename: string; url: string; }
export interface MultiRunGroup { prompt: string; models: MultiRunModelSelection[]; }
export interface CreateMultiRunParams { name: string; groups: MultiRunGroup[]; agent?: string; worktreeBaseBranch?: string; isolateRuns?: boolean; files?: MultiRunFileAttachment[]; setupCommands?: string[]; }
export interface MultiRunWorktree { path: string; branch: string | null; }
export interface MultiRunCreatedRun { sessionID: string; session: Session; title: string; directory: string; model: MultiRunModelSelection; prompt: string; worktree: MultiRunWorktree | undefined; }
export type MultiRunDispatchOutcome = 'sent' | 'failed';
export interface MultiRunDispatchRequest { run: MultiRunCreatedRun; expandedPrompt: string; agent?: string; files: MultiRunFileAttachment[]; }
export interface MultiRunDispatchResult { outcome: MultiRunDispatchOutcome; error?: string; }
export interface CreateMultiRunResult { groupSlug: string; sessionIds: string[]; firstSessionId: string | null; }
export interface MultiRunServices {
  directory: () => string | undefined;
  isGitRepository: (directory: string) => Promise<boolean>;
  createWorktree: (input: { directory: string; worktreeName: string; branchName: string; startRef?: string; setupCommands?: string[] }) => Promise<MultiRunWorktree>;
  removeWorktree?: (input: { worktree: MultiRunWorktree }) => Promise<void>;
  waitForWorktreeSetup?: (worktreePath: string) => Promise<void>;
  createSession: (input: { directory: string; title: string }) => Promise<Session>;
  registerRun: (run: MultiRunCreatedRun) => void;
  expandPrompt: (text: string) => string;
  dispatchRun: (request: MultiRunDispatchRequest, setupCommands?: string[]) => Promise<void>;
  saveWorktreeSetupCommands?: (directory: string, commands: string[]) => Promise<void>;
}

interface PreparedLaunch { groupSlug: string; groups: MultiRunGroup[]; files: MultiRunFileAttachment[]; directory: string; commands: string[]; }
const MAX_MODELS_PER_GROUP = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function createMultiRun(params: CreateMultiRunParams, services: MultiRunServices): Promise<CreateMultiRunResult> {
  const launch = validateLaunch(params, services);
  const runs = await createRuns(params, launch, services);
  if (runs.length === 0) throw new Error('Failed to create any sessions');
  persistSetupCommands(launch, services);
  dispatchRuns(runs, params, launch, services);
  return { groupSlug: launch.groupSlug, sessionIds: runs.map((run) => run.sessionID), firstSessionId: runs[0]?.sessionID ?? null };
}

function validateLaunch(params: CreateMultiRunParams, services: MultiRunServices): PreparedLaunch {
  const groupSlug = normalizeGroupSlug(params.name);
  if (groupSlug.length === 0) throw new Error('Enter a valid multi-run name');
  const groups = params.groups ?? [];
  if (!Array.isArray(groups) || groups.length < 1) throw new Error('Create at least one model group');
  for (const group of groups) validateGroup(group);
  const files = params.files ?? [];
  for (const file of files) validateFile(file);
  const directory = services.directory();
  if (!directory) throw new Error('Select a project');
  const commands = [...new Set((params.setupCommands ?? []).filter((command) => command.trim().length > 0))];
  return { groupSlug, groups, files, directory, commands };
}

function validateGroup(group: unknown): void {
  const candidate = group as MultiRunGroup | undefined;
  if (!candidate || typeof candidate.prompt !== 'string' || candidate.prompt.trim().length === 0) {
    throw new Error('Each group needs a non-empty prompt');
  }
  if (!Array.isArray(candidate.models) || candidate.models.length < 1 || candidate.models.length > MAX_MODELS_PER_GROUP) {
    throw new Error('Each group needs between 1 and 5 models');
  }
}

async function createRuns(params: CreateMultiRunParams, launch: PreparedLaunch, services: MultiRunServices): Promise<MultiRunCreatedRun[]> {
  const shouldIsolate = await services.isGitRepository(launch.directory) && params.isolateRuns !== false;
  const multipleGroups = launch.groups.length > 1;
  const runs: MultiRunCreatedRun[] = [];
  for (const [groupIndex, group] of launch.groups.entries()) {
    const runGroup = multipleGroups ? `g${groupIndex + 1}` : undefined;
    const duplicates = new Map<string, number>();
    for (const model of group.models) {
      try {
        const modelKey = modelIdentity(model);
        const duplicateIndex = duplicates.get(modelKey);
        duplicates.set(modelKey, duplicateIndex === undefined ? 1 : duplicateIndex + 1);
        const index = duplicateIndex === undefined ? undefined : duplicateIndex + 1;
        runs.push(await createRun({ groupSlug: launch.groupSlug, runGroup, model, prompt: group.prompt, index }, params, { ...launch, shouldIsolate }, services));
      } catch (error) {
        console.warn?.(modelErrorLabel(groupIndex, model, error));
      }
    }
  }
  return runs;
}

async function createRun(run: { groupSlug: string; runGroup?: string; model: MultiRunModelSelection; prompt: string; index?: number; }, params: CreateMultiRunParams, launch: PreparedLaunch & { shouldIsolate: boolean; }, services: MultiRunServices): Promise<MultiRunCreatedRun> {
  const titleParts = { groupSlug: run.groupSlug, runGroup: run.runGroup, providerID: run.model.providerID, modelID: run.model.modelID, index: run.index };
  const title = buildMultiRunSessionTitle(titleParts);
  let worktree: MultiRunWorktree | undefined;
  try {
    let targetDirectory = launch.directory;
    if (launch.shouldIsolate) {
      const worktreeName = buildWorktreeName(titleParts);
      worktree = await services.createWorktree({
        directory: launch.directory,
        worktreeName,
        branchName: worktreeName,
        startRef: params.worktreeBaseBranch || 'HEAD',
        ...(launch.commands.length > 0 ? { setupCommands: launch.commands } : {}),
      });
      targetDirectory = worktree.path;
      if (services.waitForWorktreeSetup) await services.waitForWorktreeSetup(worktree.path);
    }
    const session = await services.createSession({ directory: targetDirectory, title });
    const created: MultiRunCreatedRun = {
      sessionID: session.id, session, title, directory: targetDirectory, model: run.model, prompt: run.prompt, worktree,
    };
    services.registerRun(created);
    return created;
  } catch (error) {
    if (worktree) await removeWorktreeQuietly(worktree, services);
    throw error;
  }
}

async function removeWorktreeQuietly(worktree: MultiRunWorktree, services: MultiRunServices): Promise<void> {
  if (services.removeWorktree === undefined) return;
  try {
    await services.removeWorktree({ worktree });
  } catch (error) {
    console.warn?.(`failed to roll back worktree ${worktree.path}: ${stringOfReason(error)}`);
  }
}

function persistSetupCommands(launch: PreparedLaunch, services: MultiRunServices): void {
  if (launch.commands.length === 0 || services.saveWorktreeSetupCommands === undefined) return;
  try {
    void Promise.resolve().then(() => services.saveWorktreeSetupCommands?.(launch.directory, launch.commands)).catch((error) => {
      console.warn?.('multi-run setup commands could not be saved', error);
    });
  } catch (error) {
    console.warn?.('multi-run setup commands could not be saved', error);
  }
}

function dispatchRuns(runs: MultiRunCreatedRun[], params: CreateMultiRunParams, launch: PreparedLaunch, services: MultiRunServices): void {
  const tasks = runs.map((run) => {
    try {
      return Promise.resolve(services.dispatchRun({
        run, expandedPrompt: services.expandPrompt(run.prompt), agent: params.agent, files: launch.files,
      }, launch.commands));
    } catch (error) {
      return Promise.reject(error);
    }
  });
  void Promise.allSettled(tasks).then((results) => {
    results.forEach((result, index) => {
      const run = runs[index];
      if (result.status === 'rejected' && run) console.warn?.(`${run.title}: ${stringOfReason(result.reason)}`);
    });
  });
}

function modelIdentity(model: MultiRunModelSelection): string {
  return `${model.providerID}\u0000${model.modelID}`;
}

function modelErrorLabel(groupIndex: number, model: MultiRunModelSelection, error: unknown): string {
  return `${model.providerID || 'unknown'}/${model.modelID || 'unknown'} (group g${groupIndex + 1}): ${stringOfReason(error)}`;
}

function stringOfReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateFile(file: MultiRunFileAttachment | undefined): void {
  if (!file || typeof file.mime !== 'string' || !file.mime || typeof file.filename !== 'string' || !file.filename
    || typeof file.url !== 'string' || !file.url) throw new Error('File attachments require a name and data URL');
  if (dataUrlBytes(file.url) > MAX_FILE_BYTES) throw new Error(`File attachment ${file.filename} exceeds 10 MB`);
}

function dataUrlBytes(url: string): number {
  const separator = url.indexOf(',');
  if (!url.startsWith('data:') || separator < 0) throw new Error('File attachments require a data URL');
  const payload = url.slice(separator + 1);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:=){2}|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
    throw new Error('File attachments require base64 data');
  }
  return Math.floor(payload.length * 3 / 4) - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
}
