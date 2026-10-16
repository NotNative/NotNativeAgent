// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useAuthSessionStore } from '../../../lib/runtime-auth-expiry.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { authorityState, subscribeAuthority } from '../../../sync/authority-sync.ts';
import { OPERATIONAL_PAGES, type OperationalPage } from './operational-registry.ts';
import { nativeObservationScope } from './use-native-observation.ts';
import { NativeMcpEditor } from './native-mcp-editor.tsx';
import { NnaMcpInventory } from './mcp-inventory.tsx';
import { McpAdvancedPanel } from './mcp-advanced.tsx';
import { NativeSkillsPanel } from './native-skills.tsx';
import { HooksBundleSettings } from './hooks-bundles.tsx';
import { WebSearchSettings } from './web-search-settings.tsx';
import { WebFetchTrust } from './web-fetch-trust.tsx';
import { BrowserObservationPanel } from './browser-observation.tsx';
import { SearxngDeploymentPanel } from './searxng-deployment.tsx';
import { GatewayRuntimePanel } from './gateway-runtime.tsx';
import { NativeGatewayTimeout } from './native-gateway-timeout.tsx';
import { ServiceLifecycleControls } from './service-lifecycle.tsx';
import { NativeUpdateState } from './native-update-state.tsx';
import { UpdateActionsPanel } from './update-actions.tsx';
import { InstallationObservationPanel } from './installation-observation.tsx';
import { NativeEnvironment } from './native-environment.tsx';
import { DiagnosticSummary } from './operational-diagnostics.tsx';
import { ConversationData } from './operational-conversations.tsx';
import { FileSettings } from './operational-files.tsx';
import { SettingsTabs } from '../section-tabs.tsx';
import { TrustWorkspaces } from './trust-workspaces.tsx';
import { SecretActionsConsole } from './secret-console.tsx';
import { ManagedMcpCredentialsSettings } from './managed-mcp-credentials.tsx';
import { SecretsMetadataSettings } from './secrets-metadata.tsx';
import { LegacyCredentialsPanel } from './legacy-credentials.tsx';

const PANELS: Record<string, () => ReactNode> = {
  'operations-trust/workspaces': () => <TrustWorkspaces />,
  'operations-trust/secrets': () => <SecretActionsConsole />,
  'operations-trust/mcp': () => <ManagedMcpCredentialsSettings />,
  'operations-trust/diagnostics': () => <><SecretsMetadataSettings /><LegacyCredentialsPanel /></>,
  'operations-tools/servers': () => <NativeMcpEditor />,
  'operations-tools/inventory': () => <NnaMcpInventory />,
  'operations-tools/references': () => <McpAdvancedPanel />,
  'skills.installed/skills': () => <NativeSkillsPanel />,
  'skills.installed/hooks': () => <HooksBundleSettings />,
  'operations-search/search': () => <WebSearchSettings />,
  'operations-search/fetch': () => <WebFetchTrust />,
  'operations-search/browser': () => <BrowserObservationPanel />,
  'operations-search/deployment': () => <SearxngDeploymentPanel />,
  'operations-services/desktop': () => <><p className="text-xs">The NNA tray opens desktop or browser and restarts this runtime. Closing its window leaves the service running.
    Gateway and OpenCode are separate services. Restart interrupts running work; save drafts first.</p><InstallationObservationPanel /></>,
  'operations-services/gateway': () => <><GatewayRuntimePanel /><NativeGatewayTimeout /></>,
  'operations-services/compatibility': () => <ServiceLifecycleControls />,
  'operations-services/updates': () => <><NativeUpdateState /><UpdateActionsPanel /></>,
  'operations-data/summary': () => <DiagnosticSummary />,
  'operations-data/conversations': () => <ConversationData />,
  'operations-data/files': () => <FileSettings />,
  'operations-data/environment': () => <NativeEnvironment />,
};

/** Compatibility: legacy navigation retains its original search anchors. */
export function LegacyOperationalSections(): ReactNode {
  return <><NativeGatewayTimeout /><WebFetchTrust /><WebSearchSettings /><NativeEnvironment /><NativeUpdateState />
    <HooksBundleSettings /><UpdateActionsPanel /><InstallationObservationPanel /><BrowserObservationPanel /><NativeSkillsPanel />
    <GatewayRuntimePanel /><SearxngDeploymentPanel /><ServiceLifecycleControls /></>;
}

export function OperationalSettingsPage({ page, focusItem }: { page: OperationalPage; focusItem?: string | null }): ReactNode {
  const scope = useSyncExternalStore(onRuntimeEndpointChanged, nativeObservationScope);
  const auth = useAuthSessionStore(state => state.status);
  const authority = useSyncExternalStore(subscribeAuthority, authorityState);
  const definition = OPERATIONAL_PAGES[page];
  const [selected, setSelected] = useState<string>(definition.sections[0].id);
  useEffect(() => { const section = definition.sections.find(row => row.anchor === focusItem);
    if (section) setSelected(section.id); }, [focusItem, definition]);
  const section = definition.sections.find(row => row.id === selected) ?? definition.sections[0];
  const ready = auth === 'ok' && authority === 'ready';
  return <div className="space-y-4" data-testid={page}>
    <h2 className="text-lg font-semibold">{definition.title}</h2>
    <SettingsTabs label={`${definition.title} sections`} items={definition.sections} value={section.id} onChange={setSelected} />
    {!ready ? <p role="alert">{auth !== 'ok' ? 'Reconnect to NNA to use these controls.' : 'Native authority is resynchronizing. Controls are paused.'}</p>
      : <section key={`${scope}:${page}:${section.id}`} role="tabpanel" aria-label={section.title} data-settings-item={section.anchor}>
        {PANELS[`${page}/${section.id}`]?.()}
      </section>}
  </div>;
}
