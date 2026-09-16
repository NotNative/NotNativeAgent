# OpenChamber — Remote Access & Security (Relay, Tunnels, Pairing, Auth)

## NotNativeDesktop cleanroom reference, document 08

Scope owner: everything that lets a client reach an OpenChamber server that is
not on the same machine — private relay, network tunnels, pairing/connect
links, UI password + passkeys, device tokens, ssh-remote-machine access model —
and the security promises behind each.

Route inventory, middleware order, and the global `/api` gate registration are
owned by **doc 03**. This document owns the *protocol depth* behind the routes
03 lists (relay, tunnels, pairing, connect links) and the client-side auth
surface. Ring boundaries:

| Concern | Owner |
| --- | --- |
| Route table, middleware, proxy pipeline, CLI `connect-url`/tunnel commands, startup service | doc 03 |
| App shell, runtime switching internals, instance keying | doc 01 |
| Session sync / event pipeline reconnect behavior | doc 04 |
| Chat/session UI | doc 05 |
| Electron ssh-manager internals, deep-link handling (`openchamber://` OS registration) | doc 09 |
| VS Code sseProxy / extension transport | doc 10 |
| Mobile pairing UX (camera scan screen, connection list UI) | doc 11 |
| Settings dialog composition, controls, search | doc 14 |

HARNESS PORTS marks the places where traffic to the agent harness ("OpenCode"
here) is transported. OpenChamber's own HTTP surface is what every transport
below ultimately reaches; the harness rides inside it behind `/api/*` proxy
routes and the SSE/WS event, terminal, and dictation sockets.

---

# Table of contents

1. [Connectivity model overview](#1-connectivity-model-overview)
2. [Auth model](#2-auth-model)
3. [Private relay — full specification](#3-private-relay--full-specification)
4. [Tunnels specification](#4-tunnels-specification)
5. [Pairing and connect links](#5-pairing-and-connect-links)
6. [Connect flows per client](#6-connect-flows-per-client-numbered)
7. [SSH remote machines (desktop)](#7-ssh-remote-machines-desktop)
8. [Dev-server preview tunnel](#8-dev-server-preview-tunnel-short-cross-ref)
9. [Reverse proxy requirements](#9-reverse-proxy-requirements)
10. [Client integrations summary](#10-client-integrations-summary)
11. [Environment variables and settings keys](#11-environment-variables-and-settings-keys)
12. [Security promises & invariants](#12-security-promises--invariants)
13. [Edge and failure cases](#13-edge-and-failure-cases)
14. [Build checklist](#14-build-checklist)

---

# 1. Connectivity model overview

## 1.1 The single origin

Every connectivity mode speaks to **one HTTP surface**: the OpenChamber server
(one TCP port, default 3000, loopback-only by default). A client that
"connects to an instance" has one base URL (or one relay virtual-origin) and
issues the same REST, SSE, and WebSocket traffic it would use on the machine
itself. There is no per-feature remote protocol; there is one app protocol and
many transports for it.

The server's stable identity (`serverId`, exposed unauthenticated on
`/health` and `/api/version`) lets any client verify that an address belongs
to the server it pinned before sending credentials to it
(src: `packages/web/server/lib/opencode/core-routes.js:207-230`).

## 1.2 Connectivity modes

| Mode | Direction of exposure | Who sets it up | Transport bytes | Auth surface |
| --- | --- | --- | --- | --- |
| Loopback (same machine) | none | default | plain http/WS to `127.0.0.1:<port>` | UI session cookie or local desktop client token; with no password an anonymous session is auto-issued |
| LAN / VPN (network bind) | inbound on the LAN | operator (`--host 0.0.0.0` / `--lan`) | plain http/WS (no TLS from the app) | UI password strongly expected; the server *refuses* a non-loopback bind without a password or an explicit risk env (§11.1) |
| Network tunnel (cloudflared / ngrok) | public URL | operator, one active tunnel per instance | TLS terminates at provider edge; app sees http | **tunnel-gated**: one-time bootstrap link `/connect?t=…` exchanges into an `oc_tunnel_session` cookie; password/passkey login, passkey management, pairing creation, and global sign-out are *disabled* at tunnel scope (§2.9) |
| Private relay | none (host dials out) | automatic on first relay pairing | host+client WebSocket to a relay worker; payload is E2EE ciphertext end-to-end | per-device `oc_client_…` bearer; exact same per-request auth as a remote direct client |
| SSH remote machine (desktop) | local port forward on the desktop | operator (desktop Settings) | ssh master connection + local TCP forward to the remote OpenChamber port | the remote instance's own auth (its UI password/device tokens); the desktop holds a client token for it like any other instance |
| Reverse proxy | inbound, HTTPS, ops-chosen | operator (nginx/Caddy/Cloudflare…) | whatever the operator proxies | unchanged OpenChamber auth (cookie or bearer), plus origin checks (§9) |

The relay is not a separate link format; it is one extra *transport candidate*
inside the unified pairing-v2 payload (§5). A tunnel URL can also appear as a
pairing candidate (`type: 'tunnel'`).

HARNESS PORTS: in all modes the harness (OpenCode) is reached only through the
single OpenChamber origin — REST proxy under `/api/*`, live events via SSE
(`/api/event`, `/api/global/event`) and WS (`/api/event/ws`,
`/api/global/event/ws`), terminal over `/api/terminal/ws`, dictation over
`/api/dictation/ws` (doc 03 §4–5). Tunnels and relay carry exactly those
surface families; nothing harness-specific is exposed beyond what the app
proxy already grants.

## 1.3 Threat assumptions per mode

| Mode | Assumed attacker | What protects you | Explicit assumptions |
| --- | --- | --- | --- |
| Loopback | other local processes | OS user separation; HttpOnly cookie; origin checks | The user controls the machine. Anonymous access is acceptable when no password is set. Processes sharing the data dir share the relay identity (relay host claim, §3.12) |
| LAN | other devices on the network | password gate (mandatory unless overridden), per-device tokens | No TLS hop from the app: a LAN attacker can sniff cleartext HTTP; clients must use identity-gated health checks before sending tokens (§5.7) |
| Tunnel | the public internet | tunnel scope gate: anonymous visitors get nothing without the bootstrap token; password login disabled at tunnel scope; per-request UI auth still applies for authorized traffic | The provider edge is trusted transport (the operator's cloudflared/ngrok account). A quick tunnel's random hostname is *not* a security boundary |
| Relay | the relay infrastructure itself (adversarial middle) | E2EE (§3); one-time pairing secret; per-device tokens | The client trusts the pairing-time `hostEncPubJwk` (out-of-band trust anchor). Relay is opt-in; disabling severs reachability immediately |
| SSH | the remote machine / the ssh network path | the operator's ssh auth; OpenChamber's own password/device tokens on the remote instance | The desktop forwards plain TCP; the remote instance is treated as a fully separate OpenChamber server |
| Reverse proxy | the internet hops before the proxy | operator TLS; same OpenChamber auth; origin check accepts proxy headers | The operator configures the proxy correctly (WS, SSE, body sizes); `Host`/forwarded headers become trusted inputs for origin and rpID |

---

# 2. Auth model

## 2.1 Credential inventory

One durable remote credential model exists: `oc_client_…` bearer tokens owned
by the paired-device store. Password, passkey, and pairing are *issuance
methods* for that credential (or for the browser cookie session), not separate
systems (src: `packages/web/server/lib/ui-auth/DOCUMENTATION.md`).

| Credential kind | Format | Validated against | Lifetime | Surface |
| --- | --- | --- | --- | --- |
| UI session cookie | `oc_ui_session` = HS256 JWT `{type:'ui-session', iat, exp}` | server-side secret (file or env) | 12 h default; 7 d with "trust device" | browsers (local/LAN scope; never issued at tunnel scope) |
| Device client token | `Authorization: Bearer oc_client_<32B base64url>` | sha-256 hash in `remote-clients.json` | no default duration unless the issuer sets one; revocable, optional `expiresAt` | every surface; the *only* credential that traverses the relay |
| Short-lived URL token | `oc_url_<24B base64url>` (query `?oc_url_token=…`) | in-memory map, bound to a session token | 60 s | WS upgrades + a fixed GET allowlist (§2.6) |
| Tunnel session cookie | `oc_tunnel_session` = 32 B random base64url | in-memory session map keyed by tunnel id | settings TTL, default 8 h | tunnel-hostname visitors only |
| Tunnel bootstrap token | 32 B random base64url in `/connect?t=…` | in-memory sha-256 record | settings TTL, default 30 min; one-time use; revocable | the connect link printed/QR'd at tunnel start |
| Pairing secret (v2) | 32 B random base64url inside the link payload `p` | sha-256 hash in `client-pairing-sessions.json` | 10 min default TTL; one-time use; cancellable | the pairing payload (sent only to the redeem POST) |
| Passkey | WebAuthn credential (public key per rpID) | `ui-passkeys.json` bound to the password binding | until revoked or password changed | browsers in secure contexts |

## 2.2 UI password sessions (server)

Server: `packages/web/server/lib/ui-auth/ui-auth.js`.

- Password source: `--ui-password` CLI value or `OPENCHAMBER_UI_PASSWORD` env (server `index.js:1612-1614`). Normalized via Unicode `normalize()` + trim.
- Verification: per-process salt (16 random bytes) + `crypto.scryptSync(password, salt, 64)`; compare with `crypto.timingSafeEqual`. Salt and expected hash live **in memory only**; the password itself is never persisted by the auth module.
- Sessions: `SignJWT({type:'ui-session'}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime(ttl/1000 + 's')`, signed with a 32-byte hex secret. Secret resolution order: `OPENCODE_JWT_SECRET` env → `<data-dir>/jwt-secret` file (created 0o600 if missing) → generated in memory (`ui-auth.js:370-406`).
- Cookie: `oc_ui_session=…; Path=/; HttpOnly; SameSite=Strict; Max-Age=…; Expires=…` plus `Secure` when the request is https or `x-forwarded-proto: https`.
- Login rate limit (per client IP taken from `x-forwarded-for` first hop): 10 attempts / 5 min window, then 15 min lockout (429 with `Retry-After`). Callers with no IP get a stricter 3 attempts. Env overrides: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` (`ui-auth.js:14-18`). Response carries `X-RateLimit-{Limit,Remaining,Reset}`.
- `GET /auth/session` — answers `{authenticated:true}` for a valid cookie or client bearer (`scope:'client'`), else `401 {authenticated:false, locked:true}`. With an explicit bearer header the cookie is deliberately ignored, so a revoked token cannot be masked by an ambient cookie (`ui-auth.js:752-780`).
- `POST /auth/session` — password login (§2.3).
- `requireAuth` accepts session cookie **or** client bearer; `requireSessionAuth` accepts cookie only (used for passkey registration, passkey management, global auth reset).
- Invalid cookie → cookie is cleared and `401 {error:'UI authentication required', locked:true}` (`ui-auth.js:714-749`).
- Global sign-out `POST /api/auth/reset` (requires a UI *session*, never a bare client token): clears all passkeys, rotates the JWT secret (refused while `OPENCODE_JWT_SECRET` is set), clears the session cookie. Effect: every browser cookie session dies instantly; device client tokens are *not* rotated by this (revoke them via `/api/client-auth/clients`). Disabled at tunnel scope (§2.9).

## 2.3 Login flow (numbered)

1. Client `POST /auth/session` with `{password}` plus optional
   `trustDevice`, `issueClientToken`, `clientLabel`, `clientKind`,
   `dedupeKey`, `deviceName`, `devicePlatform`, `deviceModel`,
   `appVersion`.
2. Rate limit check (§2.2). On lockout: 429 + headers.
3. scrypt compare with `timingSafeEqual`. Failure: record the failed
   attempt, clear the session cookie, 401 `Invalid credentials`.
4. On success: clear rate limit; issue the JWT session cookie
   (12 h, or 7 d when `trustDevice === true`).
5. If `issueClientToken === true` and the caller is a desktop shell: mint a
   trusted-device client token via `createClient({authMethod:'password',
   dedupeKey, clientKind, …})` whose `expiresAt` equals the cookie TTL, and
   return `{authenticated:true, clientToken, client}`.
6. The response is always `Cache-Control: no-store`.

## 2.4 Passkeys (WebAuthn) — server

Server: `packages/web/server/lib/ui-auth/ui-passkeys.js`. Library:
`@simplewebauthn/server`.

- Disabled unless a password is set ("Passkeys require UI password protection to be enabled") — every call fails with 400 when none is configured.
- Store: `<data-dir>/ui-passkeys.json`, `{version:1, userID:<32B base64url>, passwordBinding:<hex>, passkeys:[…]}`. `passwordBinding = HMAC-SHA256(jwtSecret, password) hex`. On load, if the stored binding differs (password changed/removed) the passkey list is **cleared and rewritten** — passkeys are tied to the current password (matching the public docs). The same guard clears everything when no password is configured.
- rpID: derived per request from `x-forwarded-host` (first hop) else `req.headers.host`, normalized (lowercased, bracket-stripped, port-stripped). Local rpIDs are `localhost|127.0.0.1|::1`. Passkeys are scoped per rpID: passkeys registered on a public domain and on localhost are separate lists.
- Expected origins: the request origin (`x-forwarded-proto` / socket-encrypted scheme + `x-forwarded-host`/host) plus the settings `publicOrigin` origin when configured.
- Registration (`POST /auth/passkey/register/options` then `/verify`, **session-cookie auth required**): options with `attestationType:'none'`, `residentKey:'required'`, `userVerification:'required'`, `excludeCredentials` for existing keys of that rpID. Challenge record kept for 5 min (`requestId` = 16 B base64url). Stored record: `{id, publicKey(base64url), counter, transports, deviceType, backedUp, createdAt, lastUsedAt, label, rpID}`.
- Authentication (`POST /auth/passkey/authenticate/options` — anonymous; `/verify`): options list the rpID's `allowCredentials`, require UV; after verification the counter/`lastUsedAt` are updated; the route then issues the session cookie exactly like password login (`trustDevice` honored) and may mint a client token (`issueClientToken` + desktop metadata) (src: `core-routes.js:650-656`).
- Management: `GET /api/passkeys` and `DELETE /api/passkeys/:id` (session auth; revoke matches `id` **and** current rpID).
- All passkey endpoints, passkey login, `POST /auth/session`, and global reset are **hard 403 at tunnel scope** with `tunnelLocked:true` (§2.9).

## 2.5 Passkeys — client library

Client: `packages/ui/src/lib/passkeys.ts`, library `@simplewebauthn/browser`.

- `getPasskeySupportState()` — requires `window.isSecureContext` ("Passkeys require HTTPS or localhost"), else not supported.
- Endpoint constants: `/auth/passkey/register/options`, `/auth/passkey/register/verify`, `/auth/passkey/authenticate/options`, `/auth/passkey/authenticate/verify`, `GET /api/passkeys`, `DELETE /api/passkeys/:id`, `POST /api/auth/reset`. All via `runtimeFetch` with `credentials:'include'`.
- `authenticateWithPasskey(trustDevice, options)` — full ceremony: options → `startAuthentication` → verify POST carrying `trustDevice`, `issueClientToken`, `clientLabel`, `clientKind`, `dedupeKey`.
- `registerCurrentDevicePasskey()` — label defaults to `navigator.userAgent` or "This device".
- Abort UX: `cancelPasskeyCeremony()` (WebAuthnAbortService) + `isPasskeyCeremonyAbort(error)` to distinguish user-cancel from failure (used heavily by the gate, §6.6).

## 2.6 Runtime URL auth tokens (short-lived)

Browsers' `EventSource` and `WebSocket` cannot attach headers. OpenChamber
mints one-minute tokens usable **only** as `?oc_url_token=` on a fixed
allowlist (src: `ui-auth.js:294-324`). HARNESS PORTS: this is what lets
the browser's event pipeline, terminal, and dictation sockets survive
cookie-less WS upgrades across every transport, tunnels and relay
included; the mint resolves to the `sessionToken` described in §2.7.

- WS upgrade allowlist: `/api/event/ws`, `/api/global/event/ws`,
  `/api/openchamber/realtime-proxy/ws`, `/api/terminal/ws`,
  `/api/dictation/ws`, `/api/dev-tunnel`, `/api/preview/proxy/*`.
- GET allowlist: `/api/event`, `/api/global/event`,
  `/api/openchamber/events`, `/api/openchamber/realtime-proxy/sse`,
  `/api/notifications/stream`, `/api/fs/raw`, `/api/fs/serve`,
  `/api/fs/serve/*`, `/api/preview/proxy/*`, `/api/projects/:id/icon`.
- Anything else: URL token rejected (falls through to cookie/bearer checks).
- `POST /auth/url-token` (session cookie or client bearer; URL tokens cannot
  renew themselves — the mint runs with `allowUrlToken:false`) →
  `{token, expiresAt}`. In-memory map token→`{sessionToken, expiresAt}`;
  `Cache-Control: no-store`. A URL token resolves to its parent session
  token (`client:<id>` for device tokens), so it grants exactly the parent's
  authority for 60 s.
- Rotating the JWT secret (global sign-out) kills the JWT-cookie sessions underlying normal-login tokens; device-bound URL tokens (`client:<id>`) keep working while the device token authenticates.
- Client support lives in `packages/ui/src/lib/runtime-auth.ts`:
  - `getRuntimeUrlAuthTokenSync()` returns the token while valid with a 10 s refresh-skew guard, else schedules a background mint.
  - Refcounting: `acquireRuntimeUrlAuthToken(base)` returns a release fn; while any consumer is active a **single** proactive scheduler re-mints just before expiry (`expiresAt − 10 s skew − 5 s buffer`), so consumers never mint on their own timers and never 401 during a swap. Nothing is polled when no consumer is active.
  - `subscribeRuntimeAuthToken(listener)` fires only on a *replacement* (an existing token swapped out), so consumers rebuild token-bearing URLs without churning on the initial mint.
  - A parallel **local-origin** token (`getLocalRuntimeUrlAuthTokenSync`/`refreshLocalRuntimeUrlAuthToken`) exists for previews proxied to a *different* local origin; tokens are keyed by origin and cleared on mismatch.
  - In relay mode the mint rides the tunnel (§3.10) — there is no reachable network base URL.
  - Mint failures clear the shared token (no empty-token window; the previous token stays valid until replaced).

## 2.7 Trusted-device client tokens (bearer)

Server: `packages/web/server/lib/client-auth/remote-clients.js`
(store `<data-dir>/remote-clients.json`, `version:1`).

- Token generation: `oc_client_` + 32 random bytes base64url. Only `tokenHash = sha256(token) hex` is stored; **the plaintext token is returned exactly once** at creation/redemption.
- Record fields: `id` (12 B hex), `label` (≤80 chars, default `'Remote client'`), `createdAt`, `lastUsedAt`, `revokedAt`, `expiresAt?`, `clientKind` (`mobile | desktop | desktop-local | …`), `dedupeKey`, `usesRelay`, `lastTransport` (`'relay'|'direct'`), metadata `authMethod` (`password | passkey | pairing`), `pairingId`, `deviceName`, `devicePlatform`, `deviceModel`, `appVersion`.
- `createClient(...)` dedupe semantics: a `dedupeKey` mint **replaces** the prior record for that key. Label precedence: explicit label → previous record's label → fallback label — so a rescan without a typed name never resets the operator's chosen name (`remote-clients.js:158-216`). Kind-tagged deduped mints also remove legacy untagged records with the same label (migration cleanup).
- `authenticateBearerToken(token, req)`:
  - requires the `oc_client_` prefix; constant-time hash compare; revoked and expired records fail.
  - Transport classification: the relay dispatcher stamps forwarded requests with `x-openchamber-relay-connection`; anything else is `direct`. A relay-originating request sets `usesRelay = true` (self-heal; **sticky** — a later LAN request never clears it; feeds the relay-demand lifecycle, §3.12).
  - `lastUsedAt`/`lastTransport` writes are throttled to once per 60 s unless the transport changed (then immediate, so the device list flips LAN⇄relay in real time).
  - Success returns `{ok:true, clientId, sessionToken: clientId, client}` — the `sessionToken` is the device record id, which is what URL tokens bind to.
- `revokeClient(id)` sets `revokedAt` (idempotent). Authentication fails immediately. Records stay until `purgeRevokedClients()` (UI "Clear revoked").
- `hasActiveRelayClients()` — true when any non-revoked, non-expired record has `usesRelay === true` **or** observed `lastTransport === 'relay'` (observed transport beats the pairing snapshot; covers pre-flag records and re-paired devices).
- Authority rules on the routes (src: `core-routes.js:728-792`): any client token may revoke **itself**; the `desktop-local` token (the trusted shell client) and UI sessions may revoke or purge anything; other tokens that try get 403 ("Client tokens can only revoke themselves"). `GET /api/client-auth/clients` returns all records for the desktop-local/session callers, only the caller's own record for anyone else. Token creation (`POST /api/client-auth/clients`) requires a UI session or a `desktop-local` client token (`runWithClientCreateAuth`) — this gate is what a hijacked remote device token cannot bypass.
- `desktop-local` client kind: minted by the local shell for its own embedded server with `dedupeKey 'desktop-local'`, label "OpenChamber Desktop" (src: `SessionAuthGate.tsx:42-99`).

## 2.8 Auth expiry detection (client)

Client: `packages/ui/src/lib/runtime-auth-expiry.ts` (zustand store `useAuthSessionStore`, states `ok | expired | reauthenticating`).

- No polling. `runtimeFetch` calls `observeRuntimeAuthResponse(url, status)` for every response. Only a `401` on a *classifiable* path (`/api/…` or `/auth/…`, excluding `/auth/session` and `/api/client-auth/…` — wrong password, pairing redeem, and the confirm probe itself are *normal* 401 flows) counts as suspicion.
- A 401 alone is not proof: proxied provider errors (a dead Anthropic key) also surface as 401. **Every suspicion is confirmed** by one debounced `GET /auth/session` probe re-entering `runtimeFetch`; `401` → `markExpired`; `200` → back to `ok` if flipped. One probe per 15 s window (`CONFIRM_PROBE_MIN_INTERVAL_MS`), one in-flight probe at a time.
- Focus revalidation: `installAuthSessionFocusWatch()` re-probes on visibility/focus change with a ≥5 min throttle between probes (the "laptop woke up, first click fails" case).
- Consumers: `AuthExpiredBanner` (non-blocking banner under the header; the explicit "Log in" click sets `reauthenticating`, which the gate maps to its locked flow), the composer send guard, and mobile orchestration (doc 11). On `reauthenticating` the gate runs its own status check; a genuine 401 lands in the full locked flow.

## 2.9 Call-scope partitioning (tunnel vs local)

`tunnelAuthController.classifyRequestScope(req)`
(src: `packages/web/server/lib/opencode/tunnel-auth.js:249-266`):

1. `Host` header (normalized, port-stripped) equals the **active tunnel
   public host** → scope `tunnel`.
2. Otherwise host is a local/loopback name AND the socket address is
   private or loopback → scope `local`.
3. Otherwise, when no tunnel is active → `local`.
4. Otherwise → `unknown-public` (treated exactly like `tunnel`).

At scope `tunnel|unknown-public` (src: `core-routes.js:592-726`):

| Endpoint | Behavior |
| --- | --- |
| `GET /auth/session` | `200 {authenticated:true, scope:'tunnel'}` for a valid tunnel session; else `401 {authenticated:false, locked:true, tunnelLocked:true}` (cookie cleared) |
| `POST /auth/session` (password login) | **403** `Password login is disabled for tunnel scope` |
| passkey authenticate/register, passkey list/revoke, `POST /api/auth/reset` | **403** with `tunnelLocked:true` |
| everything under `/api` (global gate) | `tunnelAuthController.requireTunnelSession` — needs the tunnel session cookie (`401 {error:'Tunnel authentication required', locked:true, tunnelLocked:true}`) |
| `POST /api/system/shutdown` | at tunnel scope: tunnel session required via `requireShutdownAuth`; at local scope: normal UI auth (`core-routes.js:232-246`) |

Device bearer tokens still pass at *any* scope (they are validated inside
`uiAuthController.requireAuth` which the local branch uses); the tunnel gate
merely replaces the anonymous-browser path and blocks credential-issuing
flows so a phishing visitor cannot escalate by re-running login or pairing.

---

# 3. Private relay — full specification

Normative shared sources (implement both sides from these):

- Shared contract, TypeScript, used by all clients:
  `packages/ui/src/lib/relay/{protocol,crypto,handshake,tunnel-codec,
  tunnel-payloads,transport-error,tunnel-client}.ts`.
- Host mirror, plain-JS ESM, must stay **byte-compatible**:
  `packages/web/server/lib/relay/{e2ee,host-client,tunnel-codec,tunnel-host,
  downstream-scheduler}.js`. A cross-compat test
  (`relay/cross-compat.test.js`) runs a full TS-client ↔ JS-host exchange;
  any reimplementation that adds a mirror must keep that exactness.
- Relay broker: an external Cloudflare Worker (separate repository). This
  section records the broker contract exactly as both sides observe it
  (§3.3); a clean-room self-hosted relay must reproduce it.

Spec provenance in-code: `.opencode/plans/private-relay/01-protocol-spec.md`
(referenced by comments; not part of the deliverable).

## 3.1 Where relay sits

Three layers (src: `packages/ui/src/lib/relay/protocol.ts:1-27`):

1. **Relay routing (Layer 1)** — outbound `wss://` sockets to the relay
   worker; connection brokering; host authentication to the worker. The
   worker understands only this layer and forwards binary frames verbatim.
2. **End-to-end encryption (Layer 2)** — an authenticated AES-GCM channel
   derived directly between client and host; the relay holds no keys.
3. **Tunnel multiplexing (Layer 3)** — a small framing protocol carrying
   HTTP request/response (with streamed bodies), WS sub-streams, and
   control frames inside the encrypted channel.

What the tunnel carries: everything a client would send to the single
OpenChamber origin — REST/proxied harness calls under `/api/*`, `/auth/*`
and `/health`; SSE streams (plain long-lived HTTP response bodies); and the
real WebSockets (event stream, terminal, dictation, dev-server preview).
HARNESS PORTS: harness traffic therefore flows through the same mux; the
host forwarder is a strict transport, never a parser (§3.9).

Default endpoint: `wss://relay.openchamber.dev/ws` (src:
`relay/service.js:19`). Self-hosting pins it via `OPENCHAMBER_RELAY_URL`
(must be `ws:`/`wss:`), which overrides the stored setting for the host
connection, the pairing candidates, and status alike — paired clients
inherit the endpoint automatically from the pairing offer (`relayUrlLocked`
status flag).

## 3.2 Host identity and keys

src: `relay/signing-key.js`, `relay/identity.js`, `relay/service.js:250-274`.

- **Signing keypair** — long-lived ECDSA P-256, stored in settings as
  `relaySigningKey = {privateJwk, publicJwk}`, shared with the push relay
  (same key ⇒ same `serverId`; push token binding depends on stability).
  Generated once at first relay/push use.
  Regeneration gate: never mint a replacement after a *swallowed* settings
  read failure — a strict reader must verify true absence before
  generating, because a new signing key means a new `serverId` and orphans
  every paired device and push binding.
- **`serverId`** =
  `base64url(SHA-256(JSON.stringify({crv,kty,x,y})))` of the canonical
  public signing JWK in exactly that key order (byte-for-byte mirror of the
  relay-auth canonical form in the website's worker). This is the routing
  key at the worker, the client's pinned identity, and the value exposed on
  `/health`, `/api/version`, `/api/client-auth/connection/candidates`, and
  pairing payloads. Derived from a *public* key — not itself a secret.
- **Encryption keypair** — long-lived ECDH P-256, stored as
  `settings.relayEncryptionKey = {privateJwk, publicJwk}`. The public
  half is the **E2EE trust anchor** distributed in the pairing payload
  (`hostEncPubJwk`). Regeneration invalidates every paired client's pinned
  anchor; the same strict-read gate applies and a regeneration logs loudly
  once. WebCrypto keys are single-purpose (signing vs deriveBits), which is
  why the two keypairs differ.
- **Host→relay authentication** — per WebSocket URL, ECDSA-SHA256 with
  IEEE P1363 (raw `r||s`) encoding, base64url. Signed payload string:
  `${ts}.${serverId}.${role}.${connectionId ?? ""}`. URL params carry
  `ts` (epoch ms), `sig`, `pk` (base64url of the canonical public JWK
  string). The worker verifies `sig` against `pk` and binds the connection
  to `serverId`. A broker reimplementation should reject stale `ts`
  values (the reference worker groups diagnostics but is expected to treat
  old timestamps as invalid).
- Node-side signing uses `crypto.sign('SHA256', msg,
  {key, dsaEncoding:'ieee-p1363'})`; a WebCrypto verifier uses
  `subtle.verify({name:'ECDSA', hash:'SHA-256'}, pubKey, sig, msg)`.

## 3.3 Layer 1 — broker connection protocol

Both sides are clients of the worker; the worker never dials anything.

### Host control connection

One long-lived outbound WS per host:

```
GET wss://<relay-host>/ws?v=1&role=host-control&serverId=<serverId>
    &appId=openchamber&appVersion=<pkg version>&platform=<runtime label>
    &ts=<epoch ms>&sig=<b64url>&pk=<b64url>
```

- `platform` = `OPENCHAMBER_RUNTIME` env or `web`; ssh-hosted servers
  report `ssh-remote` (diagnostics only, §3.14).
- The worker grants a **single host slot per `serverId`**: a second
  host-control connection replaces the first (close `4001 Control
  replaced`). The machine claim (§3.12) arbitrates locally; the worker
  remains the enforcer.
- Control liveness (host side): WS ping every 30 s
  (`CONTROL_PING_INTERVAL_MS`); a quiet window beyond interval + 10 s
  grace (`CONTROL_PONG_GRACE_MS`) terminates the socket → reconnect with
  exponential backoff (1 s base ×2, 30 s cap). Status: `connecting` /
  `reconnecting` / `connected` (error strings kept for status display).
- A previous control socket's nonzero close code becomes `lastError`.

### Control messages (JSON text, host ← worker)

| message | shape | host action |
| --- | --- | --- |
| `connected` | `{type:'connected', connectionId}` | open a host-data socket for that `connectionId` (skip if one exists) |
| `disconnected` | `{type:'disconnected', connectionId}` | tear down the matching data socket |
| `sync` | `{type:'sync', connectionIds:[…]}` | full reconciliation: close data sockets not in the list; open missing ones |

**30 s control-reconnect grace**: data sockets ride their own relay
connections and are *not* closed when control blinks — the worker is
expected to keep client legs alive for ~30 s during control
re-registration (the host leaves them up explicitly).

### Client connection

```
GET wss://<relay-host>/ws?v=1&role=client&serverId=<serverId>
    &appId=openchamber&appVersion=<app version>&platform=<client platform>
    [&grant=<opaque>]
```

- The worker notifies the host (`connected` with the same `connectionId`)
  and pairs the two legs. Replacing an existing client leg closes the old
  one with `4002 Duplicate client`.
- `grant` is an optional one-time admission token carried from the pairing
  candidate. The current worker ignores it (E2EE + the pairing secret are
  the gates); re-implementations may use it for relay-side per-device or
  traffic control. Clients **never persist** the grant (one-time pairing
  artifact) — steady-state relay connections route by `serverId` alone.
- Client platform values are the presence labels: `desktop` (Electron),
  `vscode`, `ios`, `android`, `web`.

### Host data connection (per connected client)

```
GET wss://<relay-host>/ws?v=1&role=host-data&serverId=<serverId>
    &connectionId=<id>&appId=openchamber&…&ts&sig&pk
```

- Open timeout 15 s (`DATA_SOCKET_OPEN_TIMEOUT_MS`; teardown on miss).
- The E2EE responder handshake runs here (§3.4); after establishment the
  socket carries only encrypted Layer 2/3 frames (all binary).
- Idle reaping (host side): any inbound frame — including the client's
  keepalive Ping — refreshes `lastActivityAt`; a socket silent for 90 s
  (`DATA_SOCKET_IDLE_TIMEOUT_MS`) closes with `1001 client idle timeout`
  (swept every 30 s). The worker may not notice dead client legs, so the
  host reaps them itself to free resources and keep the "N devices
  connected" status honest (no ghosts).
- Worker close codes a **client** may receive (src: `protocol.ts:116-126`):

| code | name | meaning / client policy |
| --- | --- | --- |
| 4001 | ControlReplaced | another process replaced the host control connection (host-side fight; the machine claim must prevent steady-state) |
| 4002 | DuplicateClient | this client id was replaced — **terminal** |
| 4003 | StuckControlReset | broker-side control reset stuck |
| 4008 | HostUnavailable | no live host for `serverId` |
| 4010 | AuthFailed | signature/identity rejected — **terminal** |
| 4029 | LimitExceeded | worker capacity — **terminal** |
| 1012 | HostWentAway | host went away; retry |
| 1008 | RekeyMismatch | host saw a *different* client key after accepting one (rekey attack; fail closed) |
| 1011 | ChannelFailure | E2EE/framing failure (either side; fail closed) |

Codes **4010, 4002, 4029** are terminal client-side: no reconnect is
scheduled; the error is retained for the lifetime of that client — every
later `fetch()`/`openWebSocket()` fails immediately rather than waiting for
a reconnect that will never be scheduled. All other closes reconnect with
backoff.

## 3.4 Layer 2 — E2EE handshake (transcribed)

src: `crypto.ts`, `handshake.ts` (TS normative) and `e2ee.js` (JS mirror).
Primitive selection is fixed: **ECDH P-256 → HKDF-SHA-256 → two AES-256-GCM
keys, one per direction**. WebCrypto only; every implementation must use
identical parameters so frames cross-decrypt.

**Crypto constants**

| constant | value |
| --- | --- |
| `RELAY_PROTOCOL_VERSION` | `1` |
| `RELAY_HKDF_INFO` | utf8 bytes of `"openchamber-relay-v1"` |
| Handshake nonce | 16 random bytes |
| ECDH | `namedCurve: 'P-256'`, extractable key pair, usage `['deriveBits']` |
| HKDF output | 512 bits = `2 × 32 B`: `clientToHost` = first 32 B, `hostToClient` = last 32 B |
| AES-GCM import | raw 32 B, `extractable: false`, usages `['encrypt','decrypt']` |
| IV | 12 B = 4 B random per-direction prefix ‖ 8 B **big-endian** frame counter (starts at 1, +1 per encryption call) |
| GCM tag | 16 B |

`deriveSessionKeys(ownPrivateKey, peerPublicKey, nonce)`:

- `sharedSecret = subtle.deriveBits({name:'ECDH', public: peerPublicKey},
  ownPrivateKey, 256)`.
- `hkdfKey = importKey('raw', sharedSecret, 'HKDF', false,
  ['deriveBits'])`.
- `keyMaterial = subtle.deriveBits({name:'HKDF', hash:'SHA-256',
  salt: nonce, info: utf8('openchamber-relay-v1')}, hkdfKey, 512)`.
- `clientToHost = importKey('raw', keyMaterial[0..32), 'AES-GCM', false,
  ['encrypt','decrypt'])`; `hostToClient = importKey('raw',
  keyMaterial[32..64), …)`.
- Both peers run this with their own private key — host: the long-lived
  encryption private key; client: the per-connection ephemeral private
  key. ECDH yields the same secret in both directions, hence matching key
  pairs.

**Encrypted frame** (one binary WS message):

```
[1 byte version = 1][12-byte IV][ciphertext || 16-byte GCM tag]
```

- Max plaintext per frame: 64 KiB (`MAX_PLAINTEXT_FRAME_BYTES`).
- Encryptor state: a fresh 4 B random IV prefix per direction per
  handshake; strictly increasing counter from 1.
- Decryptor **fails closed**: rejects frames shorter than
  header+tag (29 B), a version byte ≠ 1, and `counter <= lastCounter`
  (regression or replay = tampering; the broker preserves ordering, so a
  regression can only mean attack); GCM failure ⇒ error; accepted frames
  advance `lastCounter`.
- One `encrypt()` call == one WS message == one counter tick, whether it
  carries one frame or a batch. Both sides serialize encrypt+send through
  a promise chain (`sendChain`) so the counter hits the wire in
  encryption order; inbound decryption is serialized too (host
  `processing` chain, client `recvChain`), because the counter check
  requires wire order.

**Handshake messages** (plaintext JSON *text* frames before encryption;
any `v !== 1` is ignored as foreign):

```jsonc
// client → host, re-sent every 1 s until established (retry race)
{ "t": "hello", "v": 1,
  "clientPubJwk": {"kty":"EC","crv":"P-256","x":"…","y":"…"},
  "nonce": "<base64url, 16 bytes>",
  "batch": true,          // optional capability advertisement
  "flowControl": true }   // optional capability advertisement
// host → client
{ "t": "ready", "v": 1, "batch": true, "flowControl": true }
```

- `clientPubJwk` is the ephemeral public key reduced to `{kty,crv,x,y}`;
  extra members (incl. any private `d`) are never serialized.
- Capability flags: missing/false = legacy behavior; negotiated **only
  when both peers advertise**. `batch` and `flowControl` are independent
  of each other.
- Key reduction rule for public JWKs everywhere
  (`exportPublicKeyJwk`/`normalizeEcPublicJwk`): keep only
  `{kty,crv,x,y}`; comparison/fingerprint uses
  `JSON.stringify({crv,kty,x,y})` in that order
  (`publicKeyJwkFingerprint`).

**State machines and fail-closed rules** (both sides):

- Client: send `hello` on socket open, re-send on a 1 s interval
  (`helloRetryMs`); overall handshake deadline 30 s (`helloTimeoutMs`) —
  a miss fails the attempt.
- Host: repeated **identical** `hello` (same client-key fingerprint) while
  already established → re-send the same `ready` (client retry race; the
  client ignores duplicate `ready`). Atomic: `readyText` stored before
  any re-answer.
- Host: a `hello` with a **different** fingerprint after acceptance →
  close **1008** (`'rekey mismatch'`); never rekey in place.
- Established channel + any plaintext input other than a legal duplicate
  `ready` (client) or legal duplicate `hello` (host) → close **1011**
  (`'plaintext frame on established channel'`).
- Binary frame before the handshake completes → close **1011**
  ("encrypted frame before handshake completed" client-side; "binary
  frame before handshake" host-side).
- Malformed `hello` (bad JWK/nonce) or key-derivation failure → 1011.
- Client: a `ready` arrives → derive keys from it, establish. Pre-
  establishment *unknown* plaintext is **ignored** (relay control noise /
  late frames) rather than tearing down a connection that may recover.
- Host negotiation math: `negotiatedBatch = localSupport &&
  message.batch === true`; `negotiatedFlowControl = options.flowControl !==
  false && message.flowControl === true`; echoed in `ready` when enabled;
  client-side counterpart mirrors it against its own advertisement.
- Fresh handshake per connection — no session resumption; a reconnect mints
  a new ephemeral key + nonce (counters reset, direction-bound).

## 3.5 Encrypted frame format and byte budgets

- `ENCRYPTED_FRAME_VERSION = 1`; header bytes = 13; GCM tag = 16.
- `MAX_PLAINTEXT_FRAME_BYTES = 64 * 1024` — the plaintext budget for
  anything (tunnel frames plus batch envelopes). Chosen so relay-forwarded
  WS frames stay far below the broker's 1 MiB WS-message cap even with
  overhead.
- `MAX_TUNNEL_PAYLOAD_BYTES = MAX_PLAINTEXT_FRAME_BYTES − 5 (tunnel frame
  header) − 5 (batch envelope reserve: 1 tag + 4 length)` — so even a
  maximum-size frame fits inside one 64 KiB encrypted plaintext once
  wrapped.
- base64url helpers (`bytesToBase64Url` / `base64UrlToBytes`) use the
  RFC-4648 alphabet without padding; decoders reject `length % 4 === 1`.

## 3.6 Layer 3 — tunnel multiplexing frame format

src: `tunnel-codec.ts` / `tunnel-codec.js` — byte-identical mirrors.

**Frame layout:** `[1 byte frameType+flags][4 byte BE streamId][payload]`.

- High bit of byte 0 (`0x80`) = `hasMoreFragments` (the message continues in
  further frames); the actual type is the low 7 bits.
- Types (`TunnelFrameType` — numeric contract, never renumber):

| id | name | direction | payload |
| --- | --- | --- | --- |
| 1 | `HttpRequest` | client→host | JSON `{method, path, query, headers, hasBody?}` |
| 2 | `HttpBody` | both | raw body bytes (client request body; host response body) |
| 3 | `HttpResponse` | host→client | JSON `{status, headers}` (headers = flat string map) |
| 4 | `StreamEnd` | both | empty — half-closes the request body (client→host) or ends the response (host→client) |
| 5 | `StreamAbort` | both | JSON `{reason}` |
| 6 | `WsOpen` | client→host | JSON `{path, query, protocols?}` |
| 7 | `WsOpened` | host→client | JSON `{protocol?}` (negotiated subprotocol) |
| 8 | `WsText` | both | UTF-8 bytes; may be fragmented |
| 9 | `WsBinary` | both | binary bytes; may be fragmented |
| 10 | `WsClose` | both | JSON `{code, reason}` |
| 11 | `Ping` | both | empty |
| 12 | `Pong` | both | empty |
| 13 | `DeliveryAck` | client→host | 8 B BE cumulative ack (§3.8) |

- JSON payloads are UTF-8; shape guards (`isHttpResponsePayload`,
  `isStreamAbortPayload`, `isWsClosePayload`, `isHttpRequestPayload`,
  `isWsOpenPayload`, `isWsClosePayload`) validate and reject unexpected
  shapes (HTTP aborts the stream; framing errors fail the channel).
- **Stream ids:** client-initiated streams use **odd** ids starting at 1
  (`createStreamIdAllocator` increments by 2); even ids are reserved.
  Stream 0 is reserved for Ping/Pong/DeliveryAck and must never wait on
  downstream credit. A duplicate stream id on the host aborts both sides.
- **Fragmentation:** only WS message frames (WsText/WsBinary) may set
  `hasMoreFragments`. `encodeFragmentedMessage` chunks via
  `chunkPayload` and flags all but the last. The
  `createFragmentAssembler` reassembles per `(streamId, frameType)`,
  bounded at 16 MiB per message (overflow ⇒ codec error). Any other frame
  type arriving fragmented client-side is a hard channel error. An empty
  chunked body yields one empty chunk (never zero frames).
- Keepalive: `Ping` carries stream 0; the peer answers `Pong` on the same
  stream id. Any inbound frame also serves as liveness (§3.10).

## 3.7 Batching (optional capability)

One encrypted WS message may carry several tunnel frames. Negotiated via
the `batch` handshake flag (both peers must advertise). Container layout
(src: `tunnel-codec.ts:184-253`):

```
1 frame   → [0x00][frame bytes]
N frames  → [0x01]([4B BE length][frame])×N
```

Outbound batcher (shared implementation `createOutboundFrameBatcher`;
defaults `windowMs = 150`, `maxBatchBytes = 24 KiB`, `maxBatchFrames = 32`):

- Only `HttpBody`, `WsText`, `WsBinary` are buffered. Setup/teardown/
  keepalive frames encode immediately (flushing the pending buffer first,
  preserving per-stream order).
- Leading edge: if nothing flushed within `windowMs`, the next frame ships
  immediately (batch of 1) — time-to-first-token and terminal echo stay
  instant.
- Trailing window: flush at timer fire, at `maxBatchBytes`, at
  `maxBatchFrames`, or when the next frame would exceed
  `MAX_PLAINTEXT_FRAME_BYTES` (per-frame overhead reserved:
  `1 + 4` bytes; worst-case envelope overhead is
  `BATCH_ENVELOPE_RESERVED_BYTES`).
- Host-side `batchWindowMs` is tunable via env
  `OPENCHAMBER_RELAY_BATCH_WINDOW_MS` (default 150) and injectable in
  tests.
- Teardown drops un-flushed frames (the channel is going away).
- 150 ms rationale (transcribed from source comments): the chat render
  pipeline already gates visible streaming updates below this (100 ms
  input throttle → ~64 ms paced reveal), so the window is invisible while
  cutting relay-forwarded WS messages materially.

Without negotiation (`batch` false on either side): one frame per
encrypted message; the host keeps a legacy timed batching window only on
its own send path when no flow-control scheduler is active.

## 3.8 Downstream flow control (optional capability)

src: `downstream-scheduler.js` (host) + `tunnel-client.ts` ack logic;
host-to-client direction only (uploads keep their existing behavior). The
Cloudflare broker needs no changes for it.

- **Ack unit:** the client sends encrypted `DeliveryAck` frames **on
  stream zero**. Payload: 8-byte unsigned **big-endian cumulative** count
  of received *raw tunnel-frame bytes* on nonzero streams — including the
  5-byte frame header; batch envelopes, encryption overhead, and
  stream-zero keepalives are excluded. The count resets with each
  handshake.
- ACKs cover complete frames (never partial) and include late frames of
  cancelled streams (they still consumed credit). Host validation:
  strictly increasing (no duplicates/regressions), never beyond
  `sentBytes`, and the byte count must land exactly on a frame boundary
  in the host's outstanding list — any violation throws and the channel
  is closed (1011).
- Client ACK cadence: after transport decode/dispatch (not waiting for
  React render). Inline when `receivedBytes − acknowledged ≥ 16 KiB` per
  received batch, plus a 10 ms tail timer so a final small frame cannot
  strand sender credit. ACK and keepalive processing **never** await
  downstream credit (that would deadlock the channel).
- **Host scheduler** (`createDownstreamScheduler`): per-stream FIFO
  queues with round-robin selection across streams; `send(frame)` returns
  a promise the producer awaits, so HTTP response readers stop before a
  large plaintext queue builds. Under flow control the response chunk
  size drops to 8 KiB (`DOWNSTREAM_CHUNK_BYTES`); legacy chunking stays
  `MAX_TUNNEL_PAYLOAD_BYTES`.
- Stream zero (keepalives only) bypasses the window and must not starve
  the round-robin (selected first each round; small frames only).
- Windowing: starts at 64 KiB (`MIN_WINDOW_BYTES`), hard cap 1 MiB
  (`MAX_WINDOW_BYTES`). Grow ×2 only when the window itself limited
  throughput and ACK RTT is near the best observed; halve when delivery
  delay exceeds `minRtt + 100 ms` (`QUEUE_DELAY_TARGET_MS`). Adjustment
  happens once per window (boundary = latest ack position + window), not
  per frame. Sparse traffic cannot inflate the window for a later bulk
  burst; a sudden bandwidth drop can delay in-flight bytes but cannot
  build an unbounded backlog.
- Queue limits: 4 MiB queued bytes / 4096 queued frames / 4096
  outstanding frames — exceeding any fails the channel (`onError` →
  close 1011).
- Backpressure reaches the loopback response reader: Node's `ws` pauses
  socket reads while output is waiting (poll every 20 ms until
  `bufferedAmount ≤ 4 MiB`, `BACKPRESSURE_LIMIT_BYTES`). **Bun's ws shim
  cannot pause**, so the host enforces a connection-wide pending WS cap
  (16 MiB bytes / 1024 messages, `MAX_PENDING_WS_*`) and **explicitly
  aborts the offending substream** on overflow — it never silently
  discards deltas. WS output messages are serialized through their last
  fragment and the `WsClose` frame follows pending output; cancellation
  releases queued work and channel teardown releases producers/acks.
- Regression coverage: `downstream-scheduler.test.js`, `flow-control.test.js`
  and the end-to-end fixture in `cross-compat.test.js` (real client, host,
  crypto, and loopback requests with a byte-paced relay leg, comparing
  delivery ordering, queue growth, and a concurrent small response, both
  legacy fallback directions, unbatched operation, cancellation, and
  fragmented WS output). It does not replace a physical iOS/LTE check.

## 3.9 Host dispatcher (loopback forwarding rules)

src: `tunnel-host.js` (`createTunnelHost`). One instance per relay
connection (`connectionId`). It consumes decrypted tunnel frames and
forwards to the local server over loopback, then streams responses back.

- **Never injects credentials.** Tunneled requests are authenticated
  exactly like any remote client (bearer `oc_client_…` header or
  `?oc_url_token=…` query). The per-request server-side auth is the real
  gate; the relay path grants *reachability*, not authorization.
- **Path allowlists** (defense in depth; mirrors the realtime-proxy
  families):
  - HTTP: exactly `/health`, `/api`, `/api/…`, `/auth`, `/auth/…`.
    Anything else → synthetic `403` JSON response
    `{error, reason, source:'relay-tunnel-host'}` (synthetic responses
    always carry a body naming the cause; they never look like an empty
    upstream answer).
  - WS: exactly `/api/global/event/ws`, `/api/event/ws`,
    `/api/terminal/ws`, `/api/dictation/ws`, `/api/dev-tunnel`
    (`isAllowedRelayWebSocketPath`).
  HARNESS PORTS: these allowlists are what prevent the relay from becoming
  a generic loopback port bouncer (the host machine may run databases,
  admin panels, harness processes on other ports).
- **HTTP forwarding:** request →
  `fetch(http://127.0.0.1:<localPort><path>?<query>)` with a streamed
  duplex body (`duplex:'half'`). `localPort` comes from the same source
  the tunnel runtime uses (the OpenChamber HTTP port).
  - Request headers: hop-by-hop stripped — `connection`, `keep-alive`,
    `transfer-encoding`, `upgrade`, `host`, `content-length` (the body is
    re-chunked through the tunnel; undici computes framing). CR/LF in
    names/values drops the header. Injected:
    `x-openchamber-relay-connection: <connectionId>` (the server-side
    transport classifier, §2.7) and
    `origin: http://127.0.0.1:<localPort>` — the loopback origin actually
    dialed, overwriting any client-supplied `origin`, because client
    origins are unreliable (WKWebView "null") and a no-origin dial would
    fail the server's WebSocket origin check. The request is still
    authenticated by its tunneled token, not by this origin.
  - Response headers stripped: `connection`, `keep-alive`,
    `transfer-encoding`, `content-length`, `content-encoding` (loopback
    fetch already decoded compression).
  - Chunk groups: response bodies are sliced (`chunkPayload`, 8 KiB under
    flow control else full budget) and offered in bounded groups
    (`MAX_TUNNEL_PAYLOAD_BYTES / responseChunkBytes` per group), each
    group awaiting transmission before the next (§3.7/§3.8), with loopback
    reads paused on backpressure (§3.8).
- **Request body semantics:**
  - Bodies ≤ 512 KiB (`BODY_BUFFER_MAX_BYTES`) are fully buffered and
    forwarded to loopback **only when the client's `StreamEnd` frame
    arrives** — a body that lost frames in transit therefore never
    reaches the loopback server as an empty/truncated chunked body (the
    bare 400 seen as mobile "Failed to send message (400)"); the host
    aborts the stream instead (`StreamAbort`), which the client surfaces
    as an ambiguous transport failure it can retry (§3.10).
  - Larger bodies switch to live streaming once the buffer cap is crossed
    (buffered prefix flushed into the live stream first).
  - While buffering, a **15 s delivery deadline**
    (`BODY_DELIVERY_TIMEOUT_MS`) aborts a stalled body into the same
    ambiguous-failure path.
  - `hasBody: true` with zero received `HttpBody` frames ⇒ abort
    ("tunnel request body frames were lost"). A genuine empty body emits
    one empty `HttpBody` frame from the client so the two cases are
    distinguishable. Buffered forwarding lands as a single concatenated
    body (Bun frames it with content-length, never chunked).
- **WS sub-streams:** `WsOpen` → `ws` client dial to
  `ws://127.0.0.1:<localPort><path>?<query>` (origin +
  `x-openchamber-relay-connection` injected; `maxPayload` 16 MiB).
  `WsOpened` returns the negotiated subprotocol. Client→host text/binary
  messages are reassembled from fragments and written whole; host→client
  messages are re-chunked with fragment flags and serialized through
  their last fragment (a later close cannot overtake final output).
  Host-side `WsClose` carries `{code, reason}` with code clamped to
  1000–4999 (default 1000). A stream killed by channel reset closes with
  **1012** client-side (§3.10).
- **Keepalive:** host answers `Ping` with `Pong` (stream-scoped); ignores
  `Pong`; ignores unexpected `HttpResponse`/`WsOpened` (host never sends
  those) rather than tearing down.
- **Abort/cancel:** client `StreamAbort`, channel death, or teardown
  aborts the local fetch (`AbortController`) or terminates the loopback
  socket; pending scheduler work for the stream is cancelled (already-
  selected bytes may still arrive and must still be ACKed).
- **Duplicate stream id** ⇒ abort both sides locally + `StreamAbort`
  upstream.

## 3.10 Client tunnel surface

src: `tunnel-client.ts` (`createRelayTunnelClient`), `runtime-tunnel.ts`,
`runtime-socket.ts`, `tunnel-payloads.ts`, `transport-error.ts`, plus
wiring in `runtime-switch.ts` / `runtime-fetch.ts` / `runtime-auth.ts`
(doc 01 owns the switching matrix).

**Options** — `{relayUrl, serverId, hostEncPubJwk, grant?, createWireSocket? (test
hook), helloRetryMs=1000, helloTimeoutMs=30000, pingIntervalMs=30000,
pingTimeoutMs=15000, batchWindowMs=150, batch=true, flowControl=true,
reconnectBaseDelayMs=1000, reconnectMaxDelayMs=30000,
hiddenOrOfflineMaxDelayMs=60000}`.

**API surface** — `fetch(input, init) → Response` (fetch-compatible);
`openWebSocket(pathWithQuery, protocols?) → RelayTunnelWebSocket`
(native-WS-compatible shape: `readyState` 0–3, assignable `on*` handlers,
`send(string | ArrayBuffer | ArrayBufferView)`, `close(code?, reason?)`,
messages deliver `string | ArrayBuffer`, binary always ArrayBuffer);
`getStatus()` → `{state: 'idle'|'connecting'|'connected'|'reconnecting'|
'error', lastError?}`; `subscribeStatus(listener)`; `close()`.

**fetch specifics**

- Inputs are normalized (method, headers, path+query only —
  `TUNNEL_PARSE_BASE = 'http://tunnel.invalid'` is a throwaway parse
  base; absolute URLs ride the tunnel too since the origin is virtual
  mid-relay).
- Body mapping: string/ArrayBuffer/view = one chunk; `ReadableStream` =
  streamed; Blob/FormData/URLSearchParams serialized through a probe
  `Response` so the derived `content-type` (multipart boundary included)
  is preserved.
- Lifecycle: `HttpResponse` resolves with a streaming body from
  `HttpBody` frames; `hasBody` in the head is set from the caller's body;
  an empty stream still emits one empty `HttpBody` frame (§3.9); caller
  abort or `Response.body.cancel()` sends `StreamAbort`.
- **Ambiguous transport failures are tagged** (`transport-error.ts`): any
  error occurring after the request head reached the wire — host
  `StreamAbort`, `StreamEnd` before response head, channel death,
  malformed head — is thrown via `markAmbiguousTransportFailure(error)`
  (a non-enumerable `__openchamberAmbiguousTransport` flag).
  `isAmbiguousTransportFailure(error)` is the caller contract. Rationale
  (transcribed): when a request dies after being handed to the transport,
  the client does NOT know whether the server processed it; over the relay
  this is the common case (reconnect, host-side stream abort, dead
  channel). Callers that would otherwise retry — notably prompt sends —
  must tell that state apart; `prompt_async` is the motivating case
  (treating ambiguous as definite rolls back the user message and lets
  the queue re-send a prompt the engine is already answering → two AI
  responses). A fresh error is tagged per failure so the flag cannot leak
  to waiters whose request never reached the wire.
- A stream dying with the channel rejects every waiter with a *new*
  tagged error ("relay tunnel reset: <cause>").

**openWebSocket specifics**

- `WsOpen` path is `path?query` extracted from any URL
  (`wsUrlToTunnelPath`); subprotocols forwarded.
- Host side mapped codes: host `StreamAbort` → close `1006`
  (`errored`); channel death → close **1012** ("host went away, retry") so
  callers' reconnect machinery retries rather than treating it as a user
  close.
- `readyState` transitions only through real `WsOpened`/`WsClose`;
  `send` before open throws "relay tunnel socket is not open".

**Keepalive + reconnect (client)**

- Keepalive is **inbound-driven**: when no frame has been received for
  `pingIntervalMs`, send tunnel `Ping` (stream 0) and arm a one-shot
  pong deadline of `pingTimeoutMs`; any inbound frame (including Pong)
  clears it. Outbound HTTP retries cannot suppress the probe
  (half-open sockets would otherwise look alive).
- Reconnect: `reconnectBaseDelayMs × 2^attempt` capped at
  `reconnectMaxDelayMs` (attempt index clamped at 10); the cap becomes
  `hiddenOrOfflineMaxDelayMs` while `navigator.onLine === false` or the
  document is hidden. Wake listeners (`online`,
  `visibilitychange → visible`) cancel the pending timer and reconnect
  immediately.
- **Terminal close codes** (4010 AuthFailed, 4002 DuplicateClient,
  4029 LimitExceeded) set state `error` with a retained error and *no*
  reconnect; all subsequent `fetch`/`openWebSocket` fail fast. Other
  closes (including 4008, 1012, channel failures) retry with backoff and
  a fresh E2EE handshake.

**Runtime integration**

- `runtime-tunnel.ts` holds the singleton:
  `activateRelayTunnel(descriptor)` (reuses an equal descriptor instead of
  tearing down a live tunnel), `adoptRelayTunnel(descriptor, client)`
  (adopts an already-open probe tunnel so the immediately following
  activate call reuses it — one WS connect + one handshake saved),
  `deactivateRelayTunnel()`, `getActiveRelayTunnel()`,
  `getActiveRelayDescriptor()`, `isRelayModeActive()`.
- `runtime-switch.ts` `switchRuntimeEndpoint({apiBaseUrl, clientToken,
  runtimeKey, requestHeaders, relay})` activates the tunnel **before**
  minting the URL auth token (the mint itself rides the tunnel); a null
  `relay` deactivates.
- `runtime-fetch.ts`: when a relay tunnel is active, runtime HTTP (paths
  and absolute URLs) is transported through `relay.fetch` with same
  headers + bearer; read coalescing applies to both transports; auth
  classification (§2.8) still observes every response.
- `runtime-socket.ts` `openRuntimeWebSocket(url, protocols)` is the only
  sanctioned socket op in relay mode; a raw `new WebSocket(url)` against
  the tunnel-virtual origin throws ("The string did not match the
  expected pattern").
- `runtime-auth.ts`: in relay mode the `POST /auth/url-token` mint runs
  through the tunnel (same headers/bearer), `marks response classification
  unchanged`.

## 3.11 Reconnection, keepalive, terminal failures

Timing contract summary (client side unless noted):

| Event | Value / behavior |
| --- | --- |
| Hello retry interval | 1 s until established |
| Hello deadline | 30 s → attempt fails ("relay handshake timeout") |
| Idle ping | after 30 s without inbound frames |
| Pong deadline | 15 s after a ping without inbound traffic |
| Reconnect backoff | 1 s ×2 attempts, cap 30 s (60 s offline/hidden) |
| Wake fast-path | `online` / visibility → immediate connect |
| Stream failure on channel death | fetch rejects tagged ambiguous error; tunnel WS closes 1012 |
| Terminal close codes | 4010, 4002, 4029 → state error retained; fail-fast forever |
| Host control keepalive | ping 30 s / missed-pong grace 10 s → reconnect |
| Host data idle reaper | 90 s inbound silence → close 1001 (sweep 30 s) |
| Host-data open timeout | 15 s |
| Relay control grace | ~30 s data-leg survival during control re-registration (host keeps data sockets up; worker keeps client legs) |

Liveness is **inbound-only** everywhere (client keepalive, host control
pings, idle reaper, dev probes). Terminal retained-error behavior is what
makes "relay auth failed" show as an immediate actionable state instead of
a silent loop.

## 3.12 Host lifecycle: demand-driven relay, machine claim

src: `relay/service.js`, `relay/host-lock.js`, server wiring
`index.js:1860-1904, 2038-2050`, and reconciliations in pairing/revocation
routes.

The relay host is **never** a remembered switch to babysit:

- **Demand signals:** any still-redeemable pairing session with
  `usesRelay === true` (`pairing.js:hasActiveRelaySession`) OR any
  non-revoked non-expired paired device with `usesRelay === true` or
  observed `lastTransport === 'relay'`
  (`remote-clients.js:hasActiveRelayClients`).
- **Reconcile** (`relayService.reconcile()`): demand true → persist
  `settings.privateRelay.enabled = true` and start the host; demand false
  → persist `enabled = false` and stop. Sources: server startup, pairing
  create/cancel/redeem, device revoke/purge, and a **60 s poll** — a
  headless CLI `connect-url --relay` writes a session straight to the
  on-disk store and pending sessions expire without any server request,
  so the poll is what keeps headless instances within a minute of the
  demand truth.
- Store-read failure must never fake "no demand": reconcile uses
  `Promise.allSettled`; any affirmative answer wins; a failed check
  **throws** to abort reconcile rather than severing live relay devices.
- Config: `settings.privateRelay = {enabled, relayUrl}`. Routes below
  (§3.15) sit behind the global UI auth gate.
- **Pairing turns the relay on:** creating a relay-carrying pairing link
  calls `ensureEnabledForPairing()` — writes `enabled: true` if needed,
  starts the host with a **force-claim**, and returns the candidate. A
  plain (non-relay) link only advertises relay when it is already enabled
  (legacy behavior). A pending **or** redeemed relay session keeps the
  host up; revoking the last relay-paired device (or the session
  expiring) turns it off via reconcile.
- **Machine claim** (`createRelayHostLock`, file
  `<data-dir>/relay-host.lock` = `{pid, claimedAt}`): all instances
  sharing the data dir share the identity (`serverId`), so two relay
  hosts would evict each other at the worker (4001 loop) and drop paired
  devices onto a random instance — often a dev instance running different
  code. Rules:
  - `tryClaim()` — claim only when there is no **live** claimant
    (`process.kill(pid,0)`; `ESRCH` = stale, ignored; `EPERM` = alive
    foreign user, treated as alive).
  - `forceClaim()` — unconditional; used by explicit enable and pairing
    creation ("the instance the user is interacting with MUST be the one
    devices reach"); the displaced holder's watcher sees the takeover and
    stands down instead of fighting.
  - Claim watcher (30 s cadence, active while enabled): a running host
    that discovers another live claimant **stops and goes standby** (the
    back-off is what ends the replace/reconnect fight; the loser must
    STOP reconnecting); a standby instance takes over a freed claim only
    after a **120 s grace** (`CLAIM_TAKEOVER_GRACE_MS`) — a cleanly
    restarting host reclaims at boot with no wait, so it always wins the
    restart window (app update/relaunch) over bystanders.
  - `release()` deletes only the owner's own claim file.
  - Claim writing failure logs a warning and behaves pre-lock (host
    starts; the worker arbitrates).
  - Reclaiming one's own live claim is a no-op refresh.
- **Passive-host hold-out:** `allowPassiveHost = false` — via env
  `OPENCHAMBER_RELAY_HOST=off`, or the Electron dev shell
  (`OPENCHAMBER_ELECTRON_DEV=1`); `OPENCHAMBER_RELAY_HOST=on` overrides
  both — makes the instance never host on boot/demand/watcher takeover;
  only explicit enable/pairing hosts there. Dev instances sharing the
  data dir must not capture paired devices from the production instance.
  A held instance reports a standby-style state with an explanatory
  `lastError`.
- **Status** (`getStatus()`): `{enabled, state (disabled|connecting|
  connected|reconnecting|standby), serverId, connectedClients,
  relayUrl, relayUrlLocked, lastError?}`. `connectedClients` is the live
  count of host-data legs (honest after idle reaping). `standby` +
  `lastError` "relay host is owned by another local OpenChamber process
  (pid N)" is the multi-instance signature.

## 3.13 Pairing candidate and candidate refresh

- The relay candidate (§5.2) is `{type:'relay', relayUrl, serverId,
  hostEncPubJwk, [grant], priority:30}` — no embedded token; the client
  redeems the one-time pairing secret **through** the tunnel like any
  other candidate (this is the property that kills the v1 design, which
  embedded a long-lived token in QR text). `getPairingCandidate()` returns
  null when the host relay is off, so relay is only advertised when
  reachable; `ensureEnabledForPairing()` turns it on (§3.12).
- **Snapshot vs refresh:** pairing-payload candidates are a snapshot; when
  DHCP hands the host a new LAN address an already-paired device's saved
  direct candidate goes stale and the device would silently degrade to
  relay-only. An already-paired client calls
  `GET /api/client-auth/connection/candidates` (UI session **or** client
  bearer; registered with the auth/access routes, **never**
  URL-token-authorized) over any live transport — including through the
  tunnel — and receives
  `{label, serverId?, candidates:[{type:'lan', url, priority:10}, (relay
  candidate when enabled)]}` where LAN URLs come from the client-reached
  address first, then the interface scan.
- **Identity gating on refresh:** the client ignores a refresh whose
  `serverId` does not match its pinned relay identity (old servers
  without `serverId` are ignored too), and verifies `/health`'s
  `serverId` on a **learned** address **before** sending its bearer token
  there — a re-assigned LAN address may now belong to a different machine.
- Consumers: mobile `apps/mobileConnections.ts` (doc 11) and desktop
  `desktopRelayRestore.ts` (§6.4). An **empty** LAN list (loopback-only
  bind / scan failure) must *not* erase a stored address — a stale one
  only costs one fast failed probe on the next start.

## 3.14 Self-reported app diagnostics

Optional query params on all three relay connection kinds (host-control,
host-data, client): `appId` (always `openchamber`), `appVersion`
(client: shared UI package version; host: web-server package version),
`platform` (client: `desktop|vscode|ios|android|web` presence values;
host: `OPENCHAMBER_RUNTIME`, default `web`, so ssh-hosted servers report
`ssh-remote`).

- Labels describe the *connecting process*, never its remote target.
- They sit **outside** the signed auth payload: the worker groups
  missing/invalid as `unknown`; analytics count host-control and client
  connections separately (including reconnects), exclude host-data, and
  treat labels as self-reported, never as verified app identity.
- Added at connection time only; no per-app traffic counters; never any
  credentials, device names, or app contents. Older relays ignore them;
  older apps remain connectable (fields are optional).

## 3.15 Host-side management routes

Registered by `service.registerRoutes(app)`; full route rows in doc 03
§5.35 (all behind the global UI auth gate):

| Route | Body | Behavior |
| --- | --- | --- |
| `GET /api/openchamber/relay/status` | — | §3.12 status shape; 500 on failure |
| `POST /api/openchamber/relay/enable` | `{relayUrl?}` (JSON, 16 KB limit) | normalizes the URL (ws/wss, default otherwise), persists `enabled:true`, restarts the host with **force-claim**, returns status |
| `POST /api/openchamber/relay/disable` | — | persists `enabled:false`, stops host + watcher, returns status |

There is no pairing-specific relay route: pairing goes through
`/api/client-auth/*` (§5.5) and the relay candidate comes back embedded in
the pairing response.

## 3.16 Security properties (what the relay can and cannot do)

- The relay (and anyone on its path) sees only routing metadata — `serverId`,
  connection ids, timestamps, coarse counts — and opaque ciphertext; never
  prompts, code, tokens, or cookies. It is an untrusted transport, not a trusted
  middlebox.
- Only devices holding a token issued by *your* server can connect; the relay
  exposes nothing to discovery (clients must already know `serverId`), and a
  leaked pairing link is worthless after redemption or expiry (§5.1/§5.4).
- Nothing runs until opt-in: the demand lifecycle (§3.12) keeps the relay off
  until a relay pairing exists or a paired device returns through it;
  disabling severs reachability immediately.
- The trust anchor is out-of-band: the pinned `hostEncPubJwk` is what makes a
  MITM at the worker unable to derive session keys — it can answer `ready`,
  but keys mismatch and traffic fails at decrypt (1011), fail closed, never
  downgrade. Replay is impossible by construction: fresh nonce + fresh
  keypair per connection, direction-bound counters, regressions fail closed.
- The host never trusts client-supplied origin metadata (it stamps the
  loopback origin it actually dials) and never injects credentials; the relay
  grants reachability only — every tunneled request is authenticated like
  any remote client's.
- Adding relay support to a feature must not require knowing the relay
  exists — everything goes through the shared runtime transport helpers
  (§3.10). Transparent-to-the-app is an invariant, not a nicety.

---

# 4. Tunnels specification

Inbound public-URL tunnels, for the cases pairing cannot cover (ordinary
browsers on machines you cannot pair, shared access behind the UI password).
Modules: `packages/web/server/lib/tunnels/*` plus
`packages/web/server/lib/cloudflare-tunnel.js` and `ngrok-tunnel.js`
(the underlying process drivers). CLI tunnel commands and the startup
service are doc 03's.

## 4.1 Provider and mode matrix

| Provider | Mode | Intent | Requires | Stability | Notes |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | `quick` | `ephemeral-public` | — | ga | `cloudflared tunnel --url http://127.0.0.1:<port>`; random `*.trycloudflare.com` URL; dies with the process |
| `cloudflare` | `managed-remote` | `persistent-public` | `token`, `hostname` | ga | `cloudflared tunnel run --token-file <f>`; public URL `https://<hostname>` |
| `cloudflare` | `managed-local` | `persistent-public` | (config file; hostname from config or arg) | ga | `cloudflared --config <path> tunnel run`; hostname from ingress config or `--hostname` |
| `ngrok` | `quick` | `ephemeral-public` | ngrok binary + authtoken | beta | `ngrok http --log=stdout --log-format=json 127.0.0.1:<port>` |

Capabilities live in each provider object
(`cloudflareTunnelProviderCapabilities`,
`ngrokTunnelProviderCapabilities`); each mode entry is
`{key, label, intent, requires[], supports[], stability}` (cloudflare
supports: quick `['sessionTTL']`, managed-remote
`['customDomain','sessionTTL']`, managed-local
`['configFile','customDomain','sessionTTL']`).

Fallbacks: unknown/blank `mode` ⇒ `quick`; unknown/blank provider ⇒
`cloudflare`. Mode→intent defaults: quick → `ephemeral-public`;
managed-* → `persistent-public`. A request carrying an `intent` must match
its mode descriptor's intent; a `private-network` intent is a supported
string only (no provider emits it).

## 4.2 Start request shape and validation

`normalizeTunnelStartRequest(input, defaults)` produces:

```jsonc
{
  "provider": "cloudflare" | "ngrok",
  "mode": "quick" | "managed-remote" | "managed-local",
  "intent": "ephemeral-public" | "persistent-public" | "private-network",
  "configPath": "<absolute path inside user home | null>",
  "token": "<cloudflared run token (managed-remote)>",
  "hostname": "<lower-case normalized hostname>"
}
```

- `configPath` accepts `~`, `~/relative`, or absolute paths; **must
  resolve inside the user's home directory** (`resolveTunnelConfigPath`;
  case-insensitive compare on win32) — otherwise `validation_error`.
- `hostname`: bare host or `https://host` accepted; normalized to
  lowercase hostname; wildcards (`*`) and empties are rejected.
- `token`: whitespace inside = invalid ("provide the raw token value").
- Validation errors are `TunnelServiceError` with codes
  `validation_error | provider_unsupported | mode_unsupported |
  missing_dependency | startup_failed` (mapped to 400/422/500 in routes).
- Concurrency: `tunnelService.start` serializes through a promise mutex —
  concurrent starts cannot orphan child processes.
- **One active tunnel per instance invariant:** on start, if an active
  controller exists with a different provider or mode (or whose public
  URL cannot resolve) the previous controller is stopped first; there is
  exactly one controller and one `publicUrl` at any time. An active
  *same* configuration is reused instead of restarted.

## 4.3 Provider implementations

### cloudflared quick (`startCloudflareQuickTunnel`)

- Verify presence quickly (`resolveExecutableLaunchTarget('cloudflared')`
  + `spawnSync --version`; executable search incl. Windows Store aliases
  — details cross-ref doc 03 CLI tooling).
- Spawn `cloudflared tunnel --url http://127.0.0.1:<port>` with `HOME`
  pointed at a fresh temp dir (isolates the user's real `~/.cloudflared`),
  env `CF_TELEMETRY_DISABLE=1`, `windowsHide`, kill signal `SIGINT`.
- Public URL parsed from stdout+stderr with
  `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i`; 30 s timeout ⇒ kill +
  temp-dir cleanup + error "Tunnel URL not received within 30 seconds".
- Controller: `{mode:'quick', stop(){kill SIGINT; rm temp dir}, process,
  getPublicUrl}`. Quick-tunnel warning surfaced to the operator: provider
  limits may apply; URLs are temporary; **password protection required**
  for tunnel access.

### cloudflared managed-remote (`startCloudflareManagedRemoteTunnel`)

- Requires non-empty `token` (no internal whitespace) and `hostname`.
- Token handling: written to a temp file (`openchamber-cf-token-*`,
  file mode 0o600) when no explicit `tokenFilePath` is given; the child
  gets `tunnel run --token-file <path>` — a run token never goes on the
  command line.
- stdout is drained **without logging** (may contain sensitive lines);
  stderr is mirrored to the process stderr.
- Public URL is `https://<hostname>` (no DNS pre-check; cloudflared
  failures surface via the readiness wait).
- Readiness wait (`waitForManagedTunnelReady`): resolve on any line
  matching the ready patterns; reject on fatal patterns or child exit;
  liveness fallback at 6 s if any output was seen; hard failure at 20 s.
  - `READY_LOG_PATTERNS`: `/registered tunnel connection/i`,
    `/connection[^\n]*registered/i`, `/starting metrics server/i`,
    `/connected to edge/i`.
  - `FATAL_LOG_PATTERNS`: `/error parsing.*config/i`,
    `/failed to .*config/i`, `/invalid token/i`, `/unauthorized/i`,
    `/credentials file .* not found/i`,
    `/provided tunnel credentials are invalid/i`.
- On failure the child is killed and the temp token dir removed; the
  temp dir is also removed on child error/exit.
- Controller: `{mode:'managed-remote', stop, process, getPublicUrl}`.

### cloudflared managed-local (`startCloudflareManagedLocalTunnel`)

- Config file: the requested path, else the default
  `~/.cloudflared/config.yml`. Guarded reads (`assertReadableFile`):
  must exist, be a file, extension `.yml/.yaml/.json`, non-empty, ≤
  256 KiB (`MANAGED_LOCAL_CONFIG_MAX_BYTES`), readable.
- Hostname resolution: explicit `hostname` argument first; otherwise the
  first `ingress[].hostname` in the parsed YAML (`yaml.parse`; parse
  failure is an explicit error). Missing both ⇒ error naming both fix
  paths ("use --hostname or add an ingress hostname to the config").
- Args: `['tunnel', ('--config', path), 'run']` (the `--config` flag only
  when a path was requested — the default config is picked up by
  cloudflared itself).
- Same spawn/readiness/stop contract as managed-remote. Controller adds
  `getResolvedHostname` and `getEffectiveConfigPath`.

### ngrok quick (`startNgrokQuickTunnel`)

- Checks: binary present; authtoken configured — `NGROK_AUTHTOKEN` env
  first, else `ngrok config check` (failure detail includes the
  remediation `ngrok config add-authtoken <your-ngrok-token>`);
  `https://api.ngrok.com/` reachable (5 s timeout).
- Spawn `ngrok http --log=stdout --log-format=json 127.0.0.1:<port>`; the
  public URL is parsed from stdout (JSON lines carrying `url` /
  `public_url`; regex fallback for non-JSON lines) **and** polled every
  250 ms from the local ngrok API `http://127.0.0.1:4040/api/tunnels`
  (preferred https proto tunnel first) as a second source.
- URL validation requires `https:` and a hostname containing `ngrok`
  (`normalizeNgrokPublicUrl`); trailing slash stripped.
- 30 s timeout kills the child. Failures summarize recent log lines
 (`summarizeNgrokOutput`: last error-level JSON `err` excluding
  `context canceled`, then failure-ish `msg`, then `ERROR:` lines (up to
  4), then the last line) into the thrown error text — the CLI surfaces
  that summary.
- Controller: `{mode:'quick', stop(){SIGINT}, process, getPublicUrl}`.

## 4.4 Managed remote profile store

src: `tunnels/managed-config.js`. File:
`<data-dir>/cloudflare-managed-remote-tunnels.json` (migrated from legacy
`cloudflare-named-tunnels.json` on first read; `version: 1`; write
mode 0o600; a single promise-locked writer serializes updates).

```jsonc
{
  "version": 1,
  "tunnels": [
    { "id": "<preset id or hostname>", "name": "…",
      "hostname": "tunnel.example.com",
      "token": "<cloudflared run token>",
      "updatedAt": 1726300000000 }
  ]
}
```

- Sanitization on every read/write: entries need id, name, hostname,
  token; hostname normalized (no wildcard); dedupe by id **and** by
  hostname (first wins).
- `upsertManagedRemoteTunnelToken({id, name, hostname, token})` removes
  entries conflicting with the new id *or* hostname, then appends.
- `syncManagedRemoteTunnelConfigWithPresets(presets)` keeps only tunnels
  whose id or hostname matches a preset (used when managed presets are
  imported; the settings/preset plumbing itself is doc 14's).
- `resolveManagedRemoteTunnelToken({presetId, hostname})` — by preset id,
  then by hostname, else `''`.
- Token precedence at start time (routes' resolution order):
  request body `token` → `tunnelToken` → `managedRemoteTunnelToken` →
  runtime token whose hostname matches → **profile store**
  (`presetId` then `hostname`) → settings `managedRemoteTunnelToken`.
  Tokens are never logged (§12.1).
- CLI parity: `hasSavedManagedRemoteProfile` can also come from the CLI as
  a query flag (`1`) when the CLI knows its own saved profile, so doctor
  checks pass without shipping tokens through query strings.

## 4.5 Tunnel-gated auth (bootstrap token + tunnel session)

src: `packages/web/server/lib/opencode/tunnel-auth.js`.

Model: the private relay needs no server-side "tunnel guest" credential
because devices carry tokens; a *tunnel* may be reached by arbitrary
browsers, so visitors need a one-time ticket and everything else stays
locked.

- `setActiveTunnel({tunnelId, publicUrl, mode})` — records the active
  `tunnelId` (uuid), mode, and the normalized **host** of the public URL
  (used by scope classification, §2.9).
- `issueBootstrapToken({ttlMs})` — requires an active tunnel and
  **revokes the previous token first** (only the newest connect link
  works). Token = 32 B base64url; record
  `{id: uuid, tunnelId, tokenHash: sha256(token) hex, issuedAt, expiresAt
  (null = no expiry), usedAt: null, revokedAt: null}`.
- TTLs (settings): bootstrap `tunnelBootstrapTtlMs` default 30 min,
  clamp 1 min–24 h, explicit `null` disables expiry; session
  `tunnelSessionTtlMs` default 8 h, clamp 5 min–30 d
  (server `index.js:140-145`, settings normalization runtime).
- Connect link: `GET <publicUrl>/connect?t=<token>`
  (src: `core-routes.js:933-960`):
  1. rate limit: 20 attempts / 5 min per IP (5 with no IP), 10 min lock
     (`CONNECT_RATE_LIMIT_*`).
  2. one-time exchange: sha256 compare with `timingSafeEqual`; token
     unused/unrevoked/unexpired; `bootstrapRecord.tunnelId` must equal the
     active tunnel id.
  3. failure ⇒ `401 text "Connection link is invalid or expired."`
     (rate-limited ⇒ `429` + `Retry-After`).
  4. success ⇒ mint session `{sessionId: 32B base64url, tunnelId, mode,
     publicUrl, createdAt, lastSeenAt, expiresAt, revokedAt, revokedReason,
     expiredAt}`, set cookie
     `oc_tunnel_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=…;
     Secure?`, mark the bootstrap token `usedAt`, then `302 → /`.
  `Cache-Control: no-store` on the connect route always.
- Cookie `SameSite=Lax` here (the UI session cookie uses Strict) so the
  top-level `/connect?t=…` redirect navigation carries the cookie in one
  hop.
- `getTunnelSessionFromRequest`: cookie → session map; revoked/expired/
  wrong-tunnel all reject; `lastSeenAt` refresh on hit.
- `requireTunnelSession` guards the `/api` gate at tunnel scope (§2.9).
- Invalidation on stop/replace: §4.7.
- The tunnel session grants exactly the *local-anonymous* level of the
  instance (the same `/api` gate a cookie session receives) and nothing
  above: password/passkey/pairing/reset endpoints are scope-blocked, so a
  visitor cannot escalate by re-running login flows.

## 4.6 Tunnel HTTP API summary

All registered in `tunnels/routes.js`, inside the global UI auth gate; the
complete route table lives in doc 03 §5.34. Semantics owners:

| Route | Purpose / notes |
| --- | --- |
| `GET /api/openchamber/tunnel/check?provider=` | dependency availability: `available, provider, version, dependency, installCommand, installUrl, platform, message`; install hints per platform (§4.3 install metadata: cloudflared brew/winget/download; ngrok brew/winget-store/download) |
| `POST|GET /api/openchamber/tunnel/doctor` | per-provider diagnostics: providerChecks + per-mode checks + blockers; request may carry `configPath`/`hostname`/`tokenProvided` flags; POST body never echoed; saved-profile presence (server store + CLI flag) satisfies token prerequisites |
| `GET /api/openchamber/tunnel/providers` | capability registry listing |
| `GET /api/openchamber/tunnel/status` | full status (§ shape below); lazily re-syncs the active tunnel record when the live URL/mode changed; answers inactive with `policy:'tunnel-gated'`, `hasBootstrapToken:false` |
| `PUT /api/openchamber/tunnel/managed-remote-token` | upsert profile token (requires `presetId`, `presetName`, `managedRemoteTunnelHostname`, `managedRemoteTunnelToken`); answers `managedRemoteTunnelTokenPresetIds` |
| `POST /api/openchamber/tunnel/start` | normalized start (§4.2); issues a fresh bootstrap token; builds `<url>/connect?t=…`; reports replacement info |
| `POST /api/openchamber/tunnel/stop` | revoke artifacts for the active tunnel, stop the controller, clear the active tunnel; answers `revokedBootstrapCount` + `invalidatedSessionCount` |

Status shape (active):

```jsonc
{ "active": true, "url": "https://tunnel…", "mode": "quick",
  "provider": "cloudflare", "providerMetadata": {"configPath": null, "resolvedHostname": null},
  "hasManagedRemoteTunnelToken": true,
  "managedRemoteTunnelHostname": null,
  "managedRemoteTunnelPresets": [{"id","name","hostname"}],
  "managedRemoteTunnelTokenPresetIds": ["…"],
  "hasBootstrapToken": true, "bootstrapExpiresAt": 1726…,
  "policy": "tunnel-gated", "activeTunnelMode": "quick",
  "activeSessions": [ {"sessionId","tunnelId","mode","publicUrl","createdAt",
    "lastSeenAt","expiresAt","revokedAt","status","inactiveReason"} ],
  "localPort": 3000,
  "ttlConfig": {"bootstrapTtlMs": 1800000, "sessionTtlMs": 28800000} }
```

## 4.7 Start/stop/replace lifecycle and invalidation

- `POST /tunnel/start` records `previousTunnelId/mode/provider/url`;
  after a successful start, replacement = provider OR mode OR URL
  changed. On replacement:
  `tunnelAuthController.revokeTunnelArtifacts(previousTunnelId)` revokes
  that tunnel's bootstrap token (newest-only scheme means the newest link
  already wins, but the explicit call guarantees it) and marks every
  non-revoked session bound to that `tunnelId` revoked with reason
  `'tunnel-revoked'` — **old visitors are cut off immediately**. The
  response reports `replacedTunnel`, `replaced {mode, provider, url}`,
  `revokedBootstrapCount`, `invalidatedSessionCount`.
- A **new** `tunnelId` is generated on replacement/first start; the same
  id persists across idempotent re-starts (same provider+mode+url), so
  sessions survive them.
- Start failure path: controller cleared, active tunnel cleared, tunnel
  artifacts for the *previous* id are **not** revoked (the previous
  tunnel keeps running as-is).
- `POST /tunnel/stop`: revoke artifacts for the active id, stop the
  provider controller (SIGINT semantics per provider), `clearActiveTunnel()`
  (which revokes + nulls everything). Retained even when no controller is
  registered (e.g. it died) so sessions are still invalidated.
- Startup tunnel (doc 03 §1.3): CLI flags produce a
  `startupTunnelRequest` — on listen success the startup pipeline starts
  the tunnel, sets the active tunnel, issues the bootstrap token, prints
  `https://…/connect?t=…` ("One-time connect link — expires after first
  use"), or hands it to `onTunnelReady` (desktop). Failures degrade to no
  tunnel and never abort the server.
- Desktop import of a connect link (§6.4) passes the same `?t=` to its
  embedded browser session, so desktop/remote windows acquire the tunnel
  session cookie exactly like a browser.
- `--tunnel-skip-browser-warning` style edges: ngrok preview URLs behind
  nginx get an extra preflight header allowlisted in CORS
  (`Ngrok-Skip-Browser-Warning`, `index.js:1701-1705`).

---

# 5. Pairing and connect links

Pairing = a one-time, expiring, revocable grant that turns a device into a
token-bearing client. The *link format* is `openchamber://connect?...`.
Pairing-v2 replaced v1 `?v=1&server=…&token=…` links — both parsers reject
any `v ≠ 2`.

## 5.1 Link format (exact)

```
openchamber://connect?v=2&p=<base64url(UTF-8 JSON payload)>
```

- `p` is base64url (unpadded, `+→-`, `/→_`) of the JSON
  `PairingConnectionPayload` (§5.2). No other query keys exist; unknown
  keys are ignored by both parsers.
- Size bound: `MAX_PAIRING_PAYLOAD_LENGTH = 16 384` characters — applied
  to the whole link, to `p`, and to the decoded JSON; any oversize ⇒
  reject.
- Parsing rules (src: `packages/ui/src/lib/connectionPayload.ts`):
  - `parsePairingConnectionPayload(value)` — `new URL()`-based: requires
    protocol `openchamber:`, `hostname === 'connect'`,
    `v === '2'`, non-empty `p`.
  - `parsePairingConnectionPayloadString(value)` — regex fallback for
    old Android WebViews where `new URL('openchamber://…')` yields
    hostname `""` and pathname `"//connect"` for perfectly valid links:
    matches the head `/^openchamber:\/\/connect\/?$/i`, then reads `v`
    and `p` directly off the query string (split on `&`, key=value),
    order-independent, trailing slash tolerated, case-insensitive head.
    Used by the Android scan path only after the standard parse fails —
    it keeps every validation (version, length, base64url, candidate
    normalization).
  - Both share `normalizePairingPayload`, which enforces: `v === 2`
    (integer), non-empty trimmed `pairingId` and `secret`, ≥ 1 valid
    candidate, and — when present — `expiresAt` must parse to a
    **future** time (past or unparsable ⇒ the whole payload is invalid);
    `label` / `fingerprint` optional non-empty strings.
- Whitespace is trimmed on the input string before parsing.
- OS-level `openchamber://` deep-link registration is doc 09's surface
  (desktop) and doc 11's (mobile intent handling); every client converges
  on these two parsers.

## 5.2 Payload fields (table)

```jsonc
// PairingConnectionPayload (v2)
{
  "v": 2,
  "pairingId": "pair_<24 hex chars>",        // server-minted id: "pair_" + 12 random bytes hex
  "secret": "<base64url, 43 chars>",         // 32 random bytes; the ONE-TIME redeem credential
  "label": "atlas",                          // issuing SERVER's name (machine hostname):
                                             //   the paired device names its connection by this.
                                             //   NOT the operator's typed device name.
  "fingerprint": "AB3F-00C1",                // 4B hex, uppercase, "XXXX-XXXX" — visual match aid
  "expiresAt": "2026-09-14T12:00:00.000Z",   // ISO; must be future at scan time
  "candidates": [ /* >= 1; fallback transport list, ordered by priority */ ]
}
```

Candidate union (discriminated by `type`):

| type | fields | normalizer behavior |
| --- | --- | --- |
| `lan` | `url` (http/https), `priority?` (finite number) | strips hash; strips any trailing "/" run; rejects non-http(s) |
| `tunnel` | `url` (https public tunnel URL), `priority?` | same as `lan` |
| `relay` | `relayUrl` (ws/wss — **keeps its path**, e.g. `/ws`), `serverId`, `hostEncPubJwk`, `grant?`, `priority?` | ws/wss protocols only (hash stripped, trailing path preserved); `serverId` trimmed non-empty; JWK strict-normalized to `{kty:'EC',crv:'P-256',x,y}` — other curves, missing x/y, or any private member (`d`) rejected; `grant` kept only when non-empty; relay candidates never produce an `url` field |

Canonical priorities used by the server: direct (primary) `10`; the
creator's browsing origin as an extra direct candidate `20`; relay `30`
(last resort). Clients race candidates §5.7 regardless; `priority` is
advisory ordering.

Encoders: `buildPairingConnectionPayload(input)` trims + assembles the
payload; `encodePairingConnectionPayload(payload)` normalizes (throws
"Invalid pairing connection payload" when invalid) and emits the link
string. The CLI mirrors the encoder byte-for-byte (`v=2&p=<b64url>`), see
§5.9.

## 5.3 Payload version semantics

- `v: 2` is the only accepted value. v1 links (`?v=1&server=…&token=…`)
  embedded a long-lived token in QR text and browser history — that is
  the "v1 sin" the format replaces; both parsers reject them, and so
  must a clean-room implementation, forever.
- Unknown *candidate shapes* invalidate the payload rather than being
  best-effort (a partially understood link is worse than a rejected
  one — the redeem would otherwise succeed over an unintended transport).
- `grant` is forward plumbing for relay-side admission control (per
  device / traffic): ignored by the v1 relay worker, never persisted by
  clients, passed as a WS query param for that connection's life only
  (§3.3).
- `expiresAt` mirrors the server session's expiry so a scanner can refuse
  redemption of a stale link without a pointless network round-trip (and
  without ever leaking whether the server still has the session).

## 5.4 Server-side pairing session store

src: `packages/web/server/lib/client-auth/pairing.js` — store
`<data-dir>/client-pairing-sessions.json` (`version: 1`; writes 0o600
into a 0o700 dir; all mutations serialized via a promise queue
`withStoreMutation`).

Session record:

```jsonc
{
  "id": "pair_…",
  "secretHash": "<sha256(secret) hex>",       // plaintext secret never stored
  "createdAt": "ISO", "expiresAt": "ISO",     // DEFAULT_TTL_MS = 10 min
  "usedAt": null, "cancelledAt": null,
  "clientId": null,                            // set on redeem
  "label": null,                               // operator's typed device name (<= 80 chars);
                                               //   null = unset. "Pair new device" is only a
                                               //   DISPLAY placeholder — never persisted.
  "fingerprint": "AB3F-00C1",
  "allowedClientKinds": ["mobile","desktop"],
  "createdByClientId": null,                   // which client token created it (null for UI session)
  "usesRelay": false                           // true when the link carries a relay candidate
}
```

Generation constants: `PAIRING_ID_PREFIX 'pair_'` + 12 B hex; secret
32 B base64url; fingerprint 4 B hex uppercase formatted `XXXX-XXXX`;
TTL 10 min.

Operations:

- `createPairingSession({label, allowedClientKinds, createdByClientId,
  usesRelay})` — sweeps expired sessions then appends; returns the
  **one-time** view `{pairing: {…, secret}}`. The plaintext secret
  exists only inside this return value and inside the link; every
  response that could carry it is `Cache-Control: no-store`.
- `listPendingSessions()` — pending = not used ∧ not cancelled ∧ not
  expired. **No secrets included** (public view strips `secretHash`
  too); feeds the "pending devices" list.
- `hasActiveRelaySession()` — any pending session with `usesRelay`
  (relay-demand signal, §3.12).
- `getPairingSession(id)` / `cancelPairingSession(id)` (idempotent
  `cancelledAt` stamp; returns `{cancelled, pairing}`).
- `redeemPairingSession({pairingId, secret, clientLabel, clientKind,
  deviceName, devicePlatform, deviceModel, appVersion, dedupeKey})`:
  1. normalize id/secret (`clientKind` default `'mobile'`).
  2. locate the session; reject when missing, cancelled, used, or
     expired — **all raise the identical generic error**
     `'Invalid or expired pairing session'` (status 400). Undertaking:
     existence, clock and kind must be indistinguishable to an attacker
     who cannot compute the secret hash anyway.
  3. `clientKind` must be in `allowedClientKinds`, else the same error.
  4. constant-time compare `sha256(secret)` against `secretHash`.
  5. mint the device token via
     `createClient({authMethod:'pairing', pairingId: session.id,
     dedupeKey: dedupeKey || `pairing:${session.id}`,
     label: session.label, fallbackLabel: clientLabel || deviceName ||
     'Remote client', clientKind, usesRelay: session.usesRelay, …})`.
     Label precedence (server): operator's typed pairing label wins
     outright; on re-pair with the same dedupeKey the replaced record's
     label survives a rescan that carries no typed name (§2.7).
  6. If token creation throws, the pairing session is **not**
     consumed (`usedAt`/`cancelledAt` untouched) — a crashed mint can be
     retried with the same link.
  7. On success stamp `usedAt` + `clientId`; return
     `{pairing, client, token}`.
- Sweeping: used/cancelled sessions are retained until
  `inactiveAt + ttl` so the pending list stays auditable; unredeemed
  sessions drop once expired.
- The generic error string is a contract — redeem must never disclose
  which part was wrong; the route 429s with the same string.

## 5.5 Pairing session HTTP API

Doc 03 §5.3 owns the route table; semantics:

| Route | Auth | Notes |
| --- | --- | --- |
| `POST /api/client-auth/pairing/sessions` | UI session **or** `desktop-local` client token | body `{label?, allowedClientKinds?, serverUrl?, includeRelay?, includeDirect?}`; builds candidates (§5.7 below); `usesRelay` = any relay candidate; response `201 {pairing:{id,label?,fingerprint,expiresAt,secret}, server:{label, candidates}}`; `no-store` |
| `GET /api/client-auth/pairing/sessions` | same | pending list (**no secrets**), `no-store` |
| `DELETE /api/client-auth/pairing/sessions/:id` | same | cancel; `reconcileRelay()` fired after; 404 when unknown/already gone |
| `POST /api/client-auth/pairing/redeem` | **anonymous** (rate-limited) | §5.6 |
| `GET /api/client-auth/connection/candidates` | UI session or client bearer; never the URL token | refresh payload `{label, serverId?, candidates}` (§3.13) |
| `GET /api/client-auth/pairing/transports` | UI session or `desktop-local` | `{local, lan, relayAvailable}` — LAN derived from the **server bind**, not the UI origin (§6.1 step 2) |

Redeem rate limit (src: `core-routes.js:381-408, 484-512, 888-931`):
10 attempts / 5 min keyed by
`socketRemoteAddress:pairingId` — the raw socket address, deliberately
*not* `req.ip` because the redeem is unauthenticated and the proxy must
not be able to widen the bucket. `429` uses the generic error text and
`Retry-After`; a successful redeem clears the entanglement (rate limit
bucket). Every response is `no-store`.

Redeem response (success):

```jsonc
{ "ok": true,
  "server": { "label": "<server hostname>", "url": "<request origin>",
              "fingerprint": "AB3F-00C1" },   // fingerprint may be null
  "client": { /* full public device record (§2.7) */ },
  "clientToken": "oc_client_…" }              // plaintext, exactly once
```

Candidate construction (`pairingServerCandidates`): the direct candidate
is the caller-supplied `preferredServerUrl` (the desktop UI reaches its
server over loopback, so it passes the LAN URL) else the request origin.
An additional direct candidate is the *origin the creator is browsing
over* when it differs from the preferred one and is not loopback — e.g. a
public https domain in front of a reverse proxy, so the device can use
that same domain rather than relying on LAN hairpin or relay. Loopback
origins are never advertised. The relay candidate is appended only when
`includeRelay !== false` (requesting it with `includeRelay: true`
*enables* the relay host on demand — locking §3.12 in force).

## 5.6 Redemption (numbered flow)

1. **Scan/input** (mobile QrScan, desktop Import Link, or CLI output) —
   the payload exists only on-screen/in memory.
2. **Build the redeem body once**, identical across transports:
   `{pairingId, secret, clientLabel, clientKind, deviceName,
   devicePlatform, [deviceModel], [appVersion], [dedupeKey]}`.
   - `clientKind`: `'mobile'` on mobile; `'desktop'` on desktop import.
   - `clientLabel`: the device's own reported name (fallback for the
     record label).
   - `dedupeKey` conventions: mobile `mobile:<deviceId>`; desktop
     `desktop:<installId>`; omitted ⇒ the server defaults to
     `pairing:<id>`, so a re-scanned link refreshes that one client
     record instead of duplicating.
3. **Order the candidates**: direct first (cheaper; no relay
   infrastructure needed), relay last — stable sort
   (`(a.type === 'relay') - …`), honoring `priority` where present.
4. **Direct candidates:** identity-gate when the payload has a relay leg
   (§5.7), then `fetch(<url>/api/client-auth/pairing/redeem)` — a plain
   cross-origin POST to the *advertised* URL (a user-visible link, not
   the active runtime).
5. **Relay candidates:** open a **throwaway** E2EE tunnel client
   `createRelayTunnelClient({relayUrl, serverId, hostEncPubJwk,
   grant?})`; `tunnel.fetch('/api/client-auth/pairing/redeem')`. The
   E2EE handshake already proves the host (only the real server can
   derive the session keys for the pinned JWK), so no separate `/health`
   round-trip is needed. Close the tunnel afterwards (success or not) —
   only steady-state switching adopts an open tunnel (§6.2).
6. First transport that returns an OK response yields
   `{clientToken, client, server}`; store the token per device rules
   (§12.3) and persist **every** transport the link carried — not just
   the answering one — as the connection/host record (multi-transport
   device, §6.4/§6.5).
7. All candidates failing ⇒ "unreachable"; nothing was consumed
   server-side. A `429` must surface as "try again later", never as a
   generic invalid-link message shaped as expiry.
8. The server marks the session `usedAt` **only after** client creation
   succeeds (§5.4 step 7); the record leaving the pending list is what
   closes the issuing dialog (§6.1 step 8).

## 5.7 Transport-candidate racing rules

- **Identity gating before credentialed traffic:** whenever a device
  carries a relay leg pinned to `serverId`, a *learned or unknown* direct
  address must be verified (`GET /health` → compare `serverId`) before
  sending its `oc_client_*` token or the pairing secret. This covers
  candidate refresh (§3.13), probes, and relay fallback. User-typed URLs
  are probed too, but the binding is strongest for machine-learned
  addresses — the security property is "never send a credential to an
  address you haven't proven belongs to the pinned server".
- **Racing economics (mobile, doc 11):** direct candidates get a 1.5 s
  headstart (`RELAY_RACE_HEADSTART_MS`) before relay takes over; a
  dead/stale direct candidate fails fast (2.5 s fast-probe budget) so the
  relay fallback starts promptly instead of serializing full timeouts.
  Relay connect timeout 15 s.
- **Desktop races** similarly at startup (§6.4, 1.5 s headstart).
- **Preference is advisory**; the redeem POST is safe against races
  because the server consumes the session exactly once — a losing
  duplicate redeem returns the generic error.
- A "needs-login" short-circuit (server answered but the token is
  missing/invalid) beats "unreachable" — a reachable server asking to
  log in must not be skipped over by further candidates.

## 5.8 QR generation

- UI (`RemoteInstancesPage.tsx`): `qrcode` npm —
  `QRCode.toDataURL(link, {width: 1024, margin: 2, errorCorrectionLevel:
  'L'})`. Error level **L** is deliberate: pairing payloads are dense
  (multiple candidates + the EC JWK), so resolution wins over error
  correction.
- CLI: `qrcode-terminal` (`generate(url, {small: true})`) for
  `connect-url --qr` and the tunnel start's printed link (doc 03 §CLI).
- QR contents are **exactly** the link string — no envelope, no extra
  data. Any device camera (or the mobile in-app scanner) hands the raw
  string to the payload parsers (§5.1).
- The QR is rendered inside the pairing dialog only; the PNG is transient
  React state, not a file; the link string is also copyable.

## 5.9 CLI `connect-url` outputs

src: `packages/web/bin/lib/commands-connect-url.js` (full CLI owned by
doc 03). Link-parity semantics a re-implementation must preserve:

- Ensures a server instance is running on the target port — discovering
  running instances first; auto-starts one when none matches (result
  reported as `autoStarted: true`).
- Server URL resolution order:
  1. explicit `--server` (normalized http/https; invalid ⇒ usage error);
  2. configured `--host` / `OPENCHAMBER_HOST` / the instance's stored
     host: full http(s) URLs pass through as *public server URLs* (a
     remote deploy behind a proxy); otherwise a concrete non-loopback
     host becomes `http://<host>:<port>`;
  3. wildcard bind (`0.0.0.0`, `::`) ⇒ detect the machine's LAN IPv4 →
     `http://<lan>:<port>` (source `lan-detected`);
  4. no LAN address detected ⇒ loopback fallback
     (`http://127.0.0.1:<port>`, source `loopback-fallback`).
- Candidate set: one direct candidate
  `{type: https ? 'tunnel' : 'lan', url: serverUrl, priority: 10}`, plus
  the relay candidate when `--relay` **or** the relay is already enabled
  (`settings.privateRelay.enabled`). Relay URL resolution mirrors the
  running host: `OPENCHAMBER_RELAY_URL` env → settings
  `privateRelay.relayUrl` → `wss://relay.openchamber.dev/ws`. The relay
  candidate (identity + candidate) is built from the same identity
  runtime the host uses — **the CLI can mint it while the server is
  stopped**, generating identity lazily against the shared settings file
  with the same atomic-write + strict-read guarantees.
- The pairing session is created **directly against the on-disk store**
  (same pairings runtime the server uses) with
  `usesRelay` set when the link carries a relay candidate — the host's
  60 s demand poll picks it up (§3.12); the live server serves the
  redeem.
- Output modes (shared CLI output engine, doc 03):
  - `--json`: `{serverUrl, connectUrl, pairingId, fingerprint,
    expiresAt, candidates, autoStarted}`;
  - `--quiet`: the connect link only (machine-readable consumers);
  - interactive: clack intro + link + `Server URL: …` + (when relay)
    `Relay fallback: <relayUrl>` + `[RELAY_STARTING] info` when `--relay`
    was requested but the host relay is not up yet ("A running instance
    starts it within a minute; a stopped instance starts it on next
    launch") + `Fingerprint: XXXX-XXXX` + LAN advisories
    (`[LAN_UNREACHABLE]` when the direct candidate is loopback — with
    `--relay` the link still works, just always through the relay; the
    message advises `--lan` or `--server`) + `--qr` renders the QR.
- The printed link is a normal pairing-v2 link: single-use, expiring
  (10 min), revocable from the pending list, beyond that identical to
  dialog links.

## 5.10 Pairing dialog scope & client-kind rules

`allowedClientKinds`: `['mobile','desktop']` from the create-device dialog; enforced at redeem (§5.4). `desktop-local` is a *separate* client kind for the shell ⇄ its own embedded server (§2.7) — never a pairing kind; minted by password login or `POST /api/client-auth/clients`, and it is the only client kind with remote device-management authority. The pairing vocabulary (device name vs server label, fingerprint display, pending vs revoked) maps to the doc 14 dialog description; what is security-structural lives in §5.4 + §12.4.

---

# 6. Connect flows per client (numbered)

## 6.0 Injection state (per-surface)

Shared runtime contract (doc 01 owns the switching matrix). The active
instance is described by:

```ts
{
  apiBaseUrl: string;        // '' or window origin in relay mode (virtual)
  clientToken?: string;      // oc_client_* bearer
  requestHeaders?: Record<string, string>;  // 'Authorization' filtered out
  runtimeKey: string;        // stable instance key ('local', 'host:<id>', mobile per-device)
  relay?: { relayUrl, serverId, hostEncPubJwk };  // presence activates the tunnel
}
```

- Window globals: `__OPENCHAMBER_API_BASE_URL__`, `__OPENCHAMBER_CLIENT_TOKEN__`,
  `__OPENCHAMBER_RUNTIME_HEADERS__`, `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop only). `switchRuntimeEndpoint(options)` (src: `runtime-switch.ts:149-188`) sets the globals, resets the bearer + extra headers, resolves the URL resolver, activates/deactivates the relay tunnel **before** the eager `/auth/url-token` mint (so the mint rides the tunnel), and emits *will-change* then *changed* events; `initializeRuntimeEndpoint` only sets a first value (no switch). VS Code skips the auth gate entirely (`skipAuth`) — its transport is the extension-host bridge (doc 10).
- The active relay descriptor is never rebuilt from a stale one: equality is byte-level (`relayUrl`, `serverId`, `grant`, canonical JWK JSON) so an equal re-activate reuses the live tunnel.

## 6.1 Device pairing via QR (mobile; UX detail in doc 11)

1. Desktop (or hosted UI) opens **Settings → Remote Instances → Connect
   to this server → Add a device**; it asks the server
   `GET /api/client-auth/pairing/transports`
   (`{local, lan, relayAvailable}`) — LAN reflects the server's actual
   bind, so "home network" works even when the UI is opened on localhost.
2. Operator enters a device label (this *server's* name for that device;
   unset keeps the stored label null so the redeem can fall back to the
   device's self report) and picks a scope:
   - **This computer only** → direct candidate = the loopback
     `local` URL; `includeRelay: false`.
   - **Home network only** → direct = `lan` URL; `includeRelay` on only
     when the "also allow the encrypted relay when away from home"
     fallback checkbox is on.
   - **Anywhere** (default) → relay on; carries the LAN candidate too
     while the fallback checkbox is on (relay preference, home-network
     first); otherwise `includeDirect: false` → relay-only link.
3. `POST /api/client-auth/pairing/sessions {label, allowedClientKinds:
   ['mobile','desktop'], serverUrl?, includeRelay?, includeDirect?}` →
   `{pairing:{id, secret, fingerprint, expiresAt}, server:{label,
   candidates}}`. A relay-carrying request has already forced the host
   relay up (`ensureEnabledForPairing`, §3.12).
4. The UI assembles the payload with the **server's hostname label**
   (the device names its connection by the issuing machine) and encodes
   the link (§5.2) — the server never renders QRs; payload assembly is a
   shared-UI concern (`@/lib/connectionPayload`).
5. The dialog shows the QR (1024 px PNG) + a copyable link, stores
   `createdPairingId`, moves to the result phase, refreshes the pending
   list, then **polls every 5 s while the page is visible**
   (`listClients` + `listPendingPairings`, silent mode — failures never
   blank the list nor fake redemption).
6. On the phone: scan (Capacitor BarcodeScanner; Android uses the
   CameraX `startScan` flow, iOS the ready-made scanner) → raw string →
   `parseConnectionPayload` (URL parser first, string fallback on
   Android) → `{status:'pairing', pairing}` (an https raw URL scan is a
   legacy direct connect, still accepted, no pairing). Camera
   permission/cancel/unsupported each map to distinct results — doc 11
   renders them.
7. Redemption per §5.6: candidates in order, direct probes
   identity-gated, relay last through a throwaway tunnel. Token stored in
   the device secure store keyed by the candidate set; the connection
   record persists **all** candidates. Then connect: direct probe or
   relay probe (`/auth/session` through the tunnel with the bearer —
   `401` + no token ⇒ `needs-login`; `401` + token ⇒ `auth-failed`;
   unreachable ⇒ keep searching; doc 11 owns the screens).
8. Server-side: the pairing leaves the pending list. The issuing dialog
   auto-closes only after it has *seen* the pairing in the pending list
   (a re-render race must not blink the dialog shut), then only on
   successful now-absent polls (transient fetch failures cannot fake it).
   If a client record with that `pairingId` exists → toast "device
   connected"; an expired/cancelled session closes the stale dialog
   silently.
9. Lifecycle: pending rows show a `via Relay` chip + a cancel action; device rows show label, platform/kind, a `This device` badge where applicable, "connected via relay/direct" (from `lastTransport`) or "revoked", `Last used <relative time>` / "never used"; actions **Revoke** (blocks the token instantly) and **Clear revoked** (purges). Revocation reconciles the relay lifecycle (§3.12); the full revoke semantics table is §12.4.

## 6.2 Token redemption over the relay tunnel

Same redemption rules as §5.6 with a relay candidate; the distinguishing
contract:

- One fresh E2EE handshake per attempt (§3.4); establishment supersedes `/health` verification (only the pinned-key holder can answer `ready`).
- The redeem tunnel is a **probe tunnel**: closed after the redeem. Steady-state switching later opens — or adopts — its own tunnel (`adoptRelayTunnel` exists exactly to reuse an open probe/probe-redeem tunnel when the runtime switch follows immediately, saving a second WS connect + handshake; mobile and desktop both use it, §6.4).
- `grant`, when present, is attached to the client-relay WS URL (`?grant=…`) for that connection only and discarded forever after.
- The redeem POST rides `tunnel.fetch` with the identical JSON body; the response is `no-store`; the plaintext `clientToken` is returned once and stored device-side (§12.3). Nothing about the redeem is logged (§12.1).

## 6.3 Connect from web / PWA

- **Same-network browser:** open `http://<host>:3000` directly. No password ⇒ the gate passes through and an anonymous session token is auto-issued on the first auth resolution (`ensureSessionToken`, random 32 B base64url cookie, 12 h) so cookie-scoped features resolve consistently; a password ⇒ the gate (§6.6). Browsers never hold `oc_client_*` tokens: device-token semantics belong to native clients; the PWA lives on cookies + URL tokens.
- **Tunnel visitor:** open the tunnel URL at `/connect?t=…` (printed link/QR or CLI output) → bootstrap exchange → `oc_tunnel_session` cookie (§4.5) → 302 into the app inside the tunnel-gated scope, where password/passkey/pairing/reset are all 403 (`tunnelLocked`) and the `/api` gate requires the tunnel session (§2.9).
- **Install/PWA:** the web app ships a manifest + service worker (doc 03 §5); nothing pairing-specific — a PWA on a phone still needs the mobile pairing app or a tunnel link, because a browser tab cannot hold device tokens and cannot ride the relay.
- **Desktop "connect from web"**: the desktop shell can open a *new window for a host* (`desktop_new_window_for_host`) which boots the local UI and re-picks the transport itself (direct first, E2EE tunnel fallback) — required because a fixed URL cannot express a multi-transport host (§6.4).

## 6.4 Desktop connect (host switcher + import link)

Desktop trust model: the Electron shell persists
`hosts: DesktopHost[]` (storage/IPC internals are doc 09; the shape is a
shared contract — src: `packages/ui/src/lib/desktopHosts.ts`):

```ts
type DesktopHost = {
  id: string;
  label: string;
  url: string;                 // legacy/UI URL; relay-only hosts: 'relay://<serverId>' (display-only, never fetched)
  apiUrl?: string;             // direct API endpoint (absent for relay-only hosts)
  clientToken?: string;        // saved oc_client_* bearer
  requestHeaders?: Record<string, string>;   // Authorization filtered at parse
  relay?: { relayUrl: string; serverId: string; hostEncPubJwk: JsonWebKey };
};
```

plus `defaultHostId` (`'local'` = the embedded server),
`initialHostChoiceCompleted`, `localOrigin`.

**Import Link (Settings → Remote Instances → Direct Instances → Import
Link)** (src: `RemoteInstancesPage.tsx:580-723`, duplicate logic in
`desktopHosts.importDesktopHostPairing` for the shell's own flows):

1. Parse `openchamber://connect?v=2&p=…` (§5.1); invalid ⇒ error state
   ("invalid connect link").
2. Read the per-install id (`desktop_install_id_get`) once → dedupe key
   `desktop:<installId>` (empty outside the shell ⇒ key omitted).
3. Build the redeem body once (§5.6 step 2), then race candidates:
   relay candidates last; direct via plain `fetch` (cross-origin POST to
   the advertised URL), relay via a throwaway E2EE tunnel
   (`tunnel.fetch('/api/client-auth/pairing/redeem')`), always closing
   the throwaway tunnel.
4. Persist **every** transport the link carried: `apiUrl` = the answering (or first advertised) direct URL; `relay` = the link's relay leg (or the redeemed-through one) with `grant` dropped — never persisted; one `clientToken` works over both transports. One host per server: match by relay `serverId` when the link has a relay leg, else by direct URL; a re-import updates the record in place and keeps the payload label (normally the issuing server's hostname). Relay-only hosts (no answerable direct candidate) store only `url: relay://<serverId>` + `relay`.
5. Direct add / edit rows (`handleAddDirectHost`, `saveDirectHostEdit`): URL normalization accepts any http/https URL; a URL of form `<origin>/connect?t=…` resolves as `{persistedUrl: origin, redeemUrl: full link, kind: 'tunnel-connect-link'}` (src: `desktopHosts.resolveDesktopHostUrl`) — after saving, the shell **navigates** the embedded browser to the redeem URL so the session acquires the tunnel cookie (`navigateToUrl`), exactly like a browser visitor (§4.5); subsequent probes use bearer + cookie.

**Probing** (`desktopHostProbe` via IPC with optional
`expectedServerId` for learned addresses; `probeRelayDesktopHost` for
relay legs):

- statuses: `ok | auth | update-recommended | incompatible | wrong-service | unreachable` + `latencyMs`.
- Relay probe opens a throwaway tunnel, `/health` then `/auth/session` with the saved bearer; deadline budget 15 s total, 8 s per attempt, 400 ms gaps; a **terminal** tunnel state ends early. A ghost relay registration (relay lost the host, host doesn't know) must report *unreachable*, never hang every status/switch flow. With `keepTunnel: true` an `ok` probe RETURNS its live tunnel for the caller to adopt (skips a second connect + handshake).
- The direct probe verifies `/health` `serverId` (the `expectedServerId`) before sending the bearer.

**Restore at startup** (`desktopRelayRestore.ts`): for the default host
when it has a relay leg (the shell booted the local UI for it and defers
transport choice) — race the direct probe against a 1.5 s headstart:
probe wins with a service/auth-ok answer ⇒ `switchRuntimeEndpoint`direct
(url + token + headers, runtime key `host:<id>`); headstart expires ⇒
switch to relay now (`apiBaseUrl = window.location.origin`) and schedule
the background candidate refresh which hot-switches back to direct when
the address simply moved (DHCP re-lease); late direct success after the
switch ⇒ hot-switch to direct. The runtime key never changes, so both
directions are *transport swaps*, not instance switches (doc 01).
The candidate refresh (§3.13) never overwrites an https `apiUrl`
(stable tunnel hostname) and never erases the stored address on an empty
server answer.

## 6.5 Direct instance add (Settings → Remote Instances → Direct Instances)

UI listing (desktop only; `showInstanceManagement = isDesktopShell()`):

- Columns/fields: label (redacted URL fallback), URL or a `relay` badge for relay-only hosts, live status chip (probe results above), default-host marker; every row: **Edit** (label/url/token/extra headers; URL edit may run the `/connect?t=` redeem navigation), **Remove**, **Set as default** (fallback `'local'`); panel actions **Import Link** + **Add**.
- Direct-add persistence (§6.4 shape): `{id: uuid, label, url, apiUrl, clientToken?, requestHeaders?}`. Sensitive URL details are redacted in display via `redactSensitiveUrl` (userinfo stripped; query keys matching `/^(t|.*(?:token|auth|secret|api).*)$/i` → `[REDACTED]`).
- Probes fire once per list change (no polling), aggregated into a single status map; relay-only hosts tunnel-probed; multi-transport direct-first with relay fallback (§6.4).

## 6.6 Password gate + passkeys (SessionAuthGate)

`packages/ui/src/components/auth/SessionAuthGate.tsx` — shared by the web
host surface, desktop shell, hosted mobile; VS Code skips it
(`skipAuth`). States `pending → authenticated | locked | error |
rate-limited` (state helper in `sessionAuthGateState.ts` distinguishes
status-check failure states and runtime-identity matches).

1. On mount and on every runtime-endpoint change (cancel ceremonies, clear password/errors, reset retries): `GET /auth/session` via `runtimeFetch` + passkey support/status fetch in parallel. `200` ⇒ authenticated (bootstrap-resync vs re-login distinction: only the first page-load adoption syncs persisted workspace pointers). `401` ⇒ `locked` (+ `tunnelLocked` from the payload ⇒ the tunnel-scoped locked screen renders **no** password form — see §2.9 — with the host switcher inline on desktop). `429` ⇒ rate-limited screen with `Retry-After` minutes. Network / 5xx ⇒ up to 4 bounded auto-retries (1.5 s × attempt) — over the relay the very first `/auth/session` can race the tunnel's first WS attempt (a failed attempt rejects queued requests even though the tunnel reconnects immediately) — then the error screen (with inline host switcher on desktop).
2. **Locked form:** password (autofocus + select), submit icon; "Trust this device" checkbox (7-day vs 12-hour session; persisted in `localStorage['openchamber.uiAuth.trustDevice']`); "Use passkey" when `enabled && hasPasskeys`; "Add passkey" when enabled and supported.
3. **Desktop shell specifics:** when the runtime targets a *remote* host, the password submission goes through the main process — `invokeDesktop('desktop_remote_password_login', {url, password, trustDevice, requestHeaders})` (doc 09) — because the renderer fetch cannot always do it; the response yields the device token; the shell saves it on the matching host record (`desktopHostsSet`, `localClientToken` for the local server case) and hot-switches the runtime to it (stale-response guard keyed by runtime identity capture/compare). The *local* shell targets `desktop-local` (§2.7/§5.10): password login carries `issueClientToken: true` + `clientKind:'desktop-local'` + `dedupeKey:'desktop-local'`.
4. **Passkey unlock:** `authenticateWithPasskey(trustDevice, {issueClientToken, clientLabel, clientKind, dedupeKey})` (§2.5) → on success apply the client token and mark authenticated; `ERROR_CEREMONY_ABORTED` ⇒ silent cancel (no error line); other errors surface inline. An active ceremony is cancelled when the user switches inputs (passkey busy state ≠ submit busy state).
5. Success side effects: mark the shared auth store back to `ok` (§6.7), focus retargeting; `Cache-Control: no-store` respected.
6. `AuthExpiredBanner` appears when the shared store flips to `expired` mid-session (§6.7); its "Log in" button re-enters this gate.

## 6.7 Auth-expiry handling (runtime-auth-expiry)

`runtimeFetch` observes every response (1); a suspicious 401 (classifiable
path, not excluded from §2.8) triggers one debounced confirm probe of
`GET /auth/session` (2; the probe's own path is excluded so it cannot
loop; 15 s debounce; single in-flight). Confirmed `401` ⇒ `markExpired`
(3): `AuthExpiredBanner` appears (non-blocking, always under the header),
the composer send guard blocks sends, mobile orchestration feeds its own
connection flow. "Log in" ⇒ `markReauthenticating` ⇒ the gate re-runs its
status check into the full locked flow (4; §6.6). Successful login ⇒
`markAuthenticated` (5; banner disappears, workspace context preserved by
design). Focus/visibility revalidation (6; ≥5 min throttle) keeps a fresh
tab honest after long suspension — one request per wake. Transport
failures are *connectivity*, not auth: they belong to the
connection-status machinery (doc 04), never to this store.

---

# 7. SSH remote machines (desktop)

## 7.1 Model: machines as instances

A *machines-as-instances* model lives on the desktop: each SSH instance is
a remote machine reachable by `ssh`, on which a full OpenChamber server
(plus its own harness) runs. The desktop keeps one **master ssh
connection** per instance, an optional managed remote OpenChamber
(install-and-run) or attach to an existing one, one or more **local TCP
forwards** to the remote server port, and the shared UI then talks to
`http://127.0.0.1:<localPort>` like any other instance.

HARNESS PORTS: the remote OpenChamber's `/api` proxying to *its* harness
happens on the remote machine; the desktop only forwards TCP. SSH-hosted
servers that themselves act as a relay host report `platform =
ssh-remote` in relay diagnostics (§3.14).

## 7.2 Instance configuration shape (shared UI contract)

src: `packages/ui/src/lib/desktopSsh.ts` — the shared store renders from
this; durability/IPC/mechanics are doc 09.

```ts
DesktopSshInstance = {
  id: string,
  nickname?: string,
  sshCommand: string,                    // parsed into sshParsed {destination, args}
  connectionTimeoutSec: number,
  remoteOpenchamber: {
    mode: 'managed' | 'external',        // install+run remotely vs attach to existing
    keepRunning: boolean,
    preferredPort?: number,
    bindHost: '127.0.0.1' | '0.0.0.0',   // '0.0.0.0' also exposes it to the remote machine's network
    installMethod: 'auto' | 'npm' | 'bun',
    uploadBundleOverSsh: boolean,
  },
  localForward: {
    preferredLocalPort?: number,
    bindHost: '127.0.0.1' | 'localhost' | '0.0.0.0',
  },
  auth: {
    sshPassword?: StoredSecret,          // {enabled, value?, store: 'never'|'settings'}
    openchamberPassword?: StoredSecret,
  },
  portForwards: Array<{
    id: string, enabled: boolean,
    type: 'local' | 'remote' | 'dynamic',
    localHost?: string, localPort?: number,
    remoteHost?: string, remotePort?: number,
  }>,
}
```

## 7.3 Status phases and events

`DesktopSshInstanceStatus = {id, phase, detail?, localUrl?, localPort?,
remotePort?, startedByUs, retryAttempt, requiresUserAction, updatedAtMs}`
with phases exactly:

```
idle → config_resolved → auth_check → master_connecting → remote_probe
    → installing → updating → server_detecting → server_starting
    → forwarding → ready | degraded | error
```

Store (`useDesktopSshStore`): loads config + status snapshot,
subscribes to pushed status events (`listenDesktopSshStatus`, sorted by
`updatedAtMs`), and exposes connect/disconnect/retry/upsert/create-
from-command/remove. Import candidates (`desktopSshImportHosts`) surface
`~/.ssh/config` hosts as `{host, pattern, source, sshCommand}` rows in
the Add-SSH dialog ("saved" mode when candidates exist, else "manual"
command mode). UI extra rules (src: `RemoteInstancesPage.tsx:1142-1220`):
a remote-LAN bind (`0.0.0.0`) requires a UI password on the remote
instance (`remoteLanNeedsPassword`); binding all interfaces prompts a
confirm; storing secrets in plaintext (`store:'settings'`) prompts a
confirm (both ssh and OpenChamber passwords); port-in-use retries offer
a random port switch; log dialogs (`desktopSshLogs` derived) with
copy/clear actions.

Actions: **Connect / Disconnect / Reconnect now / Cancel(connecting) /
Retry**, per row; statuses land via pushed events, not polling
(`refreshStatuses` for a manual full pass).

## 7.4 Where the boundary sits (electron owns internals)

- The UI never spawns ssh: every operation rides the desktop bridge
  (`desktopSsh*` invoke commands + status events). Installers, bundle
  upload, master-channel keepalive/retry/teardown, forward lifecycle,
  host-key prompts, and process cleanup are main-process land — **doc
  09**.
- The UI owns: configuration editing, import UX, phase rendering,
  retry affordances, log dialogs, and the instances list (doc 14 covers
  gestures/layouts).
- An SSH instance plugs into the wider app as just another runtime
  endpoint (`localUrl` from the phase statuses; runtime key from the
  instance id — doc 01). Remote-machine trust equals "the remote
  OpenChamber's own auth": the desktop stores its (optional) client
  token and/or per-instance OpenChamber password in the same secret
  store rules as any host (§12.3), and the remote instance is revocable
  from its own device list, not the desktop's.

---

# 8. Dev-server preview tunnel (short, cross-ref)

Raw byte tunnel `/api/dev-tunnel` (WS) pipes a desktop's local TCP port
to a **discovered** dev server on the OpenChamber host (src:
`packages/web/server/lib/dev-tunnel/{runtime,client}.js`).

- The reachable set is the same list dev-server discovery offers the
  user — never "any loopback port" — re-checked on every upgrade, so a
  dev server that stops listening stops being reachable. This is what
  keeps an authenticated client from dialing arbitrary local services
  (databases, admin panels, the harness API) through the socket.
- Auth: cookie / URL token / bearer. With an `Origin` header (browser
  context) the normal origin check applies (CSRF defense). With **no**
  origin (desktop shell, or the trusted renderer via the E2EE relay) a
  **client** credential is required, except the trusted-renderer relay
  path which uses a URL token accepted only because the UI-auth WS
  allowlist names this exact path (§2.6, §3.9).
- Limits: 64 concurrent sockets per host; 5 s upstream connect timeout;
  256 KiB pre-handshake buffer cap per connection; 1 MiB output
  backpressure pause; per-connection failures close only that
  connection. The client side binds a *real* local port (not a path on
  another origin) so the remote page gets its own origin: absolute URLs,
  cookies, HMR sockets, and DevTools behave exactly as locally — no HTML
  rewriting ever happens.
- Cross-refs: settings UX in doc 14 (preview wiring); route row in doc
  03; this socket appears in the WS/URL-token allowlists (§2.6) and the
  relay WS allowlist (§3.9). The relay host's dialing injects the
  loopback origin (§3.9), so preview-via-relay works without trusting a
  client origin.

---

# 9. Reverse proxy requirements

From `docs/REVERSE_PROXY.md` — the promises a proxy must keep and the
server-side behaviors that consume proxy headers:

**The proxy must support**

- WebSockets: `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`
  (and in practice `/api/dictation/ws`, `/api/dev-tunnel`,
  `/api/openchamber/realtime-proxy/ws`, `/api/preview/proxy/*`).
- SSE without buffering: `/api/event`, `/api/global/event`,
  `/api/notifications/stream`, `/api/openchamber/events`.
- Large request bodies (attachments/file operations).
- Long-lived read timeouts for live streams and terminal sessions.

**Rules that matter**

- Enable WebSocket proxying; disable buffering on SSE routes
  (`X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform` on
  the four SSE routes).
- Compression in exactly **one** layer: the app gzips responses ≥ 1 KB
  and excludes SSE; a CDN/proxy re-compressing causes double-compression
  and corrupt `Content-Encoding` (`gzip off` at nginx; Cloudflare
  compression passthrough; Caddy does not re-compress by default).
- Forward normal proxy headers: `Host`, `X-Forwarded-For`,
  `X-Forwarded-Proto` (and ideally `X-Forwarded-Host`).
- `client_max_body_size`/body limits sized for uploads.

**Server-side consumption of those headers** (a re-implementation must
keep):

- Cookie security: the `Secure` attribute keys off `req.secure` or
  `x-forwarded-proto` (§2.2, §4.5).
- Origin checks (`request-security.js`): an origin whose host equals the
  forwarded/host header passes; TLS-terminated-at-edge setups (browser
  Origin `https`, proxy hop `http`) are handled by comparing the *host*,
  not the protocol; settings `publicOrigin` is an extra origin candidate;
  packaged-client origins (`openchamber-ui://app`,
  `capacitor://localhost`, `https://localhost`, `http://localhost`) are
  pre-allowed (§10.1).
- Passkey rpID derives from `x-forwarded-host`/`host` (§2.4) — a proxy
  that rewrites `Host` changes the passkey identity per domain.
- Rate limits and scope classification key off the client IP visible
  after `X-Forwarded-For` with `trust proxy` enabled (server level,
  `index.js:1683`); redeem rate limiting deliberately uses the raw
  socket address instead (§5.5).
- Public-instace hygiene: `X-Robots-Tag: noindex, nofollow` on every
  response + `/robots.txt` disallow-all keep the (pre-login) app shell
  out of search indexes even behind a proxy.
- CDN caution: the CDN may still buffer SSE even when the proxy doesn't
  — configure the CDN to disable buffering on SSE paths.

**Shipped example configs** (nginx, nginx-proxy-manager with the
"Websockets Support" toggle, Caddy with `flush_interval -1` and 3600 s
transport timeouts) all encode the same checklist; port 1:1.

**Failure-sign diagnostics to preserve** (they load-bear support):
page loads but sends fail ⇒ WS missing/misproxied; notifications/live
status frozen ⇒ SSE buffered (`X-Accel-Buffering` missing); uploads fail
⇒ body size; works locally but not behind the proxy ⇒ proxy
compressing/buffering or WS unsupported.

---

# 10. Client integrations summary

## 10.1 Auth posture matrix by surface

| Surface | Primary credential | Gate behavior | Can pair / manage devices | Relay-capable | Notes |
| --- | --- | --- | --- | --- | --- |
| Local browser (loopback, no password) | anonymous `oc_ui_session` (auto-issued 12 h) | gate passes through | yes (session auth) | n/a (host side) | session created on first auth resolution; no visible unlock |
| Local / LAN browser (password set) | `oc_ui_session` JWT (12 h / 7 d trusted) | SessionAuthGate locked form | yes | n/a | passkeys available in secure contexts; tunnel off ⇒ local scope |
| PWA (installed) | same cookie as its origin | same as local browser | yes | n/a | a remote PWA still needs the pairing app or a tunnel link — a tab cannot hold device tokens |
| Tunnel visitor (`/connect?t=`) | `oc_tunnel_session` cookie | locked screen **without** password/passkey forms (`tunnelLocked`) | no (pairing/passkey/reset 403 at scope) | n/a | per-request `/api` gate still enforces; `/auth/url-token` works (session authenticated) |
| Remote direct client (mobile/desktop vs LAN/tunnel URL) | `oc_client_*` bearer | probe `/auth/session` with bearer → `ok | needs-login | auth-failed | unreachable` (doc 11 UX) | no | yes (can re-pair via a fresh link) | device record shows `lastTransport direct` |
| Relay client (mobile / desktop renderer / CLI-paired device) | `oc_client_*` bearer through the E2EE tunnel | `/auth/session` over tunnel (`needs-login` / `auth-failed`) | no | yes | requests stamped `x-openchamber-relay-connection` ⇒ `lastTransport relay`, `usesRelay` self-heal |
| Desktop shell (local runtime) | `desktop-local` client token (dedupe `desktop-local`) | gate satisfied by injected token; password → token mint | yes (self + full management) | shares the machine's relay identity (host claim, §3.12) | the only kind with device-management authority client-side (§5.10) |
| Desktop shell (remote host window) | saved host `clientToken` (or password login via shell IPC) | SessionAuthGate; wrong-instance errors offer the host switcher | yes (as its paired device record) | yes — direct+relay multi-transport host records | token persisted on the host record; remote login via `desktop_remote_password_login` (doc 09) |
| VS Code extension | none needed (bridge) | auth gate **skipped** (`skipAuth`) | no | n/a | sseProxy carries identity (doc 10); shared UI must treat VS Code as always-authenticated |
| Mobile app (paired) | per-device `oc_client_*` in secure storage | connect screen probes candidates → `needs-login` / auto-connect | no | yes | UX per doc 11; probing/persistence = `mobileConnections.ts`; storage rules §12.3 |
| API-only mode (`--api-only`) | unchanged gate | no static UI (API-only fallback routes, doc 03 §3.3) | pairing still possible (CLI/paired clients redeem) | n/a | headless instances pair purely with CLI links |

## 10.2 What each client persists/stores

| Client | Stores |
| --- | --- |
| Browser / PWA | the HttpOnly session cookie only; `localStorage['openchamber.uiAuth.trustDevice']` flag; no device tokens by design |
| Desktop shell | host records including per-host `clientToken` and `relay` legs `{relayUrl, serverId, hostEncPubJwk}` — **never the one-time `grant`**; shell-side `localClientToken` for the embedded server; SSH instances incl. opt-in secret values (`store: 'settings'` only, user-confirmed) |
| Mobile | per-device token in the OS secure store (Keychain/Keystore, `whenUnlocked`), keyed by the candidate set; connection metadata (id/label/candidates) in localStorage *without* the token; legacy records with inline tokens are migrated to secure storage on load |
| VS Code | nothing auth-bearing (bridge) |

Hygiene rules applying to all clients: URLs shown in UI go through
`redactSensitiveUrl`; tokens never reach logs or analytics; the relay
descriptor minus `grant` is the only public identifying data.

---

# 11. Environment variables and settings keys

## 11.1 Env vars (scoping)

| Var | Read where | Effect |
| --- | --- | --- |
| `OPENCHAMBER_UI_PASSWORD` | server boot | UI password (instance-wide) |
| `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true` | server boot | permits a network-exposed bind without a password (otherwise the server refuses with an explanatory error) |
| `OPENCODE_JWT_SECRET` | ui-auth | supplies/locks the JWT signing secret; blocks global sign-out secret rotation while set |
| `OPENCHAMBER_DATA_DIR` | server + CLI | root for every secret file (§12.2); default `~/.config/openchamber` |
| `OPENCHAMBER_RELAY_URL` | server + CLI `connect-url` + identity | pins the relay endpoint (ws/wss); overrides the stored setting for host dial, pairing candidates, status; status reports `relayUrlLocked` |
| `OPENCHAMBER_RELAY_HOST` = `on` / `off` | server boot | forces passive relay hosting on/off for this instance (§3.12) |
| `OPENCHAMBER_ELECTRON_DEV=1` | server boot | implies passive-host off for dev shells (explicit enable/pairing still hosts) |
| `OPENCHAMBER_RELAY_BATCH_WINDOW_MS` | host relay | batching flush window (default 150) |
| `OPENCHAMBER_RUNTIME` | server boot + relay URLs | diagnostics platform label (`web` default; `ssh-remote` for ssh-hosted) |
| `OPENCHAMBER_API_ONLY` | server boot | headless API-only mode |
| `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS` | ui-auth login limiter | default 10 |
| `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` | ui-auth login limiter | default 3 |
| `NGROK_AUTHTOKEN` | ngrok provider | authtoken for quick tunnels (checked before `ngrok config check`) |
| `OPENCHAMBER_HOST` / `--host`, `--lan` | boot + CLI | bind host (loopback default); keys the security gate and LAN candidate derivation |
| `OPENCHAMBER_DEV_SHUTDOWN=true` | dev route guard | enables `/api/system/dev-shutdown` (same-origin enforced, dev-only) |

## 11.2 Settings-file keys (relay / tunnel / auth relevant)

| Key | Type/shape | Semantics |
| --- | --- | --- |
| `privateRelay.enabled` | boolean | authored by the demand-driven lifecycle and by enable/disable routes (§3.12) |
| `privateRelay.relayUrl` | ws/wss string | endpoint (overridden by env) |
| `relaySigningKey` | `{privateJwk, publicJwk}` | identity + `serverId`; never regenerated after swallowed read failures (strict-reader gate) |
| `relayEncryptionKey` | `{privateJwk, publicJwk}` | the E2EE trust anchor distributed via pairing |
| `publicOrigin` | https origin | extra passkey origin/relying-party candidate and origin-check candidate |
| `tunnelProvider` | `cloudflare` \| `ngrok` | preferred provider fallback |
| `tunnelMode` | `quick` \| `managed-local` \| `managed-remote` | preferred mode / normalization fallback |
| `managedLocalTunnelConfigPath` | path inside home | preferred managed-local config |
| `managedRemoteTunnelHostname`, `managedRemoteTunnelToken` | string | hostname + last-resort token (profile store is preferred) |
| `tunnelBootstrapTtlMs` | number \| null | connect-link TTL (default 30 min; `null` = no expiry) |
| `tunnelSessionTtlMs` | number | tunnel session TTL (default 8 h) |

---

# 12. Security promises & invariants

## 12.1 Never log or leak

Mandatory for any reimplementation (each is enforced somewhere in the
reference; violating one is a regression, in code or in product copy):

- Pairing **secrets** and their hashes never appear in logs or long-lived responses; session-create and redeem responses are `Cache-Control: no-store`; secrets ride the link exactly once.
- Pairing links render inside the pairing dialog only; QR data URLs are
  transient state, not files; the CLI prints the link to stdout by
  design (that is its product surface).
- Device tokens (`oc_client_*`) and URL tokens never join logs; URL
  tokens expire in 60 s and are scoped to a fixed allowlist.
- cloudflared managed-remote drains child stdout **without logging**;
  run tokens are passed by `--token-file` (temp file 0o600, deleted on
  exit), never on argv; the profile store never echoes tokens in API
  responses (only preset ids).
- Relay-tunnel failure logs carry `connectionId` + reason only — never
  payload contents (host-side `failChannel` contract).
- Client-side host URL display is redacted (`redactSensitiveUrl`:
  userinfo stripped; `t | token | auth | secret | api` query keys →
  `[REDACTED]`).
- App diagnostics never carry credentials, device names, or contents;
  relay analytics stay self-reported labels + counts (§3.14).
- `jwt-secret`, relay signing/encryption keys, and token stores are
  created with restrictive file modes; token stores defensively
  `chmod 0o600` on every write; password scrypt salt lives only in
  memory.
- Never log the raw `Authorization` or cookie headers anywhere.

## 12.2 Secret and credential storage locations (server)

All under `OPENCHAMBER_DATA_DIR` (default `~/.config/openchamber`):

| File | Contents | Mode |
| --- | --- | --- |
| `jwt-secret` | 32 B hex UI-session signing secret (absent when env secret set) | 0o600 |
| `remote-clients.json` | device records with **sha256 token hashes** | 0o600 (dir 0o700) |
| `client-pairing-sessions.json` | pairing sessions with **sha256 secret hashes** | 0o600 |
| `ui-passkeys.json` | WebAuthn credentials + password binding (public material + counters) | default umask |
| `relay-host.lock` | `{pid, claimedAt}` cooperative claim | default |
| `cloudflare-managed-remote-tunnels.json` | managed-remote hostnames + run tokens (plaintext by necessity — these are cloudflared run tokens) | 0o600 |
| `settings.json` | relay identity JWK pairs (private halves), relay config, tunnel settings, `publicOrigin` | settings runtime |
| in-memory only | scrypt password hash + salt, JWT HMAC binding, URL-token map, tunnel sessions + bootstrap records, login rate limiter | volatile |

## 12.3 Secret and credential storage locations (clients)

- Browser/PWA: the cookie jar only; nothing token-bearing in JS storage.
- Desktop: host records (with `clientToken`) persisted through the
  shell's storage path (doc 09); `requestHeaders` never keep
  `Authorization` (filtered at parse *and* write); `localClientToken`
  for the embedded server; SSH secrets only at user-confirmed
  `store: 'settings'`.
- Mobile: token in the OS secure store keyed by the candidate set;
  metadata only in localStorage; legacy inline tokens migrated into the
  secure store on load (doc 11).
- All clients: the relay `grant` string is connection-scoped only, never
  persisted; QR payloads are never written to disk.

## 12.4 Revocation semantics

| Object | Action | Immediate effect | Cleanup |
| --- | --- | --- | --- |
| Device token | `DELETE /api/client-auth/clients/:id` (self, `desktop-local`, or UI session) | `revokedAt` stamped; authentication fails instantly | stays listed (as revoked) until **Clear revoked** purge |
| Pending pairing | `DELETE /api/client-auth/pairing/sessions/:id` | redeem refuses with the generic error | sweeper drops after the TTL window |
| Passkey | `DELETE /api/passkeys/:id` (rpID-scoped) | gone from `allowCredentials` | store rewrite |
| All browser sessions | `POST /api/auth/reset` | JWT rotation kills every cookie session (device tokens unaffected) | passkeys cleared too |
| Tunnel session | tunnel stop/replace | `revokedAt` + reason ⇒ cookie unusable | entry remains listed as inactive |
| Bootstrap link | new token issued, or tunnel stop/replace | previous revoked | n/a |
| Relay reachability | `/relay/disable` or demand loss (§3.12) | host control socket closed; devices hit terminal errors | `enabled` persisted false |
| URL token | 60 s expiry; allowlist scope | self-expiring | map sweep |

A client may always revoke **itself**; only `desktop-local` or a UI
session may revoke/purge others (server-enforced, §2.7). Revoking a
relay-paired device feeds relay demand (§3.12) — the relay host may shut
down when the last relay device/pairing disappears.

## 12.5 Invalidation rules

- **One-time things:** pairing secret (`usedAt`), tunnel bootstrap token
  (`usedAt` + newest-only revocation), URL token (60 s, allowlist),
  relay `grant` (single-use, unpersisted).
- **Single-tenant things:** one active tunnel controller per instance;
  one relay host claim per machine/data dir; one host-control slot per
  `serverId` at the worker; one client leg per client connection
  (duplicate ⇒ 4002).
- **Snapshot vs authoritative:** pairing candidate lists are snapshots
  (refresh via the candidates endpoint); `usesRelay` self-heals from the
  *observed* transport and stays sticky; a failing store read aborts
  reconcile rather than faking "no demand" (§3.12); pending-list polling
  never lets a failed fetch fake redemption (§6.1).
- **Identity-bound things:** URL tokens bind to the parent session;
  tunnel sessions bind to their `tunnelId` (and host); JWTs bind to the
  rotatable secret; E2EE channels bind to the pinned `hostEncPubJwk`
  (rekey ⇒ 1008); LAN-candidate trust binds to `serverId`; passkeys bind
  per rpID and to the password binding.
- **Fail-closed defaults:** an unknown close code never grants grace;
  plaintext after `ready` kills the channel; a body that lost frames is
  aborted, not forwarded; a misclassified transport never hides relay
  demand; a leaked credential (device token) is useless after revoke
  because validation happens on every request against the current hash
  set.

---

# 13. Edge and failure cases

The behaviors a re-implementation must reproduce (each row is a real
code path):

| Case | Required behavior |
| --- | --- |
| Device revoked mid-session | next token validation fails (`revokedAt`); the client sees 401s on subsequent requests; relay probes surface `auth-failed`; the desktop switcher shows `auth` status |
| Relay host replaced by another local instance | old host's control socket replaced at the worker (4001); its claim watcher stands it down; devices reconnect to the new host; the 120 s restart grace prevents bystander capture during clean restarts |
| Tunnel replaced (provider/mode/url change) | previous tunnel's bootstrap token revoked + all its sessions invalidated (`tunnel-revoked`); new link issued; visitors holding the old session are cut off immediately |
| Tunnel stopped | same invalidation; `oc_tunnel_session` cookies dead; tunnel-scope `/auth/session` returns `tunnelLocked` |
| Bootstrap link reused | second visitor gets 401 (one-time exchange); rate limiter guards brute force |
| Pairing link expired before scan | client-side `expiresAt` check refuses *before* any network round-trip; server-side generic error if raced |
| Pairing link used twice | second redeem gets the generic error (session `usedAt`); client mint failure ⇒ session stays redeemable (retry-safe) |
| Device token expired (`expiresAt`) | authentication returns null → 401 / `needs-login` |
| Clock skew | all expirations are server-side wall-clock compares (`Date.now()`) except the client-side pre-check on `expiresAt` in the QR payload (refuses stale-at-scan links, tolerating only major device clock errors); relay signature `ts` freshness is broker-side; E2EE correctness is clock-free (counters, not time) |
| JWT secret rotation (global sign-out) | every cookie session dies at the next verify (`jwtVerify` fails); URL tokens minted as `client:<id>` keep working for device tokens; passkeys are cleared in the same action (binding guard) |
| Password changed | passkey store binding differs ⇒ passkeys cleared and rewritten on next load |
| Host encryption key regenerated | every paired device's E2EE channel fails at decrypt (1011) — devices must re-pair; logged loudly once at generation |
| `serverId` changes | all devices orphaned (their pinned identity no longer matches `/health` or the relay routes); the strict-reader gate exists precisely to avoid accidental generation |
| DHCP re-leased the host | stale direct addresses; identity-gated probes fail (`wrong-service` risk prevented); candidate refresh learns the new address over the tunnel and hot-switches direct (desktop §6.4; mobile §3.13) |
| Relay worker lost the host but host doesn't know (ghost) | client tunnel keeps reconnecting; bounded probe deadline reports unreachable rather than hanging status flows (§6.4) |
| Client leg goes silent (network loss, battery) | host idle reaper closes the data socket at 90 s; worker/relay timeouts cover the rest; device count stays honest |
| Reconnect mid-POST | in-flight request fails tagged ambiguous (may or may not have been processed); prompt sends must treat that differently (§3.10); fresh POSTs ride the next tunnel |
| Rekey attempt on an established channel | 1008 close, never rekey (§3.4) |
| Body frames lost through the tunnel | host aborts the request (never forwards an empty body); client sees a tagged ambiguous failure and can retry (§3.9) |
| WS output floods a relay leg | Bun-side bounded queues abort the offending substream (never silent delta loss); Node pauses reads (§3.8) |
| Wrong-instance probe (stale learned address) | `wrong-service`/`incompatible` status; the bearer token is **not** sent (identity gate); user picks another host or the switcher resolves |
| Login rate-limit lockout | 429 + `Retry-After`; gate shows the rate-limited screen; countdown covers minutes |
| Passkey in non-secure context | support check refuses (HTTPS/localhost only); the gate hides passkey buttons |
| Settings reads corrupt/crash | strict-reader gate blocks identity regeneration (no silent re-identification); reconcile aborts rather than faking demand loss |
| VS Code runtime | auth gate skipped; relay/URL-token surfaces unused; sseProxy bridge is the transport (doc 10) |
| Mobile OS kills the app | fresh launch auto-connects through the saved candidate list (doc 11); the token is in secure storage; nothing about pairing changes |

---

# 14. Build checklist

Implementation order that matches dependency flow (each step verifiable
alone):

1. **Pairing payload contract** — §5.1–§5.3 encoders/parsers (+ tests
   for the string fallback and the strict normalizers). Nothing else
   compiles meaningfully without this.
2. **Server credential stores** — remote-clients + pairing runtimes
   (§2.7, §5.4), including dedupe-replace label precedence, one-time
   redeem semantics, rate limiting, and the generic error string.
3. **UI password + session** — scrypt/secret/JWT/cookie/rate limit +
   `/auth/session`, `/auth/url-token` with the path allowlists (§2.2,
   §2.6).
4. **Scope classifier + tunnel-gated auth** — `classifyRequestScope`,
   bootstrap tokens, `/connect?t=`, `oc_tunnel_session`, scope-blocked
   credential endpoints (§2.9, §4.5).
5. **Passkeys** — server store + binding + rpID logic; client ceremony
   module; wire into the gate (§2.4–§2.5, §6.6).
6. **Relay primitives** — crypto + handshake frames (Layer 2) with
   cross-implementation vectors; then the Layer 3 codec + batch
   container; keep a two-mirror byte-compat test from the start
   (§3.4–§3.7).
7. **Relay client** — tunnel client with keepalive/reconnect/terminal
   semantics + ambiguous-failure tagging; then runtime integration
   (singleton, fetch/socket/auth routing) (§3.10–§3.11).
8. **Relay host** — identity/signing, host-client (control + data),
   machine claim, tunnel-host dispatcher (allowlists, body buffering,
   WS mux), downstream scheduler; host management routes (§3.3,
   §3.9, §3.12, §3.15).
9. **Candidate refresh + restore** — candidates endpoint, identity
   gating, desktop restore/hot-switch, mobile reprobe (§3.13, §6.4).
10. **Tunnels** — types/normalize/validate, provider registry +
    cloudflared/ngrok implementations, profile store, tunnel routes;
    then the auth-gate wiring from step 4 (§4).
11. **Pairing UX** — create-device dialog + QR (port + `qrcode` L),
    pending-list polling + auto-close, mobile scan + redeem, CLI
    `connect-url` (§5.8–§5.9, §6.1).
12. **Host/instance management UX** — device list (revoke/purge),
    direct instances (add/edit/import/probe/default), host switcher
    with statuses, auth-expiry banner + gate states (§6.4–§6.7).
13. **SSH machines** — shared instance contract, statuses/events,
    instances UI; main-process internals last per doc 09 (§7).
14. **Reverse-proxy posture** — origin logic with forwarded headers,
    cookie Secure handling, passkey rpID via forwarded host, robots
    hygiene (§9).
15. **Invariants sweep** — §12 re-audit as a checklist: no secrets in
    logs, one-time semantics, single-tunnel/claim uniqueness, identity
    gating before credentials, fail-closed response paths.

Minimum verification gate per §3.8-style practice: byte-compat relay
test (client↔host), flow-control regression fixture, pairing redeem
single-use tests, rate-limit tests, tunnel replace/invalidation tests,
URL-token allowlist tests, and the status-check bounded-retry test for
the gate.
