// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Pins NNA routing copy: raw refusals, stale results, drift, and confirmation validation. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { harnessClient } from '../../../lib/nnd/client.ts';
import { I18nProvider } from '../../../lib/i18n/context.tsx';
import { AgentsPage } from '../pages/agents.tsx';
import { ProviderRouteAction } from '../pages/provider-route-action.tsx';
import { ProviderRouteActivation } from '../pages/provider-route-activation.tsx';
import { SubagentRouteEditor } from '../pages/subagent-route-editor.tsx';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_INVENTORY = { version: 1, state: 'configured', route: { providerID: 'profile', modelID: 'model' },
  roles: [{ id: 'researcher', kind: 'built_in_subagent' }] };
const PROFILES = { profiles: [{ profile_id: 'profile-a', model: 'model-one' },
  { profile_id: 'profile-b', model: 'model-two' }], provider_routing_pending: false };

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

function settle(ms = 20): Promise<void> {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

function mount(node: Parameters<Root['render']>[0]): void {
  if (rootHandle !== null) { const previous = rootHandle; act(() => { previous.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => { rootHandle!.render(<I18nProvider>{node}</I18nProvider>); });
}

function click(testid: string): void {
  act(() => {
    document.querySelector(`[data-testid="${testid}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function setControl(selector: string, value: string): Promise<void> {
  const node = document.querySelector(selector) as HTMLInputElement;
  return act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (rootHandle !== null) { const closing = rootHandle; act(() => { closing.unmount(); }); rootHandle = null; }
  if (container !== null) { container.remove(); container = null; }
  vi.restoreAllMocks();
});

describe('NNA agents and provider routing', () => {
  it('rejects a blank route and duplicate inventory role ids', async () => {
    const inventory = vi.spyOn(harnessClient, 'getNnaAgentInventory')
      .mockResolvedValueOnce({ data: { ...AGENT_INVENTORY, route: { providerID: '', modelID: 'model' },
        roles: [AGENT_INVENTORY.roles[0], { ...AGENT_INVENTORY.roles[0], kind: undefined }] } } as never)
      .mockResolvedValue({ data: AGENT_INVENTORY } as never);
    mount(<AgentsPage />);
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned an invalid agent inventory.');
    click('agents-refresh');
    await act(async () => { await settle(); });
    expect(inventory.mock.calls.length).toBe(2);
    expect(document.querySelectorAll('[data-testid="nna-agent-role"]').length).toBe(1);
  });

  it('keeps the agent page alive after an invalid first inventory request', async () => {
    const inventory = vi.spyOn(harnessClient, 'getNnaAgentInventory')
      .mockResolvedValueOnce({ error: 'stale NNA diagnostic' } as never)
      .mockResolvedValue({ data: AGENT_INVENTORY } as never);
    mount(<AgentsPage />);
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('stale NNA diagnostic');
    click('agents-refresh');
    await act(async () => { await settle(); });
    expect(document.querySelectorAll('[data-testid="nna-agent-role"]').length).toBe(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(inventory.mock.calls.length).toBe(2);
  });

  it('preserves raw diagnostics on agent load and special-route confirmation refusal', async () => {
    const applied = vi.fn();
    vi.spyOn(harnessClient, 'getSubagentProviderRoute')
      .mockResolvedValueOnce({ data: { configured_route: { providerID: 'profile-a', modelID: 'model-one' } } } as never)
      .mockResolvedValue({ data: { configured_route: { providerID: 'profile-b', modelID: 'model-two' } } } as never);
    vi.spyOn(harnessClient, 'listProviderProfiles').mockResolvedValue({ data: PROFILES } as never);
    vi.spyOn(harnessClient, 'setSubagentProviderRoute').mockResolvedValue({ error: 'NNA refused route 507' } as never);
    mount(<SubagentRouteEditor runningRoute={{ providerID: 'profile-a', modelID: 'model-one' }} onApplied={applied} />);
    await act(async () => { await settle(); });
    expect(document.body.textContent).toContain('Running: profile-a/model-one');
    await setControl('[data-testid="subagent-model"]', 'changed model');
    click('subagent-save');
    await act(async () => { await settle(); });
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('NNA refused route 507');
    expect(applied).not.toHaveBeenCalled();
  });

  it('rejects duplicate provider profile ids', async () => {
    vi.spyOn(harnessClient, 'getSubagentProviderRoute')
      .mockResolvedValue({ data: { configured_route: { providerID: 'profile-a', modelID: 'model-one' } } } as never);
    vi.spyOn(harnessClient, 'listProviderProfiles')
      .mockResolvedValue({ data: { profiles: [PROFILES.profiles[0], PROFILES.profiles[0]],
        provider_routing_pending: false } } as never);
    mount(<SubagentRouteEditor runningRoute={{ providerID: 'profile-a', modelID: 'model-one' }} onApplied={vi.fn()} />);
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA returned invalid specialist routing.');
    expect(document.querySelector('[data-testid="subagent-provider"]')).toBeNull();
  });

  it('refreshes specialist routing only after an exact save confirmation', async () => {
    let configuredRoute = { providerID: 'profile-a', modelID: 'model-one' };
    let saveCalls = 0;
    vi.spyOn(harnessClient, 'getSubagentProviderRoute')
      .mockImplementation(async () => ({ data: { configured_route: configuredRoute } } as never));
    vi.spyOn(harnessClient, 'listProviderProfiles').mockResolvedValue({ data: PROFILES } as never);
    vi.spyOn(harnessClient, 'setSubagentProviderRoute')
      .mockImplementation(async (providerId: string, model: string): Promise<never> => {
        saveCalls += 1;
        if (providerId === 'profile-a' && model === 'model-two' && saveCalls > 1) {
          configuredRoute = { providerID: 'profile-a', modelID: 'model-two' };
          return { data: { configured_route: configuredRoute } } as never;
        }
        return { data: { configured_route: { providerID: providerId, modelID: 'wrong' } } } as never;
      });
    mount(<SubagentRouteEditor runningRoute={{ providerID: 'profile-b', modelID: 'model-one' }} onApplied={vi.fn()} />);
    await act(async () => { await settle(); });
    await setControl('[data-testid="subagent-model"]', 'model-two');
    click('subagent-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm the specialist route.');
    click('subagent-save');
    await act(async () => { await settle(); });
    expect(saveCalls).toBe(2);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect((document.querySelector('[data-testid="subagent-model"]') as HTMLInputElement).value).toBe('model-two');
  });

  it('applies a primary route only after an exact save confirmation', async () => {
    const applied = vi.fn();
    vi.spyOn(harnessClient, 'setPrimaryProviderRoute')
      .mockResolvedValueOnce({ data: { configured_primary_route: { providerID: 'profile', modelID: 'wrong' } } } as never)
      .mockResolvedValueOnce({ data: { configured_primary_route: { providerID: 'other', modelID: 'new model' } } } as never)
      .mockResolvedValueOnce({ data: { configured_primary_route: { providerID: 'profile', modelID: 'new model' } } } as never);
    mount(<ProviderRouteAction profileId="profile" defaultModel="old" configuredModel={null} onApplied={applied} />);
    await act(async () => { await settle(); });
    await setControl('[data-testid="primary-model"]', 'new model');
    click('primary-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm the route change.');
    expect(applied).not.toHaveBeenCalled();
    click('primary-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm the route change.');
    click('primary-save');
    await act(async () => { await settle(); });
    expect(applied).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('translates endpoint unavailability for both provider route controls', async () => {
    const activated = vi.fn();
    vi.spyOn(harnessClient, 'setPrimaryProviderRoute').mockRejectedValue(new Error('offline'));
    mount(<ProviderRouteAction profileId="profile" defaultModel="model" configuredModel={null} onApplied={activated} />);
    await act(async () => { await settle(); });
    await setControl('[data-testid="primary-model"]', 'new model');
    click('primary-save');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA route change is unavailable.');

    vi.spyOn(harnessClient, 'activatePrimaryProviderRoute').mockRejectedValue(new Error('offline'));
    mount(<ProviderRouteActivation onApplied={activated} />);
    await act(async () => { await settle(); });
    click('activate-provider-routing');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA route activation is unavailable.');
    expect(activated).not.toHaveBeenCalled();
  });

  it('refuses ambiguous activation and applies only a fully confirmed runtime route', async () => {
    const activated = vi.fn();
    vi.spyOn(harnessClient, 'activatePrimaryProviderRoute')
      .mockResolvedValueOnce({ data: { runtime_route: { providerID: 'p', modelID: '' }, existing_sessions_unchanged: true } } as never)
      .mockResolvedValueOnce({ data: { runtime_route: { providerID: 'p', modelID: 'm' }, existing_sessions_unchanged: false } } as never)
      .mockResolvedValue({ data: { runtime_route: { providerID: 'p', modelID: 'm' }, existing_sessions_unchanged: true } } as never);
    mount(<ProviderRouteActivation onApplied={activated} />);
    await act(async () => { await settle(); });
    click('activate-provider-routing');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm provider routing activation.');
    click('activate-provider-routing');
    await act(async () => { await settle(); });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('NNA did not confirm provider routing activation.');
    click('activate-provider-routing');
    await act(async () => { await settle(); });
    expect(activated).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});
