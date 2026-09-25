// SPDX-License-Identifier: Apache-2.0
/**
 * NotNativeDesktop Electron main process (P12a installable shell v1).
 * Spec: docs/planning/09-electron-desktop-shell.md §1.2/1.3/2.1/2.2/4.1/4.5/
 * 6.1/11.1, governed by docs/build/NOTES/09 deltas D-09-1..12 (v1 subset).
 *
 * Hard invariant (NOTES/09 A.2): the server runs IN-PROCESS, never a sidecar.
 * The NOTNATIVE_* environment is fully set BEFORE the server bundle is
 * dynamically imported (the module reads env at import time).
 */
import { app, BrowserWindow, powerMonitor, shell } from 'electron';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInvokeFace } from './ipc-face.mjs';
import { createTrayController } from './tray.mjs';

const APP_NAME = 'NotNativeDesktop';
const APP_ID = 'dev.notnative.desktop';
const DEFAULT_PORT = 57123;
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_START_MS = 250;
const HEALTH_POLL_MAX_MS = 2_000;
const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PACKAGED = Boolean(app.isPackaged);
// --hidden start (row-bot parity): service boots to tray-only; the FIRST
// window reveal belongs to the user (tray Open App / ensureMainWindow).
const HIDDEN_START = process.argv.includes('--hidden');

let mainWindow = null;
let serverHandle = null;
let chosenPort = 0;
let trayController = null;
let quitting = false;
let bootFailure = null; // boot-abort message; trayed installs linger and must say why

// ── §1.2/1.3 module-load identity (before app.whenReady) ────────────────────

function installModeMarkerFile() {
  return path.join(path.dirname(directoryPathFromModuleUrl(import.meta.url)), 'install-mode.txt');
}

/** install.ps1 stamps this marker so a source install gets product identity
 * (its own userData + AppUserModelId) while the repo checkout stays 'Dev'. */
function isScriptedInstall() {
  try { return fs.readFileSync(installModeMarkerFile(), 'utf8').trim() === 'script'; } catch { return false; }
}

app.setName(APP_NAME);
const SCRIPTED = !PACKAGED && isScriptedInstall();
if (!PACKAGED && !SCRIPTED) app.setPath('userData', path.join(app.getPath('appData'), APP_NAME + ' Dev')); // D-09-6 split
app.setAppUserModelId(PACKAGED || SCRIPTED ? APP_ID : `${APP_ID}.dev`);
if (process.platform === 'linux' && typeof app.setDesktopName === 'function') app.setDesktopName('notnativedesktop.desktop');
try {
  // §1.3 #2: local requests never route through a system proxy.
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback');
} catch { /* commandLine unavailable — loopback default is still direct */ }

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
app.on('second-instance', () => focusMainWindow());

try { process.chdir(os.homedir()); } catch { /* best effort fallback cwd */ }

// ── hand-rolled logger (D-09-8: electron-log deferred) ──────────────────────

const LOG_DIR = path.join(app.getPath('userData'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'main.log');
const ORIGINAL_CONSOLE = {
  log: console.log.bind(console),
  debug: console.debug.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const CONSOLE_PASSTHROUGH = new Set(['warn', 'error']); // D-09-8: dev warn+; packaged console off

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* append will surface the failure */ }
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    for (const entry of fs.readdirSync(LOG_DIR)) {
      const full = path.join(LOG_DIR, entry);
      try {
        if (full !== LOG_FILE && fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
      } catch { /* leave it for the next boot */ }
    }
  } catch { /* unreadable log dir: nothing to prune */ }
}

function appendLog(level, args) {
  try {
    const text = args.map((item) => (typeof item === 'string' ? item : safeStringify(item))).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${text}\n`);
  } catch { /* never let the logger kill the shell */ }
}

function safeStringify(value) {
  try { return value instanceof Error ? `${value.stack ?? value.message}` : String(value); } catch { return '[unstringifiable]'; }
}

function installConsoleBridge() {
  // §1.3 #7 intent: the in-process server logs through plain console.*; the
  // bridge is what lands server diagnostics in main.log. SAFE variant: the
  // originals are kept and reused for the chosen policy.
  for (const level of ['log', 'debug', 'info', 'warn', 'error']) {
    console[level] = (...args) => {
      appendLog(level, args);
      if (!PACKAGED && CONSOLE_PASSTHROUGH.has(level)) ORIGINAL_CONSOLE[level](...args);
    };
  }
}

ensureLogDir();
pruneOldLogs();
installConsoleBridge();

// ── shell prefs (userData holds ONLY port seed + logs — D-09-6) ────────────

function prefsFile() {
  return path.join(app.getPath('userData'), 'nnd-shell-prefs.json');
}

function readStoredPort() {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    const value = Number(parsed?.port);
    return Number.isSafeInteger(value) && value > 0 && value < 65_536 ? value : 0;
  } catch { return 0; }
}

function writeStoredPort(port) {
  try {
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), `${JSON.stringify({ port }, null, 2)}\n`);
  } catch (error) { console.error('[shell] failed to store port:', error); }
}

// ── §2.1.3 port selection: stored → 57123 → ephemeral (test-bind BEFORE import) ─

function testBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1');
  });
}

function pickEphemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('listening', () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1');
  });
}

async function selectPort() {
  const stored = readStoredPort();
  const candidates = [stored, DEFAULT_PORT].filter((value, index, all) => (
    value > 0 && value < 65_536 && all.indexOf(value) === index
  ));
  for (const candidate of candidates) {
    if (await testBind(candidate)) return candidate;
    console.log(`[shell] port ${candidate} busy; trying next candidate`);
  }
  const ephemeral = await pickEphemeralPort();
  if (!ephemeral) throw new Error('no bindable loopback port');
  console.log(`[shell] all preferred ports busy; using ephemeral port ${ephemeral}`);
  return ephemeral;
}

// ── server env + bundle resolution (NOTES/09 A.2, §2.1.4) ──────────────────

function directoryPathFromModuleUrl(url) {
  let pathname = new URL(url).pathname;
  try { pathname = decodeURIComponent(pathname); } catch { /* raw pathname is still usable */ }
  if (process.platform === "win32" && /^\/[a-zA-Z]:/u.test(pathname)) pathname = pathname.slice(1);
  return pathname.replace(/[\\/]$/u, '');
}

function selfDir() {
  // directoryPathFromModuleUrl yields the module FILE path (its name is about
  // stripping the file:// form, not the basename); selfDir is its directory.
  // Without dirname, packaged resolveServerBundle looked inside "main.mjs\".
  return path.dirname(directoryPathFromModuleUrl(import.meta.url));
}

function resolveDistDir() {
  const loose = path.join(process.resourcesPath ?? '', 'web-dist');
  if (PACKAGED && fs.existsSync(loose)) return loose; // extraResources copy (doc 09 §14.1)
  if (PACKAGED) return path.join(app.getAppPath(), 'resources', 'web-dist'); // inside app.asar
  return path.resolve(selfDir(), '..', 'web', 'dist'); // unpackaged dev parity
}

function resolveServerBundle() {
  // Packaged: prefer the extraResources copy outside app.asar — ESM import()
  // of files inside asar depends on Electron's fs patch reaching the ESM
  // loader; a loose file is deterministic across Electron versions.
  if (PACKAGED) {
    const loose = path.join(process.resourcesPath ?? '', 'dist-server', 'server.mjs');
    if (fs.existsSync(loose)) return loose;
  }
  return path.join(selfDir(), 'dist-server', 'server.mjs');
}

function fileUrlFor(nativePath) {
  return new URL(`file:///${encodeURI(nativePath.replaceAll('\\', '/'))}`);
}

function applyServerEnv(port) {
  process.env.NOTNATIVE_HOST = '127.0.0.1'; // §2.1 v1: always loopback (D-09-7)
  process.env.NOTNATIVE_PORT = String(port);
  process.env.NOTNATIVE_DIST_DIR = resolveDistDir();
  process.env.NOTNATIVE_RUNTIME = 'desktop';
  // D-09-12: the server's version surface must agree with the installer's.
  process.env.NOTNATIVE_APP_VERSION = productVersion();
  // NOTNATIVE_DATA_DIR stays UNSET — the server default ~/.notnative-desktop
  // wins so packaged and `pnpm start` share state (D-09-6).
  if (!process.env.NO_PROXY) process.env.NO_PROXY = 'localhost,127.0.0.1';
  if (!process.env.no_proxy) process.env.no_proxy = 'localhost,127.0.0.1';
}

function localOrigin() {
  return `http://127.0.0.1:${chosenPort}`;
}

/** Product version surface for the scripted (unpackaged) install: electron's
 * app.getVersion() returns the BINARY version in dev mode — read the root
 * manifest instead so /health matches the installer identity (D-09-12). */
function productVersion() {
  if (PACKAGED) return app.getVersion();
  try {
    return JSON.parse(fs.readFileSync(path.join(selfDir(), '..', '..', 'package.json'), 'utf8')).version ?? app.getVersion();
  } catch { return app.getVersion(); }
}

// ── §2.2 health polling helper ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(origin, timeoutMs = HEALTH_TIMEOUT_MS, initialPollMs = HEALTH_POLL_START_MS, maxPollMs = HEALTH_POLL_MAX_MS) {
  const deadline = Date.now() + timeoutMs;
  let pollMs = initialPollMs;
  for (;;) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(Math.min(pollMs * 4, 1_500)) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
    pollMs = Math.min(pollMs * 2, maxPollMs);
  }
}

// ── §4.1 window v1 + §4.2 splash + D-09-2 init script ───────────────────────

const SPLASH_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<style>html,body{margin:0;height:100%;background:#0c0a09;color:#fafaf9;',
  'display:grid;place-items:center;font-family:system-ui,"segoe ui",sans-serif;',
  'color-scheme:dark}</style></head><body><div style="text-align:center">',
  '<div style="font-size:20px;font-weight:600">NotNativeDesktop</div>',
  '<div id="s" style="margin-top:10px;opacity:.55">starting local server</div>',
  '</div><script>let n=0;setInterval(()=>{n=(n+1)%4;',
  "document.getElementById('s').textContent='starting local server'+'.'.repeat(n)},450)</script>",
  '</body></html>',
].join('');
const SPLASH_URL = `data:text/html,${encodeURIComponent(SPLASH_HTML)}`;

// Boot-failure page (trayed stopped state): the splash spinner must not be the only surface when
// the server never came up — say why, name the escape hatches (tray Quit + reinstall + log path).
const FAILURE_PAGE_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<style>html,body{margin:0;height:100%;background:#0c0a09;color:#fafaf9;',
  'display:grid;place-items:center;font-family:system-ui,"segoe ui",sans-serif;',
  'color-scheme:dark;text-align:center}</style></head><body><div>',
  '<div style="font-size:16px;font-weight:600">NotNativeDesktop could not start</div>',
  '<div id="m" style="margin-top:10px;opacity:.55;max-width:560px;word-break:break-word;white-space:pre-line"></div>',
  '<div style="margin-top:16px;opacity:.75;font-size:13px">Quit from the tray menu, reinstall, and check the log file.</div>',
  '</div><script>document.getElementById("m").textContent=decodeURIComponent(location.hash.slice(1));</script>',
  '</body></html>',
].join('');

function bootFailurePageUrl(message) {
  // Details ride in as plain text (textContent), never injected HTML.
  const detail = [
    String(message ?? 'unknown startup failure'),
    `Log: ${LOG_FILE}`,
  ].filter((line) => line.length > 0).join('\n');
  return `data:text/html,${encodeURIComponent(FAILURE_PAGE_HTML)}#${encodeURIComponent(detail)}`;
}

function buildInitScript() {
  const j = (value) => JSON.stringify(value);
  // D-09-2: boot outcome is always {target:'local',status:'ok'} post-health.
  // Injected per document (dom-ready) so it survives every navigation.
  return [
    `window.__NOTNATIVE_ELECTRON__=${j({ runtime: 'electron', arch: process.arch, trayEnabled: false })};`,
    `window.__NOTNATIVE_SURFACE__=${j('desktop')};`,
    `window.__NOTNATIVE_PLATFORM__=${j(process.platform)};`,
    `window.__NOTNATIVE_HOME__=${j(os.homedir())};`,
    `window.__NOTNATIVE_DESKTOP_BOOT_OUTCOME__=${j({ target: 'local', status: 'ok' })};`,
    'void 0;',
  ].join('\n');
}

function openExternalSafely(urlString) {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(parsed.href).catch(() => { /* user OS without default browser */ });
    }
  } catch { /* not a URL: drop it */ }
}

function isAllowedNavigation(urlString) {
  if (urlString.startsWith('devtools:')) return true;
  if (urlString === SPLASH_URL || urlString.startsWith('data:text/html')) return true; // own splash only
  try { return new URL(urlString).origin === localOrigin(); } catch { return false; }
}

function attachWindowGuards(win) {
  const contents = win.webContents;
  const initScript = buildInitScript();
  contents.on('dom-ready', () => {
    try { contents.executeJavaScript({ code: initScript, injectImmediately: true }).catch(() => {}); }
    catch { contents.executeJavaScript(initScript).catch(() => {}); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url); // §4.5: never spawn a second Electron window in v1
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, urlString) => {
    if (isAllowedNavigation(urlString)) return;
    event.preventDefault();
    openExternalSafely(urlString); // https links in markdown etc. leave via the browser
  });
}

function createMainWindow() {
  const win = new BrowserWindow({
    title: APP_NAME,
    width: 1_280,
    height: 800,
    minWidth: 800,
    minHeight: 520,
    backgroundColor: '#0c0a09',
    show: false,
    webPreferences: {
      preload: path.join(selfDir(), 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // §1.1: preload needs the Node contextBridge (§11.2)
    },
  });
  attachWindowGuards(win);
  win.once('ready-to-show', () => { if (!HIDDEN_START || bootFailure) win.show(); });
  // Tray mode: the close button hides the window and the service keeps
  // running (reference launcher semantics); Quit belongs to the tray menu.
  win.on('close', (event) => {
    if (trayController?.active && !quitting && !win.webContents.isCrashed()) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadURL(bootFailure ? bootFailurePageUrl(bootFailure) : SPLASH_URL).catch(() => { /* splash/error is cosmetic */ });
  return win;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Tray "Open <App>": reuse the window or create one targeted at the UI. It
 * never re-invokes boot(): a failed boot keeps serving the failure page. */
function ensureMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    if (serverHandle) mainWindow.loadURL(localOrigin()).catch(() => { /* cosmetic */ });
  } else if (mainWindow.webContents.isCrashed()) {
    // A crashed renderer reborn blank: Open App must not just re-show the
    // corpse — reload the document (origin when running, failure page when not).
    mainWindow.webContents.reload();
  }
  if (!mainWindow.isVisible()) mainWindow.show(); // --hidden boots reveal here
  focusMainWindow();
}

/** Tray Quit: deliberate teardown (dispose → quit → hard watchdog). */
function quitFromTray() {
  if (quitting) return;
  quitting = true;
  console.log('[shell] quit requested from tray');
  try { trayController?.destroy(); } catch (error) { console.error('[shell] tray teardown failed:', error); }
  try { serverHandle?.dispose(); } catch (error) { console.error('[shell] server dispose failed:', error); }
  app.quit();
  setTimeout(() => app.exit(0), 8_000); // watchdog: never hang on a stuck handle
}

// ── §11.1 v1 + D-09-3: the invoke face lives in ipc-face.mjs (file cap) ─────

function appFileUrlPrefix() {
  return `file:///${encodeURI(app.getAppPath().replaceAll('\\', '/'))}`;
}

const invokeFace = createInvokeFace({
  origin: () => localOrigin(),
  appPathPrefix: () => appFileUrlPrefix(),
  bootInfo: () => ({ port: chosenPort, version: app.getVersion(), platform: process.platform, arch: process.arch }),
});

// ── §1.3 boot flow ──────────────────────────────────────────────────────────

async function startServerAndProbe() {
  const bundle = resolveServerBundle();
  if (!fs.existsSync(bundle)) {
    throw new Error(`server bundle missing at ${bundle} — run: pnpm --filter @notnative/electron package`);
  }
  console.log(`[shell] importing server bundle ${bundle}`);
  const module = await import(fileUrlFor(bundle));
  // The managed NNA mode waits for its child readiness line before it can
  // publish a server handle.  Await both the legacy synchronous shape and the
  // current Promise-returning server boot contract before probing /health.
  serverHandle = await module.startServer();
  console.log(`[shell] server handle bound to port ${serverHandle.port}`);
  return waitForHealth(localOrigin());
}

async function boot() {
  await app.whenReady();
  console.log(`[shell] app start version=${app.getVersion()} packaged=${PACKAGED} platform=${process.platform} arch=${process.arch} argv=${JSON.stringify(process.argv)}`);
  chosenPort = await selectPort();
  applyServerEnv(chosenPort);
  invokeFace.register();
  trayController = createTrayController({
    title: APP_NAME,
    assetsDir: path.join(selfDir(), 'assets'),
    origin: localOrigin(),
    ensureMainWindow,
    onQuit: quitFromTray,
  });
  if (trayController.create()) {
    console.log('[shell] tray icon active (open web / open desktop / quit)');
  } else {
    trayController = null;
    console.log('[shell] tray assets unavailable — running without tray icon');
  }
  trayController?.setStatus('starting');
  mainWindow = createMainWindow();
  powerMonitor.on('resume', () => {
    // D-09-11: sealed notnative: brand fan-out (renderer reconnects immediately)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('notnative:system-resume', { timestamp: Date.now() });
    }
  });
  const healthy = await startServerAndProbe();
  if (!healthy) throw new Error(`server health check failed on ${localOrigin()} after ${HEALTH_TIMEOUT_MS} ms`);
  writeStoredPort(chosenPort);
  trayController?.setStatus('running', localOrigin());
  console.log(`[shell] navigating main window to ${localOrigin()}/`);
  await mainWindow.webContents.loadURL(`${localOrigin()}/`);
}

app.on('window-all-closed', () => {
  // With a tray the service intentionally outlives closed/hidden windows;
  // without one (asset-less fallback) closing the only window is exit.
  if (trayController?.active) return;
  app.quit();
});
app.on('before-quit', () => {
  if (!serverHandle) return;
  try { serverHandle.dispose(); } catch (error) { console.error('[shell] server dispose failed:', error); }
});

boot().catch((error) => {
  console.error('[electron] startup failed:', error);
  // Reference launcher semantics: with a tray keep the process alive in the stopped state (user
  // can Quit from the menu; without a tray, exit). The trayed lingering must answer "then what?":
  // swap the splash spinner for the failure page so the user sees why and what to do next.
  if (trayController?.active) {
    trayController.setStatus('stopped');
    // Message only, never the stack: fixed card; the full trace is already in main.log.
    bootFailure = error instanceof Error ? error.message : String(error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.loadURL(bootFailurePageUrl(bootFailure)).catch(() => { /* cosmetic */ });
    }
    return;
  }
  app.exit(1);
});
