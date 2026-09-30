// SPDX-License-Identifier: Apache-2.0
import { assertUpdaterCapability, compareVersions, resolveUpdaterChannel, resolveUpdaterFeed } from './updater-policy.mjs';

const NO_UPDATE_PATTERNS = /404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/iu;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function createDesktopUpdater({
  autoUpdater, packaged, platform, architecture, environment = process.env,
  testBuild = false, currentVersion, emitProgress = () => {}, setTaskbarProgress = () => {},
  fetchNotes = async () => null,
}) {
  let pendingUpdate = null;
  let configured = false;

  function capability() { assertUpdaterCapability({ platform, packaged, environment }); }

  function setup() {
    if (!packaged || configured || !autoUpdater) return false;
    configured = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.fullChangelog = true;
    autoUpdater.disableWebInstaller = false;
    const feed = resolveUpdaterFeed({ environment, testBuild });
    autoUpdater.setFeedURL(feed);
    const channel = resolveUpdaterChannel({ platform, architecture });
    if (channel) autoUpdater.channel = channel;
    autoUpdater.on('download-progress', (progress) => {
      const total = Number.isFinite(progress?.total) && progress.total > 0 ? progress.total : null;
      const downloaded = Number.isFinite(progress?.transferred) ? Math.max(0, progress.transferred) : 0;
      setTaskbarProgress(total ? Math.min(1, downloaded / total) : 0.01);
      emitProgress({ event: 'Progress', data: { chunkLength: Number.isFinite(progress?.bytesPerSecond) ? progress.bytesPerSecond : 0, downloaded, total } });
    });
    autoUpdater.on('update-downloaded', () => {
      setTaskbarProgress(-1);
      if (pendingUpdate) pendingUpdate.downloaded = true;
    });
    autoUpdater.on('error', () => setTaskbarProgress(-1));
    return true;
  }

  async function check() {
    capability();
    if (!packaged || !autoUpdater || !configured) throw new Error('Desktop updates are unavailable in this build');
    let result;
    try { result = await autoUpdater.checkForUpdates(); }
    catch (error) {
      if (NO_UPDATE_PATTERNS.test(errorText(error))) {
        pendingUpdate = null;
        return { available: false, currentVersion, version: null, body: null, date: null };
      }
      throw new Error(`Unable to check for updates: ${errorText(error)}. Check your network connection and try again.`, { cause: error });
    }
    const info = result?.updateInfo ?? null;
    const version = typeof info?.version === 'string' ? info.version : currentVersion;
    const available = compareVersions(version, currentVersion) > 0;
    pendingUpdate = available ? { version, electronUpdate: result, downloaded: false } : null;
    let body = typeof info?.releaseNotes === 'string' && info.releaseNotes.trim() ? info.releaseNotes : null;
    if (!body && available) {
      try { body = await fetchNotes(currentVersion, version); } catch { body = null; }
    }
    return { available, currentVersion, version: available ? version : null, body, date: info?.releaseDate ?? null };
  }

  async function download() {
    capability();
    if (!pendingUpdate) throw new Error('No pending update');
    if (!pendingUpdate.electronUpdate) throw new Error('Electron updater metadata is not available for this build');
    if (!pendingUpdate.downloaded) {
      emitProgress({ event: 'Started', data: { contentLength: null } });
      setTaskbarProgress(0.01);
      try {
        await autoUpdater.downloadUpdate();
        pendingUpdate.downloaded = true;
        emitProgress({ event: 'Finished', data: {} });
      } finally { setTaskbarProgress(-1); }
    }
    return null;
  }

  function getPending() { return pendingUpdate ? { version: pendingUpdate.version, downloaded: pendingUpdate.downloaded } : null; }
  function install() {
    if (!pendingUpdate?.downloaded) throw new Error('No downloaded update');
    autoUpdater.quitAndInstall();
  }

  return { setup, check, download, install, getPending, capability };
}
