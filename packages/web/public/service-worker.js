// SPDX-License-Identifier: Apache-2.0
// This worker is an update coordinator only. API and application requests stay
// network-owned; a waiting update activates only after the user chooses Reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'NOTNATIVE_ACTIVATE_UPDATE') {
    void self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
