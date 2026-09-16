import './index.css';
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


const apiBaseUrl = window.__NOTNATIVE_API_BASE_URL__ || window.location.origin;

// doc 01 Â§4.2 order: surface stamp â†’ endpoint â†’ credentials â†’ bridge â†’ APIs.
const surface = resolveHostedSurface();
stampHostedSurface(surface);
configureRuntimeUrlResolver({ apiBaseUrl });
initializeRuntimeEndpoint({ apiBaseUrl });
initializeRuntimeCredentials();
installRuntimeFetchBridge();
registerRuntimeAPIs(createWebAPIs());
watchHostedSurfaceViewport(surface);

if (surface === 'mobile') {
  // Delta P0: mobile app tree (doc 11) is long-term deferred; renders desktop tree.
  console.warn('[notnative] mobile surface deferred â€” rendering desktop layout');
}

const rootElement = document.getElementById('root');
if (rootElement) {
  renderMainApp(rootElement);
}

