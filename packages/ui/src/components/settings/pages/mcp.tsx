// SPDX-License-Identifier: Apache-2.0
/** Select the MCP surface from the currently authenticated harness engine. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { harnessClient } from '../../../lib/nnd/client.ts';
import { onRuntimeEndpointChanged } from '../../../lib/runtime-switch.ts';
import { useGlobalSyncStore } from '../../../sync/global-stores.ts';
import { useI18n } from '../../I18nProvider.tsx';
import { SettingsSection } from '../primitives.tsx';
import { NnaMcpInventory } from './mcp-inventory.tsx';
import { NativeMcpEditor } from './native-mcp-editor.tsx';
import { WorkspaceMcpConfig } from './mcp-legacy.tsx';

export function McpPage(): ReactNode {
  const { t } = useI18n();
  const globalEngine = (useGlobalSyncStore(state => state.config)?.nnd as { engine?: unknown } | undefined)?.engine;
  const [engine, setEngine] = useState<'nna' | 'legacy' | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    const inspect = () => {
      const current = ++generation.current; setEngine(null);
      void harnessClient.getConfig().then(result => {
        if (current !== generation.current) return;
        const reported = (result.data?.nnd as { engine?: unknown } | undefined)?.engine;
        setEngine(result.error || !result.data ? null : reported === 'nna' ? 'nna'
          : reported === 'mock' ? 'legacy' : null);
      }, () => { if (current === generation.current) setEngine(null); });
    };
    inspect();
    const off = onRuntimeEndpointChanged(inspect);
    return () => { off(); generation.current += 1; };
  }, []);
  const mode = engine === 'nna' ? 'nna' : engine === 'legacy' && globalEngine !== 'nna' ? 'legacy' : 'unknown';
  return <SettingsSection item="mcp">
    {mode === 'legacy' ? <WorkspaceMcpConfig /> : mode === 'nna' ? <NativeMcpEditor />
      : <p role="status" className="mb-4 rounded border border-border/40 p-3 text-xs">{t('settings.mcp.engineUnknown')}</p>}
    <NnaMcpInventory />
  </SettingsSection>;
}
