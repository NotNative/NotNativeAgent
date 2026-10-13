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
    /** Bound runtime key stamped by the shell (mirror/storage namespaces). */
    __NOTNATIVE_RUNTIME_KEY__?: string;
    /** Main-process classification of the selected desktop boot target. */
    __NOTNATIVE_DESKTOP_BOOT_OUTCOME__?: Record<string, unknown>;
    /** Host-injected BCP-ish language tag (VS Code webviews, §H.2). */
    __NOTNATIVE_HOST_LANGUAGE__?: string;
    /** Instance adapter injected by the entrypoint. */
    __NOTNATIVE_RUNTIME_APIS__?: RuntimeAPIs;
    /** Electron shell identity (P12). */
    __NOTNATIVE_ELECTRON__?: { runtime: 'electron'; arch: string; trayEnabled: boolean };
    /** Narrow Electron invoke surface; absent on browser and mobile builds. */
    __NOTNATIVE_DESKTOP_INVOKE__?: (command: string, payload?: unknown) => Promise<{
      ok: boolean;
      result?: unknown;
      error?: string;
    }>;
    __NOTNATIVE_DESKTOP_UPDATER__?: {
      check(): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      download(): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      install(): Promise<{ ok: boolean; result?: unknown; error?: string }>;
      onProgress(handler: (detail: { event: string; data?: { downloaded?: number; total?: number | null } }) => void): () => void;
    };
    __NOTNATIVE_DESKTOP_EVENTS__?: {
      onOpenSession(handler: (detail: { sessionId: string; directory?: string }) => void): () => void;
      onRelayPairingRequest(handler: (detail: {
        requestId: string;
        payload: unknown;
        candidate: unknown;
        installId: string;
        platform: string;
        version: string;
      }) => void): () => void;
      onSshStatus?(handler: (detail: unknown) => void): () => void;
    };
    /** Main-frame-only, identity-bound Electron broker face; absent on web and guest pages. */
    __NOTNATIVE_BROWSER_CONTROL__?: {
      register(): Promise<{ ok: boolean; error?: string }>;
      unregister(): Promise<{ ok: boolean; error?: string }>;
      claim(requestId: string): Promise<{ ok: boolean; result?: { granted: boolean }; error?: string }>;
      result(requestId: string, result: { ok: true; data: unknown } | { ok: false; error: string }): Promise<{ ok: boolean; result?: { matched: boolean }; error?: string }>;
      onRequest(handler: (request: { requestId: string; action: string; parameters: Record<string, unknown> }) => void): () => void;
    };
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
