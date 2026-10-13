// SPDX-License-Identifier: Apache-2.0
import { createPublicKey } from 'node:crypto';

const MAX_SESSION_ID_LENGTH = 500;
const MAX_HOST_ID_LENGTH = 128;
const MAX_PAIRING_LENGTH = 16_384;

function parsePairingPayload(url) {
  const values = url.searchParams.getAll('p');
  const versions = url.searchParams.getAll('v');
  if (values.length !== 1 || versions.length !== 1 || versions[0] !== '2') return null;
  const encoded = values[0];
  if (!encoded || encoded.length > MAX_PAIRING_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return null;
  let payload;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) return null;
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== 2) return null;
  const pairingId = typeof payload.pairingId === 'string' ? payload.pairingId.trim() : '';
  const secret = typeof payload.secret === 'string' ? payload.secret.trim() : '';
  const expiresAt = typeof payload.expiresAt === 'string' ? payload.expiresAt : '';
  const expiry = Date.parse(expiresAt);
  if (!pairingId || pairingId.length > 256 || !secret || secret.length > 4_096
    || !Number.isFinite(expiry) || expiry <= Date.now() || !Array.isArray(payload.candidates)
    || payload.candidates.length === 0 || payload.candidates.length > 32) return null;
  const candidates = [];
  for (const candidate of payload.candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const priority = typeof candidate.priority === 'number' && Number.isFinite(candidate.priority) ? candidate.priority : 100;
    if (candidate.type === 'lan' || candidate.type === 'tunnel') {
      if (typeof candidate.url !== 'string' || candidate.url.length > 4_096) return null;
      let target;
      try { target = new URL(candidate.url); } catch { return null; }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
      target.hash = '';
      target.pathname = target.pathname.replace(/\/+$/u, '');
      candidates.push({ type: candidate.type, url: target.href.replace(/\/$/u, ''), priority });
    } else if (candidate.type === 'relay') {
      const jwk = candidate.hostEncPubJwk;
      const serverId = typeof candidate.serverId === 'string' ? candidate.serverId.trim() : '';
      if (typeof candidate.relayUrl !== 'string' || !serverId || serverId.length > 256
        || !jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || Object.hasOwn(jwk, 'd')
        || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
      let relayUrl;
      try { relayUrl = new URL(candidate.relayUrl); } catch { return null; }
      if (!['ws:', 'wss:'].includes(relayUrl.protocol) || relayUrl.username || relayUrl.password) return null;
      try { createPublicKey({ key: jwk, format: 'jwk' }); } catch { return null; }
      relayUrl.hash = '';
      const grant = typeof candidate.grant === 'string' && candidate.grant.length > 0 ? candidate.grant : undefined;
      candidates.push({ type: 'relay', relayUrl: relayUrl.href, serverId, hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ...(grant !== undefined ? { grant } : {}), priority });
    } else return null;
  }
  candidates.sort((a, b) => a.priority - b.priority);
  const text = (value, max) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : undefined;
  return {
    v: 2, pairingId, secret, expiresAt,
    ...(text(payload.label, 256) ? { label: text(payload.label, 256) } : {}),
    ...(text(payload.fingerprint, 256) ? { fingerprint: text(payload.fingerprint, 256) } : {}),
    candidates,
  };
}

/** Parse only known, bounded actions supported by the shell. */
export function parseDesktopDeepLink(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_PAIRING_LENGTH) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'openchamber:' || url.username || url.password || url.port || url.hash) return null;
  if (url.hostname === 'focus' && (url.pathname === '' || url.pathname === '/') && !url.search) return { type: 'focus' };
  if (url.hostname === 'connect' && (url.pathname === '' || url.pathname === '/')) {
    const payload = parsePairingPayload(url);
    return payload ? { type: 'connect', payload } : null;
  }
  if (url.hostname === 'host' && !url.search) {
    // WHATWG URL parsing normalizes literal and percent-encoded dot segments
    // before exposing pathname. Parse the original authority/path shape too,
    // so `host/../saved-id` cannot silently turn into a link for saved-id.
    const rawHostPath = raw.match(/^openchamber:\/\/[^/?#]*\/([^?#]*)$/iu)?.[1];
    if (rawHostPath === undefined || rawHostPath.includes('/')) return null;
    let hostId;
    try { hostId = decodeURIComponent(rawHostPath); } catch { return null; }
    if (!hostId || hostId === '.' || hostId === '..' || hostId.length > MAX_HOST_ID_LENGTH
      || /[\u0000-\u001f\u007f/\\]/u.test(hostId)) return null;
    return { type: 'host', hostId };
  }
  if (url.hostname !== 'session' || url.search) return null;
  let sessionId;
  try { sessionId = decodeURIComponent(url.pathname.replace(/^\/+/, '')); } catch { return null; }
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH || /[\u0000-\u001f\u007f/\\]/u.test(sessionId)) return null;
  return { type: 'session', sessionId };
}

export function extractDesktopDeepLinks(argv) {
  if (!Array.isArray(argv)) return [];
  const links = [];
  for (const argument of argv) {
    const parsed = parseDesktopDeepLink(argument);
    if (parsed) links.push(parsed);
  }
  return links;
}

/** Native alpha keeps session navigation but cannot import or switch legacy hosts. */
export function nativeAlphaDeepLinkAllowed(link) {
  return link?.type === 'focus' || link?.type === 'session';
}

export function extractNativeAlphaDeepLinks(argv) {
  return extractDesktopDeepLinks(argv).filter(nativeAlphaDeepLinkAllowed);
}
