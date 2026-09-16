import type { RuntimeAPIs } from '@notnative/ui/lib/api/types.ts';

declare global {
  interface Window {
    /** Absolute base URL of the paired NotNativeDesktop server instance. */
    __NOTNATIVE_API_BASE_URL__?: string;
    /** Bearer credential issued for local pages. */
    __NOTNATIVE_CLIENT_TOKEN__?: string;
    /** Extra headers for every runtime request (never Authorization). */
    __NOTNATIVE_RUNTIME_HEADERS__?: Record<string, string>;
    /** Loopback origin of the local server (desktop shells). */
    __NOTNATIVE_LOCAL_ORIGIN__?: string;
    /** Saved desktop host id for relay restore (P11/P12). */
    __NOTNATIVE_RELAY_HOST_ID__?: string;
    /** Surface stamp, applied once at boot. */
    __NOTNATIVE_SURFACE__?: 'desktop' | 'mobile';
    /** Instance adapter injected by the entrypoint. */
    __NOTNATIVE_RUNTIME_APIS__?: RuntimeAPIs;
    /** Electron shell identity (P12). */
    __NOTNATIVE_ELECTRON__?: { runtime: 'electron'; arch: string; trayEnabled: boolean };
    __NOTNATIVE_PLATFORM__?: string;
    __NOTNATIVE_MACOS_MAJOR__?: number;
    __NOTNATIVE_HOME__?: string;
    __NOTNATIVE_DESKTOP_BOOT_OUTCOME__?: unknown;
    /** True once the app reached its ready gate (doc 01 §3.2). */
    __notnativeAppReady?: boolean;
    process?: { env: Record<string, string> };
  }
  const __APP_VERSION__: string;
}

export {};
