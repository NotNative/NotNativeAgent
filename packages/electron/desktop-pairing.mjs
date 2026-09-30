// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_REDEEM_BYTES = 64 * 1024;

function routeUrl(base, suffix) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}${suffix}`;
  url.hash = '';
  return url.href;
}

async function boundedJson(response, maxBytes) {
  const sizeHeader = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(sizeHeader) && sizeHeader > maxBytes) throw new Error('response-too-large');
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('invalid-json-response');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('response-too-large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('invalid-json-response'); }
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(text) ? text : '';
}

function redactedPreview(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
  return url.href;
}

export function createDesktopPairingImporter({
  dialog, getWindow, fetch = globalThis.fetch, getHosts, setHosts, getInstallId,
  acquireHostConfigLock,
  platform = process.platform, version = '0.0.0', makeHostId = () => `host-${randomUUID()}`,
  now = () => Date.now(),
}) {
  if (!dialog?.showMessageBox || typeof fetch !== 'function' || typeof getHosts !== 'function'
    || typeof setHosts !== 'function' || typeof getInstallId !== 'function') {
    throw new TypeError('dialog, fetch, host storage, and install identity dependencies are required');
  }
  const inFlight = new Set();
  let importQueue = Promise.resolve();

  async function message(options) {
    const win = getWindow?.();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  }

  async function importPairing(payload) {
    // Pairing IDs identify the server-side one-time record. Expiry is an
    // untrusted payload field and must not let a duplicate link bypass the
    // in-flight guard by presenting a slightly different timestamp.
    const key = String(payload?.pairingId ?? '');
    if (inFlight.has(key)) return { status: 'already-processing' };
    inFlight.add(key);
    const operation = importQueue.then(() => performImport(payload));
    importQueue = operation.catch(() => undefined);
    try { return await operation; }
    finally { inFlight.delete(key); }
  }

  async function performImport(payload) {
    if (!payload || payload.v !== 2 || Date.parse(payload.expiresAt) <= now()) return { status: 'expired' };
    const directCandidates = payload.candidates.filter((candidate) => candidate.type === 'lan' || candidate.type === 'tunnel');
    if (directCandidates.length === 0) {
      await message({ type: 'info', title: 'Relay-only pairing is not available yet', message: 'This link has no direct LAN or tunnel address.', detail: 'Use a pairing link that includes a direct address. Relay-only import is still in development.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'relay-only' };
    }
    const current = getHosts();
    const candidateUrls = new Set(directCandidates.map((candidate) => candidate.url));
    const alreadySaved = current.hosts.some((host) => candidateUrls.has(host.url) || candidateUrls.has(host.apiUrl));
    if (!alreadySaved && current.hosts.length >= 100) {
      await message({ type: 'error', title: 'Host list is full', message: 'Remove a saved host before adding this server.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'catalog-full' };
    }
    const label = safeText(payload.label, 256) || 'this server';
    // Every candidate is a possible redemption destination: after a failed
    // health probe the secret is sent to the next candidate. Show the complete
    // bounded candidate set before consent so fallback cannot silently change
    // the server receiving the credential.
    const previews = directCandidates.map((candidate) => redactedPreview(candidate.url));
    const consent = await message({
      type: 'warning', title: 'Connect to remote server?',
      message: `Connect to ${label}${payload.fingerprint ? ` (${safeText(payload.fingerprint, 256)})` : ''}?`,
      detail: `This adds a saved remote instance and stores its client token on this device. The desktop will try these addresses in order and send the pairing secret to the first one that responds: ${previews.join(', ')}. Continue only if you trust these servers and started this connection yourself.`,
      buttons: ['Connect', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (consent?.response !== 0) return { status: 'cancelled' };
    if (Date.parse(payload.expiresAt) <= now()) return { status: 'expired' };

    // A direct address and relay descriptor in the same pairing payload refer
    // to one server identity. Verify that identity before sending the one-time
    // secret; a DNS/LAN endpoint that only fakes `{ok:true}` must not receive it.
    const expectedServerId = safeText(
      payload.candidates.find((candidate) => candidate.type === 'relay')?.serverId,
      256,
    );
    let candidateUrl = '';
    for (const candidate of directCandidates) {
      if (Date.parse(payload.expiresAt) <= now()) return { status: 'expired' };
      try {
        const response = await fetch(routeUrl(candidate.url, '/health'), {
          method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(3_500),
        });
        if (!response.ok) continue;
        const health = await boundedJson(response, MAX_HEALTH_BYTES);
        if (health?.ok === true && (!expectedServerId || health.serverId === expectedServerId)) {
          candidateUrl = candidate.url;
          break;
        }
      } catch { /* try the next explicitly supplied candidate */ }
    }
    if (!candidateUrl) {
      await message({ type: 'error', title: 'Could not reach server', message: 'None of the connection addresses answered a valid health check.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'unreachable' };
    }
    if (Date.parse(payload.expiresAt) <= now()) return { status: 'expired' };

    const releaseHostConfigLock = acquireHostConfigLock?.();
    if (acquireHostConfigLock && !releaseHostConfigLock) {
      await message({ type: 'error', title: 'Host list is busy', message: 'Wait for the current host update to finish, then try this pairing link again.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'catalog-busy' };
    }
    // Some paths release before showing a modal acknowledgment; the finally
    // block remains a safety net. Keep release one-shot so that a future lock
    // implementation with ownership tokens cannot release a newer owner's lock.
    let hostConfigLockReleased = false;
    const releaseLock = () => {
      if (hostConfigLockReleased) return;
      hostConfigLockReleased = true;
      releaseHostConfigLock?.();
    };
    try {
      const beforeRedeem = getHosts();
      const alreadySaved = beforeRedeem.hosts.some((host) => host.url === candidateUrl || host.apiUrl === candidateUrl);
      if (!alreadySaved && beforeRedeem.hosts.length >= 100) {
        releaseLock();
        await message({ type: 'error', title: 'Host list is full', message: 'Remove a saved host before adding this server.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
        return { status: 'catalog-full' };
      }

      let installId;
      try { installId = getInstallId(); }
      catch {
        releaseLock();
        await message({ type: 'error', title: 'Pairing failed', message: 'The desktop could not read its installation identity.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
        return { status: 'identity-error' };
    }
    let response;
    let body;
    try {
      response = await fetch(routeUrl(candidateUrl, '/api/client-auth/pairing/redeem'), {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
        // Pairing secrets must never follow a server-controlled redirect to a
        // different origin, even after the user approved the advertised URL.
        redirect: 'error',
        body: JSON.stringify({
          pairingId: payload.pairingId, secret: payload.secret,
          clientLabel: 'NotNativeDesktop', clientKind: 'desktop', deviceName: 'NotNativeDesktop',
          devicePlatform: platform, appVersion: version, dedupeKey: `desktop:${installId}`,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      body = await boundedJson(response, MAX_REDEEM_BYTES);
      } catch {
        releaseLock();
        await message({ type: 'error', title: 'Pairing failed', message: 'The server could not complete the pairing request.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
        return { status: 'redeem-error' };
      }
      const clientToken = safeText(body?.clientToken, 8_192);
      if (!response.ok || body?.ok !== true || !clientToken) {
        releaseLock();
        await message({ type: 'error', title: 'Pairing failed', message: 'The pairing link was rejected or has expired.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'redeem-rejected' };
    }

    const config = getHosts();
    const matching = config.hosts.find((host) => host.url === candidateUrl || host.apiUrl === candidateUrl);
    const hostId = matching?.id ?? makeHostId();
    const serverLabel = safeText(body?.server?.label, 256);
    const host = {
      ...(matching ?? {}), id: hostId,
      label: label === 'this server' ? (serverLabel || candidateUrl) : label,
      url: candidateUrl, apiUrl: candidateUrl, clientToken,
      ...(safeText(payload.candidates.find((candidate) => candidate.type === 'relay')?.serverId, 256)
        ? { serverId: safeText(payload.candidates.find((candidate) => candidate.type === 'relay')?.serverId, 256) }
        : {}),
    };
    const hosts = matching
      ? config.hosts.map((entry) => entry.id === hostId ? host : entry)
      : [...config.hosts, host];
    if (hosts.length > 100) return { status: 'catalog-full' };
    try {
      setHosts({
        hosts, defaultHostId: config.defaultHostId ?? hostId,
        initialHostChoiceCompleted: true,
      });
      } catch {
        releaseLock();
        await message({ type: 'error', title: 'Pairing failed', message: 'The host was paired, but NotNativeDesktop could not save it locally.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
        return { status: 'storage-error' };
      }
      releaseLock();
      await message({ type: 'info', title: 'Server paired', message: `${host.label} was added to your saved hosts.`, detail: 'The client token is stored locally and was not displayed.', buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
      return { status: 'paired', hostId, url: candidateUrl };
    } finally { releaseLock(); }
  }

  return { importPairing };
}
