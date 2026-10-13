// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef } from 'react';
import { useContextRouteStore, type ContextRouteRequest } from '../lib/workspace-route.ts';
import { getRuntimeKey } from '../lib/runtime-switch.ts';

export function useContextRoute(directory: string | undefined, session: string | null | undefined, apply: (request: ContextRouteRequest) => void): void {
  const request = useContextRouteStore((state) => state.request);
  const callback = useRef(apply);
  callback.current = apply;
  useEffect(() => {
    if (!request || request.runtime !== getRuntimeKey() || request.directory !== directory || request.session !== session) return;
    callback.current(request);
  }, [request, directory, session]);
}
