// SPDX-License-Identifier: Apache-2.0
﻿import './index.css';
import { registerRuntimeAPIs } from '@notnative/ui/lib/api/registry.ts';
import { installRuntimeFetchBridge } from '@notnative/ui/lib/runtime-fetch.ts';
import { initializeRuntimeCredentials } from '@notnative/ui/lib/runtime-auth.ts';
import { initializeRuntimeEndpoint } from '@notnative/ui/lib/runtime-switch.ts';
import { configureRuntimeUrlResolver } from '@notnative/ui/lib/runtime-url.ts';
import {
  resolveHostedSurface,
  stampHostedSurface,
  watchHostedSurfaceViewport,
} from '@notnative/ui/lib/runtimeSurface.ts';
import { renderMainApp } from '@notnative/ui/main';
import { createWebAPIs } from './api/createWebAPIs.ts';
import { registerPwaUpdateUX } from './pwa/update-ux.ts';
import { registerPwaInstallUX } from './pwa/install-ux.ts';
import { captureNativeBrowserLaunch } from '@notnative/ui/lib/native-browser-launch.ts';


captureNativeBrowserLaunch();
const surface = resolveHostedSurface();
stampHostedSurface(surface);

async function initializeDesktopRuntime(): Promise<void> {
  if (window.__NOTNATIVE_ELECTRON__?.runtime !== 'electron' || !window.__NOTNATIVE_DESKTOP_INVOKE__) return;
  try {
    const reply = await window.__NOTNATIVE_DESKTOP_INVOKE__('desktop_boot_config_get');
    const config = reply.ok && reply.result && typeof reply.result === 'object'
      ? reply.result as Record<string, unknown> : null;
    if (!config) return;
    const rawUrl = config?.apiBaseUrl;
    if (typeof rawUrl !== 'string' || rawUrl.length > 4_096) return;
    const target = new URL(rawUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return;
    window.__NOTNATIVE_API_BASE_URL__ = target.href.replace(/\/+$/u, '');
    window.__NOTNATIVE_CLIENT_TOKEN__ = typeof config.clientToken === 'string' ? config.clientToken : '';
    const rawHeaders = config.requestHeaders;
    const headers: Record<string, string> = {};
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [name, value] of Object.entries(rawHeaders)) {
        if (/^[a-z0-9-]{1,80}$/iu.test(name) && name.toLowerCase() !== 'authorization'
          && typeof value === 'string' && value.length <= 2_048 && !/[\u0000-\u001f\u007f]/u.test(value)) headers[name] = value;
      }
    }
    window.__NOTNATIVE_RUNTIME_HEADERS__ = headers;
    if (typeof config.runtimeKey === 'string' && config.runtimeKey.length <= 256
      && !/[\u0000-\u001f\u007f]/u.test(config.runtimeKey)) window.__NOTNATIVE_RUNTIME_KEY__ = config.runtimeKey;
    if (config.bootOutcome && typeof config.bootOutcome === 'object') {
      window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__ = config.bootOutcome as Window['__NOTNATIVE_DESKTOP_BOOT_OUTCOME__'];
    }
  } catch (error) {
    console.warn('[desktop] boot runtime config unavailable; keeping the local endpoint', error);
  }
}

async function startApplication(): Promise<void> {
  await initializeDesktopRuntime();
  const apiBaseUrl = window.__NOTNATIVE_API_BASE_URL__ || window.location.origin;
  // doc 01 §4.2 order: surface stamp → endpoint → credentials → bridge → APIs.
  configureRuntimeUrlResolver({ apiBaseUrl });
  initializeRuntimeEndpoint({ apiBaseUrl, runtimeKey: window.__NOTNATIVE_RUNTIME_KEY__ });
  initializeRuntimeCredentials();
  installRuntimeFetchBridge();
  registerRuntimeAPIs(createWebAPIs());
  watchHostedSurfaceViewport(surface);
  registerPwaInstallUX();

  if (surface === 'mobile') {
    // Delta P0: mobile app tree (doc 11) is long-term deferred; renders desktop tree.
    console.warn('[notnative] mobile surface deferred — rendering desktop layout');
  }

  const rootElement = document.getElementById('root');
  if (rootElement) {
    renderMainApp(rootElement);
    registerPwaUpdateUX();
  }
}

void startApplication();

