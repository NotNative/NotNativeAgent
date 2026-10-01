// SPDX-License-Identifier: Apache-2.0
/** General desktop control strings. */
const enDesktopGenerals = {
  'settings.launchAtLogin.title': 'Startup',
  'settings.launchAtLogin.label': 'Launch at login',
  'settings.launchAtLogin.helperStarts': 'Starts NotNativeDesktop in the tray.',
  'settings.launchAtLogin.helperUnsupported': 'This platform does not support launch at login.',
  'settings.launchAtLogin.error.read': 'Could not read the launch-at-login setting.',
  'settings.launchAtLogin.error.update': 'Could not update the launch-at-login setting.',
  'settings.desktopUpdate.title': 'Desktop updates',
  'settings.desktopUpdate.versionAvailable': 'Version {version} is available.',
  'settings.desktopUpdate.upToDate': 'NotNativeDesktop is up to date.',
  'settings.desktopUpdate.downloading': 'Downloading update…',
  'settings.desktopUpdate.progress': 'Downloading update: {percent}%',
  'settings.desktopUpdate.downloaded': 'Update downloaded.',
  'settings.desktopUpdate.install': 'Install and restart',
  'settings.desktopUpdate.download': 'Download update',
  'settings.desktopUpdate.check': 'Check for updates',
  'settings.desktopUpdate.working': 'Working…',
  'settings.desktopUpdate.checking': 'Checking…',
  'settings.desktopUpdate.error.generic': 'Desktop update operation failed.',
  'settings.desktopUpdate.error.invalid': 'The desktop updater returned an invalid response.',
};

export type PartialDictionary = typeof enDesktopGenerals;
export default enDesktopGenerals;
