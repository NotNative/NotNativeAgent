// SPDX-License-Identifier: Apache-2.0
/** Select the MCP surface from the currently authenticated harness engine. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { engineIdentityOf, isNnaEngine, type EngineIdentity } from '../../../lib/nnd/engine-identity.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsSection } from '../primitives.tsx';
import { NnaMcpInventory } from './mcp-inventory.tsx';
import { NativeMcpEditor } from './native-mcp-editor.tsx';
import { McpAdvancedPanel } from './mcp-advanced.tsx';
import { WorkspaceMcpConfig } from './mcp-legacy.tsx';

export function McpPage(): ReactNode {
  const { t } = useI18n();
  const globalEngineIsNna = isNnaEngine(useGlobalSyncStore(state => state.config));
  const [engine, setEngine] = useState<EngineIdentity | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const inspect = () => {
      const current = ++generation.current; setEngine(null);
      void harnessClient.getConfig().then(result => {
        if (current !== generation.current) return;
        const reported = engineIdentityOf(result.data ?? undefined);
        setEngine(result.error || !result.data ? null : reported);
      }, () => { if (current === generation.current) setEngine(null); });
    };
    inspect();
    const off = onRuntimeEndpointChanged(inspect);
    return () => { off(); generation.current += 1; };
  }, []);
  // Why: 'legacy' is a presentation label, not a wire value; the mock harness
  // ('mock') shows the legacy workspace surface exactly as before the typed
  // engine-identity helper replaced the ad-hoc probe.
  const mode = engine === 'nna' ? 'nna'
    : (engine === 'legacy' || engine === 'mock') && !globalEngineIsNna ? 'legacy' : 'unknown';
  return <SettingsSection item="mcp">
    {mode === 'legacy' ? <WorkspaceMcpConfig /> : mode === 'nna' ? <NativeMcpEditor />
      : <p role="status" className="mb-4 rounded border border-border/40 p-3 text-xs">{t('settings.mcp.engineUnknown')}</p>}
    <McpAdvancedPanel />
    <NnaMcpInventory />
  </SettingsSection>;
}
