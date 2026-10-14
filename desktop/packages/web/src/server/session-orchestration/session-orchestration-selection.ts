// SPDX-License-Identifier: Apache-2.0
/** P9-6b harness fixture loading, model/agent defaults, and explicit validation. */
import type { AgentInfo, CommandInfo, Provider } from '../../../../ui/src/lib/nnd/types.ts';
import type {
  OrchestratorDeps, OrchestratorSettings, RecordObject, ResolvedSelection,
  SelectionInput, SessionHarnessPorts, SessionOrchestrationResponse,
} from './session-orchestration-contract.ts';
import { asRecord, fail, textOf } from './session-orchestration-contract.ts';

export interface HarnessFixture {
  providers: readonly Provider[];
  agents: readonly AgentInfo[];
  config: RecordObject;
  commands: readonly CommandInfo[];
}

export function emptyHarnessFixture(): HarnessFixture {
  return { providers: [], agents: [], config: {}, commands: [] };
}

export async function loadHarness(deps: OrchestratorDeps, directory: string): Promise<HarnessFixture> {
  if (deps.waitForHarnessReady !== undefined) await deps.waitForHarnessReady(directory);
  const [providers, agents, config, commands] = await Promise.all([
    deps.harness.providers(directory),
    deps.harness.agents(directory),
    deps.harness.config(directory),
    deps.harness.commands(directory),
  ]);
  return { providers, agents, config: asRecord(config) ?? {}, commands };
}

function providerModelsFrom(providers: readonly Provider[]): Map<string, {
  provider: Provider; model: Provider['models'][string]; variants: string[];
}> {
  const resolved = new Map<string, { provider: Provider; model: Provider['models'][string]; variants: string[] }>();
  for (const provider of providers) {
    if (typeof provider?.id !== 'string') continue;
    for (const model of Object.values(provider.models ?? {})) {
      if (typeof model?.id !== 'string') continue;
      resolved.set(`${provider.id}/${model.id}`, { provider, model, variants: Object.keys(model.variants ?? {}) });
    }
  }
  return resolved;
}

function explicitModel(value: SelectionInput['model']): string | null {
  if (typeof value === 'string') return value.trim() || null;
  const record = asRecord(value);
  if (record === null) return null;
  const providerID = textOf(record.providerID).trim();
  const modelID = textOf(record.modelID).trim();
  return providerID === '' || modelID === '' ? null : `${providerID}/${modelID}`;
}

function primaryAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((agent) => typeof agent?.name === 'string' && agent.mode === 'primary' && agent.hidden !== true);
}

function modelSelectionOf(value: unknown): { providerID: string; modelID: string; variant?: string } | null {
  if (typeof value === 'string') {
    const [providerID, modelID] = value.split('/', 2);
    return !providerID || !modelID ? null : { providerID, modelID };
  }
  const record = asRecord(value);
  if (record === null) return null;
  const providerID = textOf(record.providerID).trim();
  const modelID = textOf(record.modelID).trim();
  if (providerID === '' || modelID === '') return null;
  const variant = textOf(record.variant).trim();
  return variant === '' ? { providerID, modelID } : { providerID, modelID, variant };
}

function agentModelOf(agents: readonly AgentInfo[], agent: string): string | null {
  const model = agents.find((entry) => entry.name === agent)?.model;
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : null;
}

function fallbackAgent(agents: readonly AgentInfo[]): AgentInfo {
  const primary = primaryAgents(agents);
  return primary.find((agent) => agent.name === 'build') ?? primary[0] ?? { name: 'build', mode: 'primary' };
}

function settingsFor(deps: OrchestratorDeps, directory: string): OrchestratorSettings {
  return deps.settingsFor === undefined ? {} : deps.settingsFor(directory);
}

export async function resolveSelection(
  deps: OrchestratorDeps, directory: string, request: SelectionInput,
  providers: readonly Provider[], agents: readonly AgentInfo[], config: RecordObject,
): Promise<ResolvedSelection | SessionOrchestrationResponse> {
  void deps;
  const modelMap = providerModelsFrom(providers);
  if (modelMap.size === 0) return fail(400, 'No model available');
  const validAgents = primaryAgents(agents).map((agent) => agent.name);
  const requestedModel = explicitModel(request.model);
  if (request.model !== undefined) {
    if (requestedModel === null) return fail(400, 'model must contain providerID and modelID');
    if (modelMap.size > 0 && !modelMap.has(requestedModel)) return fail(400, `Unknown model '${requestedModel}'`);
  }
  let agent = textOf(request.agent).trim();
  if (request.agent !== undefined) {
    if (agent === '') return fail(400, 'agent must be a non-empty string');
    if (!validAgents.includes(agent)) {
      const attached = agents.find((entry) => entry.name === agent);
      if (attached !== undefined) {
        return fail(400, `Agent '${agent}' is ${attached.mode ?? 'unavailable'} and cannot receive a prompt directly`);
      }
      return fail(400, `Unknown agent '${agent}'`);
    }
  }
  if (request.agent === undefined) {
    const configured = textOf(config.default_agent ?? config.defaultAgent).trim();
    for (const candidate of [
      settingsFor(deps, directory).defaultAgent ?? null,
      configured === '' ? null : configured,
      'build',
    ]) {
      if (candidate === null || candidate.trim() === '') continue;
      if (validAgents.length > 0 && validAgents.includes(candidate.trim())) { agent = candidate.trim(); break; }
    }
    if (agent === '') agent = validAgents[0] ?? '';
  }
  const settings = settingsFor(deps, directory);
  const candidates: Array<{ value: string | null; variant?: string }> = [
    // Why (uniformity #2/#11): the desktop-local defaults are candidate
    // preferences; NNA's configured model is the authoritative entry and the
    // inventory-validated chain below decides. No fabricated model literal:
    // the removed OpenChamber-era fallback named a model no NNA profile has.
    { value: settings.defaultModel ?? null, variant: settings.defaultVariant },
    { value: agentModelOf(agents, agent) },
    { value: textOf(config.model) === '' ? null : textOf(config.model) },
  ];
  let resolved: { providerID: string; modelID: string; variant?: string } | null = null;
  if (requestedModel !== null) resolved = modelSelectionOf(request.model);
  if (resolved === null) for (const candidate of candidates) {
    if (!candidate.value) continue;
    const value = modelSelectionOf(candidate.value);
    if (value === null) continue;
    if (candidate.variant !== undefined && candidate.variant !== '') value.variant = candidate.variant;
    if (modelMap.size > 0 && !modelMap.has(`${value.providerID}/${value.modelID}`)) continue;
    resolved = value;
    break;
  }
  if (resolved === null && modelMap.size > 0) {
    const entry = modelMap.values().next().value;
    if (entry !== undefined) resolved = { providerID: entry.provider.id, modelID: entry.model.id };
  }
  if (resolved === null) return fail(400, 'No model available');
  if (request.variant !== undefined) {
    const variant = textOf(request.variant).trim();
    if (variant === '') return fail(400, 'variant must be a non-empty string');
    resolved.variant = variant;
  }
  if (resolved.variant !== undefined && modelMap.size > 0) {
    const entry = modelMap.get(`${resolved.providerID}/${resolved.modelID}`);
    if (entry === undefined) return fail(400, `Unknown model '${resolved.providerID}/${resolved.modelID}'`);
    if (!entry.variants.includes(resolved.variant)) {
      return fail(400, `Unknown variant '${resolved.variant}' for model ${resolved.providerID}/${resolved.modelID}`);
    }
  }
  if (agent === '') return fail(400, 'No primary agent available');
  return { ...resolved, agent: agent === '' ? fallbackAgent(agents).name : agent };
}
