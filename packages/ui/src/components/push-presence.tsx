// SPDX-License-Identifier: Apache-2.0
import { useEffect, useSyncExternalStore } from 'react';
import { getApiBaseUrlActive, getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';
import { tryGetRuntimeAPIs } from '../lib/api/registry.ts';
import { pushPresenceId, startPushPresence } from '../lib/push-presence.ts';
import { startSessionBadges } from '../lib/session-badges.ts';

function identity(): string { return `${getRuntimeKey()}\0${getApiBaseUrlActive()}`; }
export function usePushPresence(): void {
  const runtime = useSyncExternalStore(onRuntimeEndpointChanged, identity);
  useEffect(() => {
    const api = tryGetRuntimeAPIs()?.push;
    if (!api || typeof window === 'undefined' || !['http:', 'https:'].includes(window.location.protocol)) return;
    if (!window.crypto?.getRandomValues) return;
    const current = () => runtime === identity();
    const stopPresence = startPushPresence({ api, clientId: pushPresenceId(window.crypto), current, window, document });
    const stopBadges = startSessionBadges(api, current);
    return () => { stopBadges(); stopPresence(); };
  }, [runtime]);
}
