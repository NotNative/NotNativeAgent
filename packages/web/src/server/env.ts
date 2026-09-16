import os from 'node:os';
import path from 'node:path';

function truthy(v: string | undefined): boolean {
  return v === 'true' || v === '1';
}

/**
 * Server environment. The full env-var table is owned by doc 03 (phase P4);
 * this is the P0 subset. Harness-facing env names (NNA_*) are the coordination
 * seam with the NotNativeAgent repo — keep them centralized in this file.
 */
export const ENV = {
  /** API port; standalone default 3000 arrives with the CLI (doc 03). Dev launcher passes 3902. */
  port: Number(process.env.NOTNATIVE_PORT ?? process.env.PORT ?? 3902),
  host: process.env.NOTNATIVE_HOST ?? '127.0.0.1',
  version: '0.0.1',
  appName: 'NotNativeDesktop',
  dataDir: process.env.NOTNATIVE_DATA_DIR ?? path.join(os.homedir(), '.notnative-desktop'),
  /** Placeholder until doc 03's disk layout lands. */
  settingsFile: null as string | null,
  /** UI-level auth gate. Password auth is fully specified in doc 08 (P11). */
  uiPassword: process.env.NOTNATIVE_UI_PASSWORD ?? '',
  planModeExperimentalEnabled: truthy(
    process.env.NOTNATIVE_EXPERIMENTAL_PLAN_MODE ?? process.env.NOTNATIVE_EXPERIMENTAL,
  ),
  /** Harness selection: 'mock' until the NNA adapter is wired. */
  harness: (process.env.NOTNATIVE_HARNESS ?? 'mock') as 'mock' | 'nna',
} as const;
