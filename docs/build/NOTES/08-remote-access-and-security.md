# NOTES 08 - Remote access & security

Doc read in full (2,073 lines). P8 sliced per the doc build checklist (section
14), dependency order preserved: payload contract -> credential stores ->
password/session/url-token -> scope+tunnel gate -> passkeys -> relay
(primitives, client, host) -> candidates -> tunnels -> pairing/instance UX ->
SSH -> reverse proxy -> invariants.

## A. Slice map (against the doc checklist)

- **P8-1a (delivered)** - checklist steps 1-2: pairing v2
  payload contract (encoder + canonical priorities + strict JWK
  normalization; link `openchamber://connect?v=2&p=<b64url>`; 16384 length
  cap, v1 rejected forever, candidate normalizers incl. hash-/slash-strip
  and relay path preservation), remote-client credential store (oc_client_
  + 32 B b64url, sha256-only storage with the plaintext returned exactly
  once, dedupe-replace with label precedence explicit>replaced>fallback +
  legacy same-label cleanup, bearer authentication with constant-time hash
  compare, sticky relay flag (LAN never clears it), 60 s lastUsed/transport
  write throttle with immediate writes on transport change, revoke
  idempotent + purge, issuer-set expiry), payload + store tests (18).
  Adversarial review pass on this slice fixed: the link head was emitted
  without `//` (P0: openchamber:connect fails both parse strategies of
  section 5.1), the size cap checked only the decoded JSON (p and the whole
  link now checked too), a candidates-hole TypeError crash, fail-OPEN
  unparsable issuer expiry, non-atomic store writes, non-string
  label/fallbackLabel/expiresAt input crashes, and throttle-stamp leaks for
  removed records; registered E-08-7..10 below.
- **P8-1b (delivered this slice)** - checklist step 3: password/JWT/cookie
  sessions + URL tokens. `lib/auth/jwt.ts` hand-rolled HS256 (E-08-1:
  {type:'ui-session',iat,exp} grammar pinned to 3 keys, constant-time tag
  recompare, 4096-char token bound, exp>now, iat<=exp numerics) with secret
  resolution env (`NOTNATIVE_JWT_SECRET`, E-08-4) -> `<data-dir>/jwt-secret`
  file (0600, strict hex read regenerates on corruption) -> memory; rotation
  refused under env, rewrites file, replaces memory. `lib/auth/password.ts`
  NFC+trim normalize + per-instance 16B salt scrypt 64B, timingSafeEqual,
  string-keyed hash cache (LRU 4). `lib/auth/rate-limit.ts` per-IP
  10/5min -> 15min lock (no-IP 3), env overrides
  `NOTNATIVE_RATE_LIMIT_{,NO_IP_}MAX_ATTEMPTS`, reader-prunes/record-reinserts
  (the detached-bucket bug), epoch-seconds Reset header + Retry-After on 429.
  `lib/auth/ui-auth.ts` controller: cookie `oc_ui_session`
  (HttpOnly/SameSite=Strict/Path=/, Secure on https or x-forwarded-proto),
  login flow per §2.3 (record-failure 401 'Invalid credentials' + cookie
  clear, success clears the bucket, trustDevice 7d TTL, desktop-only client
  mint via createClient whose expiresAt ties the cookie TTL, Cache-Control
  no-store), GET /auth/session (open/session/client scope + legacy
  authRequired/methods fields for the P0 boot flow), bearer-first precedence
  (an invalid/revoked bearer cannot hide behind an ambient cookie),
  requireAuth global gate wired into app.ts between the /auth routes and
  every later /api surface + proxy, URL token mint (cookie or client bearer;
  allowUrlToken:false, 24B b64url `oc_url_<32 chars>`, 60 s, budget 512 +
  insertion-order eviction) bound to the parent session JWT or `client:<id>`,
  allowlist (exact GET set + /api/fs/serve/ and /api/preview/proxy/ prefixes
  + /api/projects/:id/icon pattern + WS exact set incl. /api/terminal/ws,
  /api/dictation/ws, /api/dev-tunnel; rejected tokens fall through),
  POST /api/auth/reset cookie-only global sign-out (rotates secret, clears
  cookie; device tokens never rotate; E-08-3 passkey purge joins later), and
  the E-07-3 terminal upgrade slot filled via terminal/wire.ts gate param.
  Store: RemoteClientStore.getActiveClient for `client:<id>` URL-token
  parents (revoked/expired/unknown fail closed, no transport stamping).
  Route stubs from P0 (/auth/login, /auth/logout) retired; /auth/url-token
  and /auth/session upgraded to the real contract. Tests 37
  (p8-1-auth-ui.test.ts). Adversarial review pass (sub-agent) fixed:
  P1 generated secrets now persist to the jwt-secret file at first use
  (memory-only secret silently killed every cookie on restart), P1 the
  login body read is a 64 KiB bounded stream (the only unauthenticated
  read was a memory-DoS hole), P2 iat<=exp grammar check + NaN pin,
  P2 open-mode mint honors trustDevice TTL, P2 the terminal upgrade
  listener fails closed on a throwing gate (real socket test), P2 the
  secret write is atomic tmp+rename; quality-gate compliance restored
  (createApp + createLoginRateLimiter extracted past the 60-line cap).
  Hono ordering PROVEN via throwaway script: the /api gate runs after the
  /auth routes but before every later /api surface + proxy (bare /api and
  the catch-all now pinned by tests). Review-noted dispositions: bearer
  401 does not clear an ambient invalid cookie (doc-referencing fail-closed),
  clear-cookie header gains Secure in the reverse-proxy step, login 200
  carries no X-RateLimit headers (E-08-15 read), open-mode parent-less
  mint resolved by the parent='' fallthrough (no privilege delta).
- **P8-1c (delivered this slice)** - checklist step 4: scope classifier +
  tunnel gate. `lib/auth/tunnel-auth.ts`: classifyRequest per §2.9 (tunnel
  host match, local names with private/loopback sockets, no-tunnel ->
  local, rest unknown-public treated like tunnel; Host header may be absent
  on constructed requests -> URL hostname backs it; an unknown socket
  counts as the loopback desktop host, matching the wire.ts stance);
  newest-only bootstrap tokens (32 B base64url, sha256-at-rest,
  issuance revokes the previous record, one-time redeem with
  timing-safe compare + used/unrevoked/unexpired/newest-tunnel checks,
  TTL clamp 1 min..24 h default 30 min, `null` disables expiry via
  applyBootstrapTtl), in-memory tunnel sessions (32 B sessionId,
  lastSeenAt refresh, revoked/wrong-tunnel/expired closed; 512-entry
  bound), the connect rate limit (20/5min per IP, 5 without IP, 10 min
  lock, X-RateLimit triple + Retry-After), stop/replace artifact revocation
  (clearActiveTunnel nulls the record; revokeTunnelArtifacts marks its
  sessions 'tunnel-revoked'). Routes: `GET /connect?t=` — rate-limited,
  no-store always, failure 401 plain 'Connection link is invalid or
  expired.' + limiter record, success marks usedAt, mints the session,
  sets `oc_tunnel_session` (HttpOnly, SameSite=Lax, Secure on
  https/x-forwarded-proto) and 302 -> '/'. Gate: app.ts apiAuthGate now
  classifies scope first — tunnel|unknown-public routes to
  apiTunnelGate (bearer/URL-token device credentials pass at any scope;
  the anonymous path requires the tunnel cookie; 401 {error:'Tunnel
  authentication required', locked:true, tunnelLocked:true} + cookie
  clear on an invalid-present session); /auth routes harden at tunnel
  scope: POST /auth/session 403 'Password login is disabled for tunnel
  scope', POST /api/auth/reset 403 'Global auth reset is disabled for
  tunnel scope', POST /auth/url-token restricted to device bearers (ui
  cookie + tunnel sessions cannot mint over the tunnel), GET /auth/session
  answers the §2.9 row (valid tunnel session -> {authenticated:true,
  scope:'tunnel'}; device bearer -> scope:'client'; else 401
  {authenticated:false, locked:true, tunnelLocked:true} with the ui cookie
  cleared). Terminal upgrade predicate composed (E-07-3 slot): tunnel +
  device credentials or the tunnel cookie admit; local host keeps the ui
  predicate. Tests 13 (p8-1-tunnel.test.ts). `classify` regressed once
  under undici (constructed Requests carry no Host header) — pinned by the
  machine matrix. NOT in: /api/system/shutdown requireShutdownAuth flavor
  (route lands with the doc 03 system family; the classify+grant helpers
  are ready), tunnel providers/status routes (step 10), settings keys for
  the TTLs (E-08-4 tail).
  Adversarial review pass (sub-agent) fixed: P1 IPv4-mapped sockets
  (`::ffff:a.b.c.d` dual-stack peers classified public -> desktop LAN
  tunnel-locked with an IPv6 listener host) via the isPrivateV4 unmapping;
  P2 redeem order deviation (mint -> sessions.set -> usedAt mark so a
  mint-side throw can never strand a consumed one-time token);
  P2 createAuthRoutes over the 60-line cap (handleConnect extraction).
  Review-noted dispositions: XFF-first IP extraction stays spoofable within
  the in-memory limiter posture (E-08-5; CF-Connecting-IP precedence joins
  the relay/settings slice); session-JWT-parent URL tokens stay admitted on
  allowlisted tunnel targets (the grant equals the local-scope credential);
  invalid TTL values (0/NaN/negative) clamp to the 30 min DEFAULT pending
  the settings runtime; CGNAT 100.64/10 stays public (doc-literal
  "private or loopback" read).
- **P8-1d (delivered this slice)** - checklist step 5: passkeys (WebAuthn
  server). `lib/auth/ui-passkeys.ts`: disabled-unless-password (400 exact
  'Passkeys require UI password protection to be enabled'), store
  `<data-dir>/ui-passkeys.json` {version:1, userID 32B b64url,
  passwordBinding: HMAC(jwtSecret, password) hex, passkeys[]} with strict
  read + atomic 0600 rewrite; the binding GUARD runs on construction and
  on every access — a changed password or rotated secret clears the whole
  list and rewrites the file empty; per-rpID scoping (rpID from
  x-forwarded-host first hop else Host else URL hostname, lowercased,
  bracket-stripped, port-stripped; localhost|127.0.0.1|::1 local set;
  expected origin from x-forwarded-proto scheme + the host KEEPING its
  non-default port (WebAuthn clientDataJSON.origins carry the port; the
  lib compares exact strings - review fix; scheme-default ports and the
  rpID itself drop the port; IPv6 re-brackets in the origin), registration is
  session-cookie-ONLY (route gates refuse bearer management callers 401
  even after the /api gate), authentication is anonymous over the LOGIN
  rate limiter (E-08-21; 429 + X-RateLimit headers; failures record),
  5-minute one-shot challenge records whose bound value is the challenge
  the ceremony actually returned (256-entry budget), register options
  shape (attestationType none, residentKey required, userVerification
  required, excludeCredentials per rpID, userID 32B), verify stores
  {id, publicKey b64url, counter, transports, deviceType, backedUp,
  createdAt, lastUsedAt, label(<=80), rpID}; duplicate id+rpID replaces on
  re-registration (E-08-20), authentication verify requires UV, bumps
  counter and lastUsedAt, then issues the session cookie EXACTLY like
  password login (trustDevice honored; desktop client-token mint honored
  via the shared grantedLogin tail), revoke matches id AND current rpID
  (404 otherwise), GET /api/passkeys + DELETE /api/passkeys/:id management
  (cookie-only inside the gated /api scope), tunnel scope hard-403s the
  whole family ('Passkey endpoints are disabled for tunnel scope',
  tunnelLocked) and the auth-reset flow now PURGES passkeys (E-08-3 tail
  complete). Ceremony runs through a WebAuthnCeremony seam: realCeremony
  wraps @simplewebauthn/server v14 (^14.0.2, new dependency); tests inject
  fixtures while the route guards run against the REAL adapter (a
  fabricated response object fails 400 verified:false). Hostile/oversize
  WebAuthn payloads die as verified:false, never a 500. Review pass fixes,
  all regression-tested: the authenticate/verify route finalizes through
  the SHARED route finalize so a granted login's Set-Cookie actually
  attaches (was dropped by the passkey-only response builder); a corrupted
  or mis-shaped userID (not 43-char 32B b64url) regenerates the store
  instead of flowing verbatim into registration option bytes; transports
  are laundered to the IANA token set (deduped) before the store write;
  the seams split into rp-context.ts / webauthn-ceremony.ts /
  url-tokens.ts for the 500-line gate, and the grantedLogin desktop mint
  kind gate stays in float with password login (possessor parity: the
  doc's client library is expected to carry clientKind through the passkey
  verify, so the shell's passkey unlock keeps its desktop-local mint).
  Route-level E2E runs the FULL lifecycle through the real @simplewebauthn
  adapter with a server-built synthetic P-256 authenticator (CBOR/COSE
  fixtures): ported-origin registration 200, scheme-default-origin
  rejection 400, anonymous login issuing a WORKING oc_ui_session cookie
  (counter bump visible through it, revoke through it). Tests 15
  (p8-1-passkeys.test.ts). NOT in: client library §2.5 (@simplewebauthn/
  browser + gate UX) rides the pairing/UX slice (E-08-6 family);
  The settings-driven publicOrigin allowlist is now implemented (E-08-22);
  real-device ceremony acceptance remains required.
- **P8-2a (delivered this slice)** - relay steps 6/7 primitives:
  `lib/relay/identity.ts` — RelayIdentityStore over `<dataDir>/relay-
  identity.json` {version:1, signing ECDSA P-256, encryption ECDH P-256,
  both w/ private+public JWKs, 0600 atomic tmp+rename}; STRICT
  regeneration gate (absent -> mint + persist + round-trip verify;
  corrupt presence -> throw, never re-mint, because a new signing key
  abuses a new serverId and orphans every paired device; E-08-23 pins
  the dedicated-file posture until the settings registry gains relay
  keys); serverId = base64url(sha256(canonical {crv,kty,x,y} JSON));
  authParams signs `${ts}.${serverId}.${role}.${connectionId ?? ''}`
  ECDSA-SHA256 IEEE P1363 (sig 86 b64url chars, pk = canonical JWK b64url
  of the JSON string) with `relaySocketUrl(base, role, ts, …carry
  ts/sig/pk/serverId/appId/v=1 (+platform/appVersion/grant/
  connectionId))` building the doc 3.3 query rows w/ WHATWG ws/wss scheme
  survival.
  `lib/relay/crypto.ts` — Layer 2: ECDH P-256 deriveBits 256 -> HKDF-
  SHA-256 (salt = handshake nonce 16B, info utf8 'openchamber-relay-v1',
  512 bits) -> two AES-256-GCM keys per direction; per-direction IV =
  4B random prefix + 8B BE counter from 1; frame `[v=1][12B IV][ct+16B
  tag]`; 64 KiB plaintext cap; MAX_TUNNEL_PAYLOAD_BYTES reserves the 5+5
  header/envelope bytes; fail-closed decrypt (>=29 B, version=1, counter
  strictly > last, GCM) — counter read offset pinned at byte 5; hello/
  ready grammar (clientPubJwk reduced to {kty,crv,x,y} — private d never
  crosses the wire; capability flags echo only when true; foreign/junk
  decode -> null).
  `lib/relay/tunnel-codec.ts` — Layer 3: const-object frame types 1..13
  (erasable-syntax contract, never renumbered), 5B header byte-exact
  codec with the 0x80 fragment flag, odd-stream allocator (odd start
  corrected), chunkPayload (empty body = ONE empty chunk),
  encodeFragmentedMessage (WsText/WsBinary only), fragment assembler
  bounded 16 MiB (non-fragmentable fragmented frames = CodecError),
  JSON payload guards (HttpRequest/HttpResponse/StreamAbort/WsOpen/
   WsOpened/WsClose shapes). Adversarial review pass (self) fixed, all
   regression-tested: runaway tunnel-counter math (the decryptor read the
   8 B BE counter via Number() — a hostile wire counter above 2^53-1 is
   unrepresentable exactly and passed Number.isSafeInteger; now read as
   BigInt, >2^53-1 rejected pre-GCM as 'exceeds the exact range', wire
   counter 0 pinned rejectable); a fragment-assembler bound hole (the
   FINAL chunk's bytes were never counted toward the 16 MiB cap — total
   now checked at completion, bound-exact messages still legal); the
   chunk-size budget (chunkPayload validates positive safe integers and
   rejects sizes > MAX_TUNNEL_PAYLOAD_BYTES, doc 08 §3.5, so fragmented
   frames can never violate the encrypted plaintext budget); an
   unbounded-pending hardening (MAX_PENDING_FRAGMENT_STREAMS=256 distinct
   (streamId,type) partials; a flood across many stream ids is a channel
   error instead of memory growth; reset() frees slots); payload-guard
   strictness E-08-24; identity hardening (concurrent resolve()
   single-mints via a shared in-flight promise; leftover .tmp- mint
   residue is never read — the reader opens only the canonical path;
   truncated JSON is corrupt and refuses regeneration). Proven by
   execution: relaySocketUrl WHATWG contract (base path/query preserved,
   duplicate params replaced by set(), ws/wss schemes kept/lowercased,
   base64url sig/pk/serverId emitted percent-free as the worker sees
   them); authParams signed-domain negatives (role/connectionId/ts change,
   empty connId slot -> WebCrypto verify false); IEEE P1363 r||s = 64 B =
    86 b64url chars verified through WebCrypto. Cross-implementation
    contract notes registered E-08-25. Tests 17 (p8-2-relay-primitives.test.ts).
   NOT in this slice: the broker sockets/host control machine (3.3) +
   framers/keepalive + the dispatcher/client mux (3.5/3.9/3.10) + demand
   lifecycle (3.12) — next slices; the /health serverId field (E-08-2)
   lands with the host service wire.
- **P8-2b (delivered this slice)** - relay step 7 host side: the HOST
  broker (`lib/relay/host-broker.ts`) + the two handshake state machines
  (`lib/relay/handshake.ts`), driven end to end through a LOOPBACK fake
  relay worker (test-only prosthesis: worker-parity ECDSA verify against
  the presented pk, 4001 one-host-slot replacement, verbatim binary
  forwarding, upgrade gates for observing timing windows).
  `handshake.ts` — host responder: hello grammar validate -> negotiate
  (both-peers-advertise) -> ready re-answer; the readyText is stored
  BEFORE the derive so an interleaved retry sees an in-flight answer (E-
  08-26a); client initiator: hello re-sent on the retry cadence until the
  ready arrives, overall deadline fails the attempt (1011); duplicate
  ready after establishment is ignored (echoes stay legal, matching the
  doc's client rule).
  `host-broker.ts` — control machine: ONE outbound control socket with
  ping 30 s + quiet-window beyond interval + 10 s grace terminate ->
  exponential reconnect 1 s x2 cap 30 s; a nonzero close code becomes
  lastError ('control closed (<code>)') and open clears it; state
  disabled/connecting/connected/reconnecting surfaces in getStatus
  {state, serverId, connectedClients, relayUrl, lastError}; the
  reconnect-open returns the machine to `connected` (the first-open
  ternary was inverted and pinned a recovered control at `reconnecting` —
  fixed) and superseded dial sockets carry owner guards so a stale open/
  close never steers the machine.
  Data legs: each connected client announcement triggers one host-data
  socket (open timeout 15 s, terminated + 1012 'open timeout' on miss;
  the timer is CLEARED on socket open — it used to hover over healthy
  legs and kill them 1012 late) running the real responder, then
  established binaries decrypt fail-closed (1011 on any decrypt failure)
  through a serialized receive chain, and outbound frames encrypt through
  a per-leg send chain so ECDH-counter ticks hit the wire in order; the
  64 KiB plaintext cap rejects oversize sends without touching the chain;
  legs pair 1:1 by connectionId (skip when one exists), survive a CONTROL
  blink (legs ride their own relay sockets; only announcement/disconnect/
  sync messages move them), and the idle reaper sweeps every 30 s closing
  legs silent >90 s with 1001 (close code 1001, count freed; every
  inbound frame refreshes; production timing defaults: controlPingMs
  30000, pong grace 10000, dataOpenTimeoutMs 15000, dataIdleMs 90000,
  sweep 30000, reconnect 1000 x2 cap 30000 — the SHORT test timing is
  per-test override only).
  Established-TEXT routing fix (the slice's load-bearing repair): the
  broker NEVER becomes the 1011 authority on established channels — TEXT
  frames route into the responder, which re-answers the IDENTICAL-hello
  retry (same key fingerprint, ready resent), closes 1008 on a rekey
  attempt (different fingerprint, never rekey in place) and 1011 on
  strays (doc 08 §3.4; the previous routing short-circuited every text
  as 1011 and made the 1008 path dead). Foreign 'ready' text after
  establishment still closes 1011 through the responder.
  Adversarial fixes, all regression-tested: ws sockets are ALWAYS armed
  with an error listener — ws aborts a CONNECTING socket by emitting
  'error' WITHOUT listeners on the next tick, which crashed the process
  out of the open-timeout teardown (emerges as an unhandled exception
  one tick after a green test otherwise); `finish()` is single-shot (the
  close-decision map check guards onLegClosed so the responder close and
  the ws-close event can never double-report); legs close exactly once.
  Tests 9 (p8-2-relay-host.test.ts): control connect/4001-replacement
  with gate-observed lastError, E2EE leg both directions + late-frame
  (openTimer-clear regression) + oversize reject, sync reconciliation
  (drop closed by sync 1000 exactly, keep legs untouched), idle reaper
  1001 + pairing teardown propagation, rekey-1008/plaintext-1011,
  duplicate-hello re-answer, host-data open timeout 1012, dead-relay
  supervision.
  NOT in this slice: tunnel framer/dispatcher (3.5/3.9/3.10), the
  machine claim/demand lifecycle (§3.12) — the broker assumes the claim,
  the WS maxPayload needle rides the framer slice, and the
  fake worker stays test-only (the real 3.3 host-socket rows validated
  through relaySocketUrl in P8-2a).
- **P8-2c (delivered this slice)** - relay Layer 3 host side: the batch
  container + outbound batcher (`lib/relay/batch.ts`), the downstream
  scheduler (`lib/relay/downstream.ts`), and the host dispatcher
  (`lib/relay/dispatcher.ts` + the WS bridge split `dispatcher-ws.ts`,
  honoring the 500/60 gates).
  `batch.ts` - container codec (1 frame -> `[0x00][frame]`, N frames ->
  `[0x01]([4B BE len][frame])xN`, truncation/foreign tags refuse) +
  `createOutboundFrameBatcher` defaults 150 ms / 24 KiB / 32 frames
  (batch window tunable via `OPENCHAMBER_RELAY_BATCH_WINDOW_MS`): only
  HttpBody/WsText/WsBinary buffer; setup/teardown/keepalive frames flush
  the buffer first preserving per-stream order; the leading edge ships
  instantly when the channel is quiet; caps and the trailing window
  flush on the same offer (group sizes stay exact at the caps);
  teardown drops un-flushed frames. The empty-payload -> one-empty-chunk
  codec row is pinned for response bodies (section 3.9 recycling).
  `downstream.ts` - credit scheduler: fixed start window 64 KiB, hard
  cap 1 MiB (E-08-27: grow/halve heuristics DEFERRED, byte accounting
  identical); ACK unit = 8 B BE cumulative RAW tunnel-frame bytes
  (5 B headers included; envelopes, encryption overhead, and
  stream-zero keepalives excluded) on stream 0; the host therefore keeps
  stream-zero frames OUT of the ack ledger entirely (a ping held as an
  outstanding boundary reference would make every correct client ack
  look off-boundary - found and fixed in review); the window gate counts
  sent-but-unacked bytes only (ackedBytes never inflated the gate, which
  meant credit never released - found and fixed); an un-fittable head
  stays queued at its stream front (it used to be dropped with its send
  promise never settling - found and fixed); per-stream FIFO with
  round-robin rounds, stream 0 selected first each round and never
  window-gated; strictly-increasing acks must land exactly on an
  outstanding frame boundary - regression/duplicate, beyond-sent, and
  off-boundary values fail the channel via onError; queue caps 4 MiB /
  4096 frames / 4096 outstanding; cancelStream releases queued work
  only (outstanding frames still ACK-consumed).
  `dispatcher.ts` contract rows: HTTP allowlist exactly `/health`,
  `/api`, `/api/*`, `/auth`, `/auth/*`; WS allowlist exactly
  `/api/global/event/ws`, `/api/event/ws`, `/api/terminal/ws`,
  `/api/dictation/ws`, `/api/dev-tunnel`; hop-by-hop strip both ways +
  CR/LF header drops; `x-openchamber-relay-connection` + loopback origin
  injected (client origins overwritten); synthetic 403/400 JSON responses
  always name `{error, reason, source:'relay-tunnel-host'}`; request
  bodies buffered <= 512 KiB and forwarded as ONE concatenated body
  (content-length framing) only at StreamEnd; `hasBody` with zero body
  frames aborts ('tunnel request body frames were lost'); the 15 s
  delivery deadline is armed at the hasBody request (not at the first
  body frame - a body whose frames never arrive would otherwise stall
  forever) and clears on finish/live-switch/abort; > 512 KiB switches to
  a live web `ReadableStream` body with `duplex:'half'` fed from the
  buffered prefix (the async-generator body shape was wrong for undici -
  extractBody refuses it; the controller rewrite also closes the live
  stream at the client StreamEnd); response bodies chunked 8 KiB under
  flow control, full budget otherwise; WS sub-streams allowed only on
  the WS allowlist (fragment reassembly in through the per-stream
  assembler, re-chunked out, closes clamp 1000..4999 default 1000,
  refusals answer 1008 without dialing), Ping -> Pong on stream 0,
  DeliveryAck -> scheduler (the wire carries 8 B payload; the earlier
  9 B frame-wrapped test feed was the contradiction - fixed test-side),
  unexpected HttpResponse/WsOpened inbound ignored, duplicate ids abort
  both sides + upstream abort, StreamAbort/dispose abort the fetch or
  terminate the loopback socket.
  Adversarial fixes, all regression-tested: fragmented NON-WS tunnel
  frames are now refused at the frame entry (the codec guard existed but
  the dispatcher never enforced it - a fragmented HttpBody would have
  fed a truncated payload); `isWsOpenPayload` dereferenced an absent
  `protocols` (a guard-side TypeError swallowed by `parseJsonPayload`
  answered every valid bare-path WsOpen with 1008) - fixed in the codec;
  the request lifecycle runs DETACHED from `handleFrame` (the inline
  fetch/wait stalled the frame pump so the client's StreamEnd could
  never arrive during a live transfer); the loopback-fetch failure path
  aborts the stream state it failed (it used to leak an open count);
  loopback sockets/pools get `closeIdleConnections` hygiene in the
  harness. Tests 18 (p8-2-relay-dispatcher.test.ts).
  NOT in this slice: the client-side section 3.10 surface (deferred to
  the pairing/UX slice), and WS-downstream backpressure stays
  eager-enqueue (upload pacing is client-side; the bounded-queue abort
  page rides the pairing/UX slice); the batcher+scheduler wire into the
  leg and the leg-level 1011 closures LANDED with P8-3a.
- NOT yet in: password/JWT/cookie sessions, scope classifier + tunnel
  gate, passkeys, and the relay stack are now in; NEXT: pairing store +
  §5.4-5.7 + candidate refresh (9/§3.13), tunnels (10), pairing+instance
  UX (11-12), SSH (13), reverse proxy (14), invariants (15).
- **P8-3a (delivered this slice)** - checklist step 8 tail: the relay HOST
  SERVICE lifecycle (§3.12), the machine claim, the §3.15 management
  routes, the §3.13 relay candidate + /health serverId (E-08-2), and the
  PRODUCTION leg mux assembling §3.5-3.9.
  `relay-config.ts` - the machine-owned `{enabled, relayUrl}` store in
  `<dataDir>/relay-config.json` (E-08-28: dedicated file until the settings
  registry gains relay keys; 0600 atomic tmp+rename; STRICT reader flags
  corrupt presence and `write()` refuses — the service never heals a
  drifted shape, mirrors the E-08-23 posture); env helpers: relay URL
  chain env -> stored -> default `wss://relay.openchamber.dev/ws` with
  `relayUrlLocked` pinned by a valid env, hold-out rows (§11.1:
  `NOTNATIVE_RELAY_HOST` off/on + `NOTNATIVE_ELECTRON_DEV` with the
  on-override), and the batch-window env (1..5000 clamp, default 150)
  consumed by leg batches (review P2: the helper was dead until wired).
  `host-lock.ts` - `relay-host.lock` = `{pid, claimedAt}` w/ injectable
  liveness: tryClaim only vs NO LIVE claimant (kill(pid,0); ESRCH stale
  claimable; EPERM alive), forceClaim unconditional (pairing/enable),
  release deletes only the owner file, corrupt read == no-claim (the
  worker 4001 arbitration is the authority per the pre-lock posture),
  claimed/contended/write-failed tri-state (review P1: a write failure
  must behave pre-lock — the host still starts; warn dedupes per failure
  streak and re-arms on success).
  `host-service.ts` - RelayHostService: reconcile = Promise.allSettled
  demand signals, ANY affirmative wins, a failed check with no affirmative
  THROWS (never fake no-demand); demand true -> persist `enabled:true` +
  start, false -> persist + stop; sources = boot, the 60 s poll (tests
  retime), and future pairing/revoke call sites (ensureEnabledForPairing/
  candidate now; revoke/purge join the pairing slice); claim arbitration:
  non-force start tryClaims, a live foreign claimant stands the host down
  into `standby` with the pid-naming lastError, the 30 s watcher re-tests,
  a freed claim is taken ONLY after the 120 s grace (both the watcher and
  the demand path honor it), a FRESH boot tryClaims instantly ("clean
  restart always wins the window"); hold-out instances never host on
  boot/demand/watcher but DO on explicit force (§3.15 enable /
  ensureEnabledForPairing), reporting a standby-style state with an
  explanatory lastError; `disable()` persists false, stops the host and
  RELEASES the claim but KEEPS the poll/watcher machines armed (review P1:
  after disable, a later headless pairing write must be able to re-host —
  the poll is the recovery path); `enable()` normalizes (ws/wss kept,
  junk/absent falls back to the default), persists, RESTARTS force-claim;
  `ensureEnabledForPairing()` writes enabled, force-claims (no churn when
  running), returns the candidate; cor Config corrupt => ensure/enable
  THROW (route 500), disable degrades to off. getStatus answers
  `{enabled, state disabled|connecting|connected|reconnecting|standby,
  serverId, connectedClients, relayUrl, relayUrlLocked, lastError}` with
  the multi-instance signature text. Singleton `getRelayHostService()`
  shared by boot + routes (boot options win; routes resolve option-less).
  `routes/relay.ts` - §3.15 rows behind the global UI gate inside the
  registerApiSurfaces block (before the /api proxy catch-all): GET status
  (200/500), POST enable `{relayUrl?}` JSON w/ a 16 KiB BOUNDED reader
  (400 on oversize/non-JSON/non-string — review P2: the body was buffered
  before the cap), POST disable. `index.ts` boot: `getRelayHostService
  ({demandSignals:[uiAuth.hasActiveRelayClients], localPort: ENV.port,
  platform: runtime, appVersion: version}).start()` + shutdown dispose;
  the pairing-session demand signal (§5.4 hasActiveRelaySession) JOINS
  with the pairing store slice.
  `/health` gains `serverId` (E-08-2) via the SHARED identity
  singleton (`getSharedRelayIdentityStore`, same-dir rebinding for test
  suites + reset seam) and `peekRelayServerId()` fail-soft resolve — never
  a 500 on identity trouble; /ui-auth gained the hasActiveRelayClients
  accessor so the demand signal never builds a parallel store.
  `leg-host.ts` + assembly - the production leg mux per established E2EE
  leg: ingress = broker's decrypted frame payload -> MIXED-MODE demux
  (E-08-30: [0x00] single, [0x01] N-frame batch, else BARE frame — the
  §3.7 carrier ships envelope-free setup/teardown/keepalive; the demux
  rule is parse-validated: 0x01 is a container ONLY when an exact
  multi-segment run of buffered-type frames parses, otherwise bare-frame
  fallback, fail-closed junk -> channel error) -> per-(stream,type)
  fragment assembler -> dispatcher.handleFrame; egress = dispatcher ->
  OutboundFrameBatcher (offerEncoded entry, buffered types only, window
  env consumed, timer unref'd) -> raw carrier = broker.sendToClient; the
  channel failure seam is ONE-SHOT (dispatcher failLegSafe now disposes +
  reports; scheduler onError joins) and the leg closes 1011 named.
  `dispatcher.ts` gained `onChannelFailure` + `sendFrameNow` (terminal
  rows — the 1008 refusal, the upstream-close mirror, and the
  StreamAbort-after-release — bypass the §3.8 queue because their own
  `releaseStream` cancel would otherwise eat the not-yet-pumped frame;
  the batcher still flushes pending work first so per-stream order holds:
  the wire probe caught the lost 1008). Broker: `terminateLeg` public;
  `onLegEstablished` carries the NEGOTIATED caps so the leg mux knows
  batch/flowControl truth. `loopback-adapters.ts` gained the production
  `ws` dial (RealLoopbackSocket: origin + x-openchamber-relay-connection
  injected, 16 MiB maxPayload, CONNECTING-queued send, close/terminate;
  the E-07-3 loopback posture verified: the dial is 127.0.0.1 so the wire
  gate classifies local; the device still brings its own URL token/cookie
  — no credential injection, §3.9/§3.16). The dispatcher file-cap extract
  pulled TunnelRequestBody into `request-body.ts` (P8-2c convention).
  Review fixed P0×2: (1) dispatcher 511 lines -> request-body extract;
  (2) THE 0x01 COLLISION — type 1 HttpRequest IS byte 0x01, so every
  spec-compliant bare setup frame vs the container tag was ambiguous and
  the first rule 1011'd every client leg; the demux rule now parses the
  length-prefix run instead of trusting the tag (residual aliasing is
  unreachable for JSON payloads; documented in batch.ts). P1×3: claim
  write-failure stood hosts down (tri-state), disable() killed the
  machines, unhandled-rejection surface on the direct carrier (sendFrame
  no-flowControl + leg-host no-batch + sendFrameNow convert to the
  one-shot fail). P2×3: batch-window env consumed, bounded enable body,
  batcher timer unref. Tests 45 across three files: p8-3-relay-host-lock
  (17: config round-trip/corrupt-refusal/ws-shape, claim
  claim/own-refresh/stale/EPERM/release-only-own/corrupt-overwrite,
  env chain/hold-out/clamps), p8-3-relay-service (22: the demand matrix
  incl. throw-aborts + affirmative-wins, hold-out suppression + force
  bypass, foreign-claim standby + watcher stand-down + 120 s grace +
  boot instant reclaim + poll-resumes-after-disable, ensure/enable/disable
  truths incl. corrupt 500s, §3.15 routes through the real gate w/ the
  400 shapes, /health serverId), p8-3-relay-wire (6: the PRODUCTION wire
  E2E — real broker + leg mux + real loopback stub: HTTP both ways incl.
  a BARE HttpRequest frame, WS upstream both ways with real WsOpen/WsClose
  codes, replay closes the leg; the loopback fake worker extracted to
  `__tests__/helpers/relay-fake-worker.ts` and shared).
  NOT in this slice: client §3.10 surface w/ the E-08-27 window
  heuristics + §2.5 passkey client lib (pairing/UX slices); SSH/host-lock
  over network claim detail beyond process.kill; the settings-registry
  relay keys (E-08-28 dedicated-file posture until then); /api/system/
  shutdown's requireShutdownAuth tunnel-scope flavor rides the doc 03
  system-family route; tunnel TTL settings keys ride the tunnels slice.
- **P8-4a (delivered this slice)** — checklist step 9 server half + the
  E-08-13 route family: the pairing session store
  (`lib/auth/pairing-sessions.ts`, `<data-dir>/client-pairing-sessions.json`
  version 1 @0600 atomic; id `pair_`+12 B hex, secret 32 B b64url hashed,
  fingerprint XXXX-XXXX, TTL 10 min, kinds default mobile+desktop,
  `usesRelay` from the link), redeem one-time semantics with the mint
  retry-safe tail (a thrown mint leaves the session redeemable), sweep
  retention (used/cancelled until inactive+TTL, unredeemed drop at
  expiry), sync single-threaded store (E-08-32). The client-auth route
  family `routes/client-auth.ts`: redeem rides BEFORE the /api gate
  (anonymous, 10/5 min keyed raw-socket:pairingId, sliding window, no
  lock phase; success clears the bucket; one generic error for every
  failure class incl. 429); the gated family (authority = UI session |
  desktop-local | open mode; plain tokens self-only) — clients
  list/create/revoke/purge, pairing sessions create/list/cancel, the
  §3.13 candidates refresh (client-reached local address first, then
  the interface scan, relay last, serverId rides; loopback auto-origins
  never advertised; NEVER URL-token-authorized, ironically free from
  url-tokens.ts allowlist), §3.13 transports view (LAN from the server
  bind: concrete non-loopback bind passes through, wildcard scans the
  LAN IPv4, loopback bind -> null), candidate math (serverUrl primary
  10, request-origin extra 20 when different+not-loopback, https
  -> tunnel type, relay 30 via ensureEnabledForPairing when requested,
  legacy getPairingCandidate when defaulted, never when
  includeRelay:false; 400 'No usable pairing candidate' when an
  includeDirect:false link has no relay). Reconcile call sites wired:
  session create/cancel/redeem + device revoke/purge fire-and-forget
  with the demand matrix from index.ts gaining the
  `hasActiveRelaySession()` signal (`hasActiveRelayClients()` joined).
  Shared bounded-body reader extracted to `lib/http/read-bounded.ts`
  (auth/relay private copies reduced). Tests 42 (p8-4a-pairing-store 15,
  p8-4a-client-auth-routes 12 + p8-4b-client-auth-authority 15 across a
  shared `__tests__/helpers/client-auth-harness.ts`: one dataDir per
  worker, once-built app — routes carry the redeem limiter state).
  NOT in this slice (_SYM client halves + tunnels): the section 6.4
  desktop restore/hot-switch probe + mobile reprobe (steps 11-12), the
  §5.8 QR render + §5.9 CLI connect-url surface (they ride the UX/CLI
  slices), tunnel bootstrap + providers (step 10), E-08-27 window
  heuristics, SSH (13).
- **P8-4a review fixes (adversarial sub-agent ses_f48d0a552ffejimD2JyQP6KHkP;
  P0×1 + P1×2 + P2 cluster)**: P0 — the auth-family singletons defaulted
  `dataDir ?? ''` while the relay service defaults via ENV.dataDir: a
  stock launch (env unset is the NORMAL condition) built
  `/client-pairing-sessions.json` and 500'd pairing create (split-brain
  with the identity dir). Fixed: pairing store + ui-auth controller
  default through ENV.dataDir (homedir fallback). P1 — redeem catch
  classified EVERYTHING as the generic 400 after minting (a disk-full
  write fault was attacker-facing AND rate-bucket-charged AND the minted
  token undelivered): typed `InvalidPairingSessionError` (the one-string
  contract) vs `PairingStoreFault`, store rolls the usedAt/clientId
  stamp back on a failed save (consume-on-confirm), route 500s faults
  WITHOUT charging the bucket. P1 — GET pending-sessions/transports were
  any-bearer; now manage-authority (session | desktop-local | open) 403
  'Client tokens cannot read the pairing surface' (candidates refresh
  correctly stays bearer-wide per §3.13). P2 cluster — registerClient
  split (device routes vs pairing+candidates registrars, 60-line cap),
  dead `void store === undefined` line removed, empty label accepted as
  unset (store normalizes null; route no longer 400s whitespace), cancel
  of a USED session answers {cancelled:false} (E-08-33g: one-time grants
  have nothing left to revoke), mkdir 0700 dirs (§12.2, both stores),
  wildcard bind names (0.0.0.0/::) rejected as serverUrl, fireReconcile
   on ensure-failure exits (503/500 clear the half-enable promptly
   instead of waiting for the poll).
- **P8-4c (delivered this slice)** — checklist step 10 (tunnels): the
  capability registry (`lib/tunnels/tunnel-capabilities.ts`, cloudflare
  quick/managed-remote/managed-local + ngrok quick with exact
  requires/supports/stability + per-platform install hints), §4.2
  normalization/validation (`tunnel-validate.ts`: blank-mode/provider
  fallbacks vs extant-unrecognized 422s, intent/mode matching incl.
  private-network as a recognized-but-unmatched string, configPath
  `~`/absolute + home containment (case-insensitive win32), hostname
  lowercase/wildcard/empty rules, token whitespace with the
  raw-value remediation text, `TunnelServiceError` codes mapped
  400/422/500). Provider drivers (§4.3): `cloudflare-quick.ts` (temp HOME
  + USERPROFILE/APPDATA on win32, CF_TELEMETRY_DISABLE=1, URL regex over
  both streams, 30 s kill + cleanup with the exact error text),
  `cloudflare-managed.ts` (managed-remote `--token-file` 0o600 temp file
  never argv, stdout drained by the readiness sink without logging,
  stderr mirrored; managed-local default/config with the guarded reads
  ≤256 KiB, yaml/JSON ingress hostname, --config only when requested,
  fatal/ready pattern sets + 6 s liveness + 20 s hard timeout),
  `ngrok-tunnel.ts` (env authtoken → `config check` with the
  add-authtoken remediation, api.ngrok.com 5 s gate, JSON-log +
  127.0.0.1:4040 API poll harvest (https preferred, ngrok-host
  validation), summarizeNgrokOutput precedence, 30 s timeout). Shared plumbing:
  `tunnel-spawn.ts` (PATH/PATHEXT + WindowsApps alias scan, `--version`
  probes with 5 s timeout, .bat/.cmd never resolved, spawn deps seams +
  `rmTempDir` with EBUSY-tolerant retries), `tunnel-readiness.ts`
  (bounded sink + fatal-first pattern wait), `tunnel-controller.ts`
  (guarded-stop idp contract). §4.4 profile store
  (`tunnel-profile-store.ts`, `cloudflare-managed-remote-tunnels.json`
  v1 0600 promise-locked writer, sanitize-on-read/write, dedupe by id
  AND hostname first-wins, upsert conflict removal + explicit-heal of a
  corrupt store, legacy cloudflare-named-tunnels.json migration kept in
  place, resolveToken presetId-then-hostname, token-free API views).
  §4.6/§4.7 service + routes: `tunnel-service.ts` (promise-mutex starts,
  one-controller invariant, same-config reuse vs replacement with
  tunnelId persistence across idempotent re-starts + controller deaths,
  §4.7 failure path detach-without-revoke, stop retained w/o controller,
  lazy dead-controller status re-sync, §4.4 token resolution chain
  request→store→settings with type-junk passthrough into the
  normalizer), `routes/tunnel.ts` (check/providers/doctor with the
  CLI-parity `hasSavedManagedRemoteProfile=1` + POST body never echoed +
  managed-local config probe, status lifecycle shape, managed-remote
  token upsert, start with the one-time connectUrl, stop with counts;
  doctor disagreements mapped per §5.34: provider/mode unsupported
  doctor 400 vs start 422). Settings: seven §11.2 keys registered in the
  canonical UI registry + snapshot (token secret:true), TTL re-clamps
  wired into both settings PUTs, `tunnel-settings.ts` (defaults reader +
  §4.7 env startup request under NOTNATIVE_TUNNEL_*), `index.ts` tunnel
  plane (TTL panel + service seeding + startup tunnel that never aborts
  boot + shutdown dispose). system/info gained the tunnelUrl view
  (GATED — E-08-35). Adversarial review fixed (ses_f4859e55bffevrAmsmKa493OW0,
  P1×2 + P2 cluster, all pinned in tests): tunnel-scope visitors may read
  the diagnostics family but never start/stop tunnels or write
  run-token profiles (operator-guard routes, E-08-37); TTL wire junk
  now rides the clamp default instead of disabling expiry; win32
  USERPROFILE/APPDATA join the quick-tunnel temp-HOME isolation;
  temp-dir removals bound-retried + guarded against stopping a
  half-finished stop; `/connect` limiter keys by socket address (XFF
  only as the no-socket fallback, §8.5 anti-spoof); yaml parse errors
  no longer echo config lines into responses; doctor mode validation
  (400 {ok:false}); settings PUTs ride the bounded reader (512 KiB);
  ngrok stdout listener deduped; spawnSync probes timeout; .bat/.cmd
  never launch targets; buildRequest passes type-junk into the
  normalizer so wrong types 400 instead of silently starting with
  stored secrets. Tests +44 (p8-4c: core 15, profile-store 12,
  providers 22, ngrok 12, service 11, routes 14 across
  helpers/tunnel-fakes.ts + tunnel-service-kit.ts + env-boot.ts), web
  401 total; the settings-store seed change (E-08-40) covered by the
  existing p5-3 suite.
  NOT in this slice: Ngrok-Skip-Browser-Warning CORS preflight
  (E-08-38 note; no CORS middleware in the rebuild yet — reverse-proxy
  slice), CLI tunnel commands/profiles (doc 03 CLI slice), the §5.8/5.9
  pairing UX + connect-url (steps 11-12), per-request connectTtlMs/
  sessionTtlMs overrides on start (E-08-36).

- **P8-5a (delivered this slice)** — checklist step 7 tail + the client
  half of steps 11-12: the relay CLIENT mirror ships as the ui-side
  contract (`packages/ui/src/lib/relay/`, browser-safe: Uint8Array +
  globalThis WebCrypto, no node:buffer/DOM types — the server tsconfig
  compiles the same files). `bytes.ts` (base64url/BE helpers, Node-codec
  vector parity); `protocol.ts` (frame numerals, 5 B header, close-code
  policy 4010/4002/4029 terminal + 1011/1012/1006, §3.11 timing
  constants, odd stream ids from 1); `crypto.ts` (Layer 2: ECDH P-256 →
  HKDF-SHA-256 → two AES-256-GCM keys, IV = 4 B random prefix + 8 B BE
  counter from 1, >2^53-1 counter rejected pre-GCM, fail-closed decrypt,
  hello/ready grammar; subtle rides `typeof crypto.subtle` so DOM and
  node both compile); `handshake.ts` (client initiator: 1 s l s hello
  retries + 30 s deadline, duplicate ready ignored, 1011 on
  timeout/binary-before-established); `tunnel-codec.ts` (Uint8Array
  frames, WS-only fragmentation with the 16 MiB bound + 256-slot partial
  groups, §3.7 container DEMUX in the [0x00]/[0x01] mixed mode — the bare
  HttpRequest fallback is pinned byte-exact against the host demux —
  payload guards per E-08-24); `tunnel-payloads.ts` (tunnel.invalid
  normalization, INLINE path?query with the query record left empty —
  byte-faithful search params through the host's
  `path + loopbackQueryOf(query ?? undefined)` dial —
  buildClientRelaySocketUrl with the exact §3.3 role=client URL and the
  openchamber wire strings (E-08-25), grant rides the URL only);
  `tunnel-acks.ts` (§3.8 ledger: cumulative raw nonzero frame bytes with
  5 B headers, keepalives excluded, per-handshake reset, inline at
  16 KiB + 10 ms tail, never awaits credit); `transport-error.ts`
  (ambiguous tagging, non-enumerable flag); `wire-socket.ts` (platform
  WS seam, binaryType=arraybuffer); `tunnel-client-fetch.ts` (§3.10
  fetch: string/AB/view = one chunk, ReadableStream streamed,
  Blob/FormData/URLSearchParams probe content-type via a throwaway
  Request, empty stream body = ONE empty HttpBody, abort = plain
  AbortError + StreamAbort, body.cancel() → StreamAbort, 204/205/304
  build null-body Responses (E-08-43), request-body read failures settle
  ambiguous (E-08-46), Request-object body/signal fallback native-parity);
  `tunnel-client-ws.ts` (native shape: readyState only via real
  WsOpened/WsClose, send-before-open exact text, local WsClose keeps the
  link until the host echo completes onclose, CONNECTING close kills the
  host dial, messages fragment through the budget, >16 MiB pre-checked,
  host StreamAbort → 1006 / channel death → 1012 (E-08-47));
  `tunnel-client-inbound.ts` (ledger counts every decoded frame BEFORE
  dispatch, assembler per (streamId,type), Ping → Pong stream zero,
  well-formed unexpected ignored, malformed fails the channel);
  `tunnel-client-outbound.ts` (§3.7 client outbound containers gated by
  the NEGOTIATED batch capability; buffered types only, setup/keepalive
  flush first, 24 KiB/32 cap, leading edge instant, teardown drops);
  `tunnel-client.ts` (the machine: generation-gated wire handlers,
  sendChain encrypt serialization (one encrypt = one WS message = one
  counter tick, wires in order) + recvChain for the counter check,
  INBOUND-driven keepalive honoring ping interval/timeout options, §3.11
  backoff base × 2^completedCycles cap 30 s (60 s offline/hidden), wake
  fast-path hooks, fetches racing the connect attempt are QUEUED and
  rejected UNTAGGED when the attempt fails (§6.6 posture), terminal
  codes retain + fail fast forever, closedGenerations → a single
  watermark, lane + abort-listener releases everywhere (E-08-48), send
  crypto failures fail-closed, wire-factory throw → failChannel).
  Runtime integration: `runtime-tunnel.ts` (byte-equal descriptor reuse —
  grant + canonical JWK JSON — terminal-dead reuse refused (E-08-49);
  adoptRelayTunnel joins the status fan-out (E-08-49); grant stays
  memory-only); `runtime-switch.ts` (relay activation BEFORE the eager
  §6.0 mint, null relay deactivates); `runtime-fetch.ts` (relay mode
  transports through the tunnel, read coalescing both modes);
  `runtime-auth.ts` (the URL-token mint rides the tunnel in relay mode;
  mint failures clear the shared token atomically, never an empty window
  (E-08-45)); `runtime-socket.ts` (openRuntimeWebSocket = the sanctioned
  socket op). HOST side: `downstream.ts` carries the E-08-27 heuristics
  live — grow ×2 only when a head was BLOCKED by the window AND the ack
  delivery delay is ≤ minRtt + 50 ms; halve when the delay exceeds
  minRtt + 100 ms (floor 64 KiB, cap 1 MiB); one adjustment per window
  (checkpoint = latest ack + the CURRENT post-adjust window, E-08-42);
  the window-latch only arms on pump-skipped heads (sparse traffic never
  inflates); stream-zero-first rounds; `now` clock seam for the gates.
  `dispatcher.sendFrameNow` + the wsBridge refusal/close rows route
  `scheduler.sendNow`: terminal rows bypass the §3.8 queue but STAY
  ledger-accounted (E-08-41) — the review proved every mirrored WsClose/
  StreamAbort row acked past `outstandingBytes` and failed the channel
  1011 forever. Tests: ui +39 (relay-primitives 21, fake broker +
  tunnel-client 14 incl. reconnect/terminal/pong-deadline/ledger parity
  /local-close echo/backoff-by-measurement, runtime-tunnel 4) + web 13
  (p8-5a E2E 6: the REAL client over the production host-service leg —
  GET/POST streaming, the >64 KiB ack-driven response, WS both ways with
  code propagation and a post-close fetch proving sendNow accounting,
  keepalive, client-leg replacement reconnect; p8-5a-downstream-window
  7: deterministic grow/halve/checkpoint/ack-law/cancel suites). web
  413/31 files, ui 428/53, both tsconfigs clean, gates + graph (294) +
  smoke pass, sealed 20260919-1.
   NOT in this slice (the step-11/12 UI faces): §2.5 client passkey lib,
   §2.8 expiry store + §6.6 SessionAuthGate + §6.7 banner, §6.1 pairing
   dialog + §5.8 QR, §5.9 CLI connect-url (needs the doc-03 CLI
   framework, registered for its own slice), §6.4/§6.5 desktop
   probe/restore (desktop IPC = doc 09/P12); app transports (terminal,
   harness streams) keep direct-mode wiring until the desktop/mobile
   phases call openRuntimeWebSocket.

- **P8-5b (delivered this slice)** — checklist steps 11-12 UI faces
  (§2.5 passkey client lib, §2.8 expiry detection, §5.1-5.8 payload/QR
  + pairing dialog, §6.6 gate + §6.7 expiry banner; the §6.4/§6.5
  desktop host surfaces stay P12 as registered in P8-5a). UI side:
  `connection-payload.ts` (both §5.1 parsers - URL-first + the Android
  WebView regex fallback sharing `normalizePairingPayload` w/ the
  16384 three-surface cap, v2-only, future-expiry rule, candidate
  normalizers incl. relay JWK strict-normalization), `pairing-client.ts`
  (§5.6/5.7 candidate racing - identity-gated direct probes, relay last
  through a throwaway tunnel, needs-login short-circuit, one body per
  redeem; `planPairingRequest` scope forms - loopback/local option,
  LAN with the fallback checkbox, anywhere relay-default; §6.1 transport
  selection from the /transports view), `pairing-qr.ts` (§5.8
  `qrcode` toDataURL width 1024 margin 2 level L - resolution over
  error correction - link exactly as text), `pairing-watch.ts` (§6.1
  step 8 result machine: redeemed/expired/cancelled close reasons,
  visibility-gated hidden spins, no redemption faked on fetch failure),
  `passkeys.ts`+`passkeys-support.ts` (§2.5 ceremonies over a session-
  capable runtime seam: support detection, registerCurrentDevicePasskey
  one shot, authenticate, list/revoke/reset faces with the server's
  disabled-unless-password + one-generic error shapes), and the §2.8
  `runtime-auth-expiry.ts` (classifier narrowed to /api|/auth minus the
  probe + client-auth flows, 15 s nested confirm probe, same-origin
  filtering, focus/visibility revalidation ≥5 min, composer send-guard
  predicate `authSessionBlocksSend`). Components: `SessionAuthGate`
  (§6.6 stages incl. tunnel-locked without a password form, bounded
  4×1.5 s retry ladder, trust-device checkbox persisted on toggle,
  passkey unlock/enroll with a separate ceremony busy flag, re-entry
  from the banner via `reauthenticating`, host-switcher slot,
  `skipAuth` for the VS Code rail), `AuthExpiredBanner` (non-blocking
  under-header one-store consumer, Log in never self-logins), and the
  pairing dialog family (`PairingDialog/ScopeForm/ResultPanel` +
  reducer/live hooks: 5 s visible-client input-free polling, countdown,
  copyable link, QR, panel phases per §6.1). WEB-parity faces pinned by
  the p8-5b harness suites (route shapes + payload byte-parity through
  the real ui client against the sealed server routes).
  App wiring (the §6.6/6.7 activation, previously library-only): main.tsx
  mounts `SessionAuthGate` above App per the doc-01 provider tree so a
  locked visitor never boots the app; App installs the §2.8 focus watch;
  MainLayout renders the §6.7 banner under the header; the composer send
  guard (button + Enter path, data-send-blocked) honors
  `authSessionBlocksSend`; the gate releases the HTML splash on its
  first answered probe; trust-device key rebranded
  `notnative.uiAuth.trustDevice` per NOTES/01. Registered E-08-50/51/52
  (no ThemeSystemProvider layer; sequential probe/support presence
  assembly; relay-consent `includeRelay:true` force-start with the
  anywhere-preflight refusal). Adversarial sub-agent review
  (ses_f3ee2b0a7ffe67K6YxJaLot3Yj) fixed P0×1 + P1×3 + P2×1 in-slice:
  P0 passkey transport failures wedged gate busy/deadlock - the
  tolerant status-0 degrade now covers every ceremony face
  (options/verify/list/revoke/register paths); P1 `planPairingRequest`
  dropped the operator's relay consent (checkbox now rides
  `includeRelay:true`, 503 surfaces as a create error); P1 gate
  re-entry on a tunnel lock wrongly cleared the expiry store
  (only `authenticated` marks ok now); P1 PairingDialog rendered its
  modal while `open:false`; P2 main.tsx provider-tree comment named a
  non-existent ThemeSystemProvider layer. Tests: ui 577/61 files (+149
  vs the P8-5a seal; +7 of those from the review fixes: passkey
  transport tolerance 5, tunnel-lock re-entry, open:false) +
  web 438/33 (+25 p8-5b route-shape/payload-parity); suites
  composer-auth-guard 3, app-composition 2, auth-faces + pairing-dialog
  + passkeys + pairing + session-auth-gate + runtime-auth-expiry
  delivered with the slice. ui/web typechecks + controlled-language +
  length gates green; graph + smoke + seal at 20260920-1.

- **P8-5c (delivered this slice)** — checklist step 11 tail: the
  §5.9 `connect-url` CLI command (doc 03 S10 CLI framework seeded with
  it; the rest of the S10.1 inventory is the P4 CLI slice, roster
  errors exit 2 with a Levenshtein suggestion). `packages/web/src/cli/`:
  `args.ts` (long + `--foo=value` + short aliases + `--no-x` booleans,
  CliUsageError=exit 2), `output.ts` (S10 modes: --json wins over -q,
  human decorations TTY/NO_COLOR gated; warnings reach piped stdout),
  `instances.ts` (probePortHealth + ensureServerRunning: detached spawn
  of `node <abs>/server/index.ts` with openSync lp fds (never the
  launcher's stdio), 30 s readiness poll, `<data-dir>/instances/
  notnative-<port>.json` record; timeout = SIGTERM own-child + record
  removal + CliRuntimeError exit 5), `connect-url.ts` (the exact S5.9
  resolution order: --server normalize (junk/scheme = usage exit 2,
  WHATWG-canonicalized) > --host full-URL passthrough (bind loopback)
  > concrete host http://host:port > wildcard LAN scan lan-detected >
  loopback-fallback; relay endpoint chain env > relay-config.json >
  DEFAULT; candidate builders ui-typed), `connect-url-command.ts`
  (direct + optional relay candidates; §2.6 identity lazy-mint from
  the shared strict store; pairing session created DIRECTLY in the
  on-disk store (usesRelay = link carries relay) - the S3.12 demand
  poll picks it up; link encoded through the SHARED ui encoder;
  warnings PASSWORD_NOT_SET/API_ONLY_DEFERRED; [RELAY_STARTING] when
  the config does not say enabled; [LAN_UNREACHABLE] on loopback
  direct; --qr via qrcode-terminal bound-module (bbox level L exactly
  like the doc) w/ throw withheld as [QR_UNAVAILABLE]; S5.9 --json
  exact shape; --quiet = link only w/ warnings on stderr), `main.ts`
  (dispatch, help overview vs topic, pending roster), `bin.ts`
  (exit-code mapping; CliRuntimeError 5). Registry grew
  qrcode-terminal; tsconfig gains src/cli + src/types;
  package.json bin `notnative` (NND brand of the reference binary,
  seam-naming row). Live smoke done manually: auto-start + discovery
  re-run both paths against real servers, then cleanup. Adversarial
  sub-agent review (ses_f3e4ff5b2ffelKEKfunoIX2JMs) fixed P0x1 +
  P1x5 + P2x4-chunk: P0 the pairing store is a boot singleton -
  CLI-created sessions were INVISIBLE to a live server (redeem would
  always fail) - every store op now refreshes from disk first
  (cross-process shrink to last-writer-wins, +4 tests in the
  p8-4a matrix incl. stale-redeem stamping) and save() tmp names pid
  (collide-on-millisecond two-writers); P1 --lan unparseable,
  flags-only/dispatch refused + positionals (exit 2), help pages
  split, readiness timeout KILLS the spawned child + record removal +
  exit 5 class, --quiet warnings to stderr (doc-only stdout); P2
  HTTPS case-sensitivity candidate type, --port 08/1.9 junk + -p=x
  syntax, address tokens that would build broken URLs, dead helper
  removed. Registered E-08-53 (doc 03 relay-only row superseded by
  doc 08 direct+relay), 54 (store op-start reload + pid tmp), 55
  (auto-start kill-on-timeout posture + concurrent-CLI probe->spawn
  record last-writer-wins accepted as advisory), 56 (public URL
  passthrough binds loopback), 57 (S5.9 exact JSON shape wins over
  the generic doc 03 messages[] row; warnings in human/quiet only).
  tests web 483/34 (+29 net: p8-5c 29 incl. parser/dispatch rows,
  p8-4a +3 cross-process) - ui 577/61 unchanged - typechecks x4 -
  gates green - graph (321) + smoke + seal 20260920-2.

- **P8-6 (delivered this slice)** — checklist step 13 UI-ownable half
  (doc 08 section 7 SSH remote machines; the S7.4 main-process
  internals - master ssh channel, installers, bundle upload, forward
  lifecycle, host-key prompts - are doc 09/P12 as the slice map
  states). `packages/ui/src/lib/desktopSsh.ts`: the S7.2 instance
  contract (DesktopSshInstance/StoredSecret/PortForward types,
  `parseSshCommand` - program-word excluded by case-insensitive
  basename, quoted groups kept, value-flag vocabulary w/ `-q` boolean
  per real ssh - destination = last positional, shipped `sshParsed` on
  the record), strict `normalizeSshInstance` (unusable = null;
  remote/local/auth groups defaulted; timeout clamp 5..600 default 30;
  forwards capped 64 w/ id minting + 1..65535 ports;
  E-08-58 bounds), `remoteLanNeedsPassword` (S7.3 remote-LAN bind
  rule), `needsSecretStorageConfirm` (store:'settings' confirm, doc-
  literal even when disabled - pinned w/ the disabled row),
  `suggestRandomLocalPort` (port-in-use retry helper),
  `sshRuntimeKey` (`ssh:<id>` scheme E-08-61). `desktopSshImport.ts`:
  `parseSshConfig` (~/.ssh/config Host aliases -> {host, pattern,
  source, sshCommand:'ssh <alias>'} rows, Match/Include/comments
  skipped, glob aliases pattern rows, whole-file dedupe - E-08-63
  simplifications) + `desktopSshImportHosts` bridge-guarded read +
  `importCandidateIsUseable`.   `desktopSshStore.ts`: the §7.3 store -
  a `DesktopSshBridge` seam {invoke, listenStatus,
  readSshConfig} (all doc-09 internals ride it), `SSH_BRIDGE_COMMANDS`
  vocabulary, `SSH_PHASES` exact machine + `normalizeStatus`/
  `isSshPhase`, `sortStatuses` (updatedAtMs desc; equal-stamp
  replaces, strictly-older pushes dropped - E-08-59), actions
  connect/disconnect/cancel/retry/upsert(in-place for existing ids)/
  createFromCommand/refusal traceability/remove + loadConfig +
  refreshStatuses + refreshImportCandidates (via the guarded read) -
  every trigger without a bridge records SSH_BRIDGE_UNAVAILABLE in
  lastError; the pushed stream survives config-read failure (listener
  attaches in both paths - E-08-64); statuses cleared with instances
  on `setBridge`; StoredSecret values mirrored verbatim per S7.2 with
  no echo paths (E-08-60 discipline). Statuses land via pushed events
  only (refreshStatuses = the one manual full pass). The shells
  surface ships with the P12 Remote Instances page; the store/module
  names stay spec-named for that wiring. Adversarial
  sub-agent review (ses_f3e23db48ffewK6wydq4mPWhyV) fixed P1x5 +
  P2x4 in-slice: P1 program-word exclusion (.exe/absolute paths),
  -q was a VALUE flag (mundane commands parsed destination-less),
  loadConfig failure orphaned the pushed-event channel, bridge-less
  triggers failed silently, createFromCommand refusal untraceable;
  P2 upsert rows jumped to the list tail, status port rule now
  consistent with the instance ports, setBridge kept stale statuses,
  candidate refresh bypassed the guard; equal-stamp + secrecy
  posture CONFIRMED correct w/ pins. Registered E-08-58..64. tests
  ui 599/62 (+22 desktop-ssh: contract/parse/import/store rows
  incl. the failure-path semantics) - web unchanged 483/34 -
  typechecks - gates green. Seal at 20260920-3 with the entry below.

- **P8-7 (delivered this slice)** - checklist step 14 (doc 08 section 9
  reverse-proxy posture, the server-side rows the proxy feeds).
  `lib/http/request-security.ts`: origin consumption with HOST
  equality only (the TLS-at-edge rule - protocol never compares),
  candidates host / x-forwarded-host (first hop) / the publicOrigin
  setting, packaged-client origins pre-allowed (case-folded), absent
  Origin passes, junk Origin fail-closed, bare-host headers parsed by
  regex (URL 'host:443' would otherwise read as a scheme) w/ the
  WHATWG default-port drop (:80/:443 and canonicalization :080==80)
  + an IPv6 bracket arm ([::1]:4090) - E-08-65 registers the
  judgment cluster + the direct-exposure XFF-spoof posture (browsers
  cannot set arbitrary WS headers; non-browser clients are not
  origin-bound; the E-07-3 loopback cap bounds direct exposure) +
  the bare-host slew. WIRED: terminal/wire.ts destroys upgrades whose
  Origin header is present and disallowed (loopback cap first, E-07-3
  credential gate after) - multi-valued Origin headers JOIN and fail
  closed (a doubled Origin masquerading as absent would be fail-OPEN);
  the dev vite proxy now sends origin:=apiTarget headers for the web
  AND ws passes (E-08-66, S3.9 dialer parity - changeOrigin fixes the
  Host while the gate reads the origin). app.ts: registerPublicHygiene
  (X-Robots-Tag noindex,nofollow on every response via c.header after
  next + disallow-all /robots.txt anonymous route) + onError
  errorHygiene belt (a rejecting compose would otherwise stamp no
  tag) + registerHarnessProxy extract (POWER10). Header rows for the
  §9 SSE contract stay pinned by the new suite (x-accel-buffering:
  no + no-cache,no-transform survived a LIVE control-stream body).
  Cookie Secure (x-forwarded-proto), passkey rpID
  (x-forwarded-host), redeem raw-socket limiter and the
  compression-one-layer rule (no middleware yet - doc 03 P4) were
  already sealed/pinned by their owning suites; this slice adds the
  posture rows that were missing. Adversarial sub-agent review
  (ses_f3e09f794ffe7LZlAYllgOdVxZ) fixed P1x3 + P2x2 in-slice: P1
  IPv6 hosts never matched (bracket arm + port canonicalization,
  raw-socket upgrade pin reaching 101), P1 the dev proxy would have
  killed EVERY dev terminal WS (origin overwrite queued in the
  proxy, not the gate), P1 doubled-Origin fail-open (multi-valued
  join), P2 hono-default 500s carried no tag (onError belt), P2
  packaged origins case-folded. Relay leg parity CONFIRMED (the
  dispatcher/WS dialers inject origin http://127.0.0.1:<localPort>
  which hosts render as 127.0.0.1:<localPort> - equality holds;
  p8-3-relay-wire + p8-5a E2E green). Registered E-08-65/66. tests
  web 503/35 (+13: origin rows incl. the two raw-socket upgrade
  probes + hygiene/stream pins) - ui unchanged 599/62 -
  typechecks x4 - gates green. Seal 20260920-4 with the entry below.

- **P8-8 (delivered this slice)** - checklist step 15, the S12
  invariants sweep, closing the doc 08 phase. The full row matrix
  lives in the new '## D. Invariants sweep (P8-8)' section: 42 rows
  audited - 30 already PINNED (named suites per row), 9 NEW pins, 2
  GAP-FIXED, 3 registered deferred/deviation rows. The new sweep
  suite `p8-8-invariants-sweep.test.ts` pins the static no-leak rows
  (server src carries no raw Authorization/cookie-header logging;
  every secret store writes 0o600 - the relay-host lane 0o644 stays
  the E-08-29 exception; client-auth routes answer only through the
  single no-store json helper; tunnel route bodies token-free except
  the sanctioned /connect?t= seat; ui runtime/relay files carry no
  persistence APIs) plus runtime rows (duplicate connected/sync
  announcements keep exactly ONE host-data dial - CountingIdentity
  dial counter; the leg failChannel never carries payload bytes -
  sentinel). GAP-FIXED: (E-08-69) `decodeTunnelFrame` accepted
  foreign frame numerals as ignorable noise in BOTH mirrors - now a
  CodecError 'unknown tunnel frame type N' fails the channel closed,
  with pins in p8-2-relay-primitives + the ui relay-parity test + the
  sweep sentinel; (E-08-67) `redactSensitiveUrl` (S12.1) did not
  exist - added `packages/ui/src/lib/redact-url.ts` doc-exact
  (userinfo strip; t|token|auth|secret|api query keys -> [REDACTED];
  verbatim passthrough) w/ its own suite, display-face wiring
  deferred to P12. New ui pins: Authorization parse-side filter in
  extra headers + memory-only bearer discipline (S12.3 parse half;
  write half is doc 09/P12 per E-08-68); terminal 4002 fails fast
  forever + the unknown close code rides the standard ladder, never
  grace. Registered E-08-67/68/69. The p8-3-relay-wire harness got a
  frame-targeted `frameCollector` replacing a latent per-batch
  consumption race (the P8-7-era flake diagnosed for real). tests:
  web 511/36 (+8: 7 sweep + 1 primitives) - ui 608/64 (+9 spread
  across relay/e2e/runtime rows) - typechecks x4 - gates green -
  graph (326) - seal 20260920-5. P8 PHASE COMPLETE: all 15
  checklist steps delivered and reviewed; remaining registered
  work rides other phases (P4 CLI/server middot-layer, P12
  desktop faces, doc 11 mobile).
## B. Adaptation deltas (registered)

- **E-08-34 (§4.7 failure-path interpretation, not doc-literal)**:
  on a failed START whose config differs from the active tunnel, the
  service stops the previous controller (§4.2 one-controller invariant)
  and detaches the active record WITHOUT revoking artifacts; a later
  successful start is a genuine URL replacement whose revocation covers
  everything (newest-token already voided by the detach, sessions marked
  'tunnel-revoked' per the replacement contract). The failure moment
  itself revokes nothing; the previous id/pinned sessions survive it.
- **E-08-35 (/api/system/info GATED)**: the reference exposes it pub;
  NND keeps every /api row behind the gate (an anonymous caller gets the
  non-sensitive version/serverId subset from /health) — pid/startedAt/
  port/tunnelUrl require the session.
- **E-08-36 (per-request TTL fields not honored)**: doc 03 §5.34's start
  request lists `connectTtlMs?`/`sessionTtlMs?`/`managedRemoteTunnelPresetName?`;
  NND tunnels are settings-governed (§11.2 clamps + §4.5) and the start
  fields are accepted-but-unhonored (documented in buildRequest). Revisit
  with the pairing/UX slice if a real caller needs per-request TTLs.
- **E-08-37 (tunnel-scope control guard, review P1)**: the §2.9 gate
  admits tunnel-session cookies to the whole /api family at tunnel scope,
  but START/STOP/managed-remote-token upsert are operator verbs — a
  stolen one-time link must not (a) stop the operator's tunnel for free
  or (b) point the instance at the attacker's own cloudflared head
  (persistent foothold; every later bootstrap link mints through their
  edge). `routes/tunnel.ts` guards the control family: device bearer /
  URL token admitted anywhere; local scope (open mode/session/cookie)
  operates the console; tunnel|unknown-public scope reads only
  (check/providers/doctor/status), writes answer 403
  {tunnelLocked:true, code:'tunnel_locked'}. Judgment call: tighter than
  the literal §2.9 admit-all reading, aligned with §4.5's "the tunnel
  session grants exactly the local-anonymous level and nothing above".
- **E-08-38 (startup tunnel env brand + deferred CORS)**: the §4.7
  startup request reads NOTNATIVE_TUNNEL_{PROVIDER,MODE,HOSTNAME,TOKEN,
  CONFIG_PATH} (NND brand of the reference OPENCHAMBER_TUNNEL_* family;
  provider/mode gate the request); the `Ngrok-Skip-Browser-Warning`
  preflight allowlist is DEFERRED to the reverse-proxy slice (no CORS
  middleware exists in the rebuild yet — the reference caveat applies to
  browser lodash preamble only).
- **E-08-39 (yaml dependency)**: managed-local configs are .yml/.yaml;
  the `yaml` package (ISC) implements the reference `yaml.parse`
  ingress-hostname extraction (JSON configs ride JSON.parse). Registered
  in docs/architecture/dependency-registry.json.
- **E-08-40 (settings-store seed posture)**: the review found that a
  FRESH dataDir with no settings.json left preferences.json absent, so
  `preferenceDoc()` treated "absent" like "corrupt" and the gated-write
  fallback path mirrored RAW values into settings.json AND echoed them
  into the response — a `managedRemoteTunnelToken` write on a stock boot
  leaked in its own response. Fixed: `seedPreferencesFromSettings` now
  seeds an EMPTY registry-gated doc when no legacy settings.json exists
  (the corrupt-PRESENCE refusal is untouched — only a MISSING file
  seeds). Covered by the existing p5-3 suite + the tunnel-core secret
  pins.

- **E-08-41 (terminal rows stay ledger-accounted; scheduler.sendNow)**:
  the review found the admissibility seam: the client ledger counts EVERY
  decoded nonzero frame (§3.8 mandate), but the host's mirrored WsClose/
  StreamAbort/refusal rows bypassed `scheduler.send` via
  `dispatcher.sendFrameNow` → their bytes acked past `outstandingBytes`
  → "beyond sent bytes" → channel 1011 on EVERY closed WS or cancelled
  request. `DownstreamScheduler.sendNow` ships the row synchronously
  (release-cancel cannot eat it) while pushing the exact raw byte count
  into the outstanding list, keeping boundary validation lawful. No
  client-side change (acking late rows of cancelled streams is the doc
  mandate). E2E-pinned: a post-WS-close fetch rides the same tunnel.
- **E-08-42 (window checkpoint = acked + the POST-adjust window)**: the
  doc's "boundary = latest ack position + window" is read with the
  CURRENT (post-adjust) window: after each adjust attempt the checkpoint
  is `ackedBytes + windowBytes` with the possibly-grown/halved value, so
  every adaptive cycle gets one full window of acks before the next
  evaluation. Deterministic grow/halve/checkpoint suites pin: latch-only
  from blocked heads, near-best grow (≤ minRtt + 50), delayed halve
  (> minRtt + 100, floor 64 KiB, cap 1 MiB), no per-frame oscillation.
- **E-08-43 (bodyless responses)**: a 204/205/304 head can never
  construct a Response with a stream body (undici throws); the client
  builds `new Response(null, …)` and drops the controller (the host
  should never send such heads - belt over braces, native parity kept).
- **E-08-44 (client outbound batching ships)**: §3.7 is a negotiated
  optional capability; the client sends one frame per decrypted message
  when `batch` is false, and through the same container shapes
  (`[0x00]`/`[0x01](len+frame)*N`) when negotiated true - buffered types
  only, setup/keepalive flush first, 24 KiB/32 caps, leading edge
  instant, teardown drops un-flushed work, `batchWindowMs` honored
  (previously a dead option).
- **E-08-45 (URL-token mint failure clears the shared token)**: §2.6's
  "mint failures clear the shared token; no empty-token window" is now
  honored - every mint failure (transport/log/HTTP !ok) resets the
  token field to null in one atomic write; consumers never see an
  empty-string token, and a 60 s-old consumed token cannot serve again.
- **E-08-46 (client fetch semantics pinned)**: Request-object inputs
  fall back to the Request's own body/signal when the init omits them
  (native fetch parity; a consumed stream still errors plainly); a
  body-pump failure REJECTS the fetch as ambiguous (the head already
  reached the wire) instead of leaving the promise unsettled; Path+query
  ride INLINE in the HttpRequest payload (the query record stays empty —
  byte-faithful through the host's dial), documented against the shape
  guard's optional query record.
- **E-08-47 (local WS close completes via the echo)**: local `close()`
  sends WsClose (also for a CONNECTING surface — it kills the host's
  pending loopback dial), flips the surface CLOSED at once (native
  shape), keeps the link record until the host's clamped WsClose echo
  routes `onclose` exactly once; channel death closes 1012 with the
  echo-free path as before. The onmessage handler attached AFTER the
  close never fires (deliver guards on `closing`).
- **E-08-48 (client bookkeeping releases)**: fetch lanes release on
  StreamEnd/StreamAbort/WsClose/channel resets (late frames of finished
  ids are already ignored and stay ledger-counted); abort listeners
  detach on every settling path (per-lane detach hook); scopedGenerations
  shrink to a single watermark closing guard; the §3.7 outbound ledger
  resets per cycle and disposes on close.
- **E-08-49 (runtime singleton live-tunnel posture)**: an equal
  re-activate reuses the live tunnel; a TERMINAL-failed client
  (4010/4002/4029 retained, §3.11) is NOT live - terminal reuse would
  wedge the §6.4 hot-switch forever, so the runtime deactivates and
  builds fresh. adoptRelayTunnel joins the status fan-out (an adopted
  probe tunnel stays status-visible for the banner/switch per §6.2).
- **E-08-50 (§4.4/gate provider tree: no ThemeSystemProvider)**: the
  NOTES/01 tree names `I18nProvider > ThemeSystemProvider > ThemeProvider >
  SessionAuthGate > App`, but this repo builds no ThemeSystemProvider
  component; the rendered tree is `I18nProvider > ThemeProvider >
  SessionAuthGate > App` (main.tsx comment now states the real shape).
  The gate slot is exactly where the doc puts it - directly between the
  theme layer and App - so §6.6 semantics are untouched. If a
  system-appearance layer ever splits out of ThemeProvider, it slots in
  above the gate without moving the gate.
- **E-08-51 (§6.6 step 1 probe/support assembly order, not parallel)**:
  the doc reads "GET /auth/session + passkey support/status fetch in
  parallel". NND assembles sequentially instead: local support first
  (a browser capability await, no network), then the probe with the
  bounded retry ladder, then the passkey PRESENCE list only once
  authenticated (the list route needs the session, so it cannot
  honestly parallel the probe anyway). The first-paint cost is the
  capability await; the §6.6 stage mapping is unchanged.
- **E-08-52 (§6.1 step 2 relay-consent mapping + anywhere preflight)**:
  the checkbox is operator consent and rides the create body as
  `includeRelay: true` whenever it is on (home network AND anywhere) -
  that flag is what force-starts the relay host server-side
  (ensureEnabledForPairing), so a promised relay candidate is never
  silently dropped because the relay happens to be off; an unstartable
  relay answers 503 and is shown as a create error. The one deliberate
  adaptation: 'anywhere' with the fallback checkbox OFF and a transports
  view that offers no relay refuses preflight ('relay-unavailable'
  guidance) instead of force-starting a relay the operator may have
  explicitly disabled; checking the box (default on) keeps the
   doc-literal force-start. The 'empty-scope' plan refusal is retired -
   'anywhere' always has a candidate once consent is given.
- **E-08-53 (§5.9 candidate set beats the doc-03 §10.1 table)**: doc 03's
  connect-url row reads `--relay` = "relay-only link (single candidate)";
  doc 08 §5.9 is explicit that ONE direct candidate is always in the set,
  with the relay candidate ADDED when --relay is passed or the host relay
  is already enabled. The build follows doc 08 (the later, remote-access
  authority), so a --relay link is direct PLUS relay, never relay-only.
  This also matches §5.6 step 6 ("persist every transport the link
  carried"), keeps the loopback-fallback case working through the relay,
  and lets the device's multi-transport record survive a later disable.
- **E-08-54 (pairing store ops re-read the file first; CLI write is
  last-writer-wins)**: doc 08 §5.9 has the CLI create the pairing session
  directly against the on-disk store the host serves the redeem from. The
  NND store is a boot-time singleton (E-08-32), so a load-once runtime
  would never see a session the CLI wrote from a side process — the live
  redeem, the pending list and the §3.12 relay-demand poll all read the
  in-memory list. Every store op now refreshes from disk FIRST (sync,
  E-08-32 posture intact): the file is the cross-process source of truth,
  the window between refresh and the op's own save is sync-only
  microseconds, and cross-process races degrade to the documented
  last-writer-wins — the same posture the relay identity lazy mint ships
  (E-08-23/E-08-25c). The save's tmp name gains the pid (two writers could
  pick the same millisecond and collide on the tmp+rename pair). A corrupt
  file still degrades to no-known-sessions (fail-safe, unchanged).
- **E-08-55 (auto-start process posture: kill on readiness timeout, record
  advisory)**: when the CLI's spawned child never answers /health within
  the 30 s cap, the run treats the start as FAILED: it SIGTERMs the child
  it owns (only the pid its own spawn returned), removes the instance
  record, and answers exit 5 (doc 03 S10 runtime class) instead of a bare
  exit 1 — a half-started server must not outlive the reporting failure or
  leave a lying record for the stop/status slice. The full serve/stop/
  restart lifecycle stays doc 03 (P4); NND's instance record stays a
  simpler registry (pid/port/host) until that slice. Two concurrent CLI
  invocations racing probe→spawn is accepted as last-writer-wins on the
  instance records (the loser's child fails to bind and exits); stop/
  status must treat records as advisory, not authoritative.
- **E-08-56 (public-URL passthrough binds loopback)**: §5.9 bullet 2
  passes full http(s) --host/--server URLs through as the ADVERTISED
  public server URL ("a remote deploy behind a proxy"). NND's reading is
  deliberate: the link advertises that URL, while the local auto-started
  instance still binds loopback (the redeem is served by the local
  instance; no wildcard exposition is implied by naming a public URL).
  Only concrete LOCAL bind intents (--host <address>, --lan → 0.0.0.0)
  change the spawn's bind. A URL-shaped or pathy --host token is refused
  as a usage error (exit 2) rather than silently becoming a broken
  candidate URL; bare IPv6 literals ride in brackets inside the advertised
  URL.
- **E-08-57 (S5.9 exact JSON shape wins over the doc-03 §10.3 messages[])**:
  doc 03 §10.3 wants every --json document to carry
  `status` + `messages: [{level, code, message}]`; doc 08 §5.9 pins
  connect-url's --json to EXACTLY
  {serverUrl, connectUrl, pairingId, fingerprint, expiresAt, candidates,
  autoStarted} (+ the --qr block). The build keeps the S5.9 shape byte-exact
  (machine link consumers) and routes warnings to human/quiet output only;
  --json drops the warning rows (PASSWORD_NOT_SET, API_ONLY_DEFERRED)
  silently rather than widening the document. The reconnect path stays
  legible: autoStarted/expiresAt/candidates self-describe the link state,
  and the P4 CLI slice can revisit when the shared output engine lands.
- **E-08-58 (S7.2/S7.3 bounds and defaults the doc pins no numbers for)**:
  connectionTimeoutSec clamps to 5..600 with default 30 (doc gives no
  limits); every port field (instance config or pushed status) must be an
  integer 1..65535 or the field is dropped; portForwards caps at 64 rows,
  drops shape-invalid rows, and synthesizes `fwd_*` ids for rows without
  one; status retryAttempt floors at 0 and junk updatedAtMs warps to
  Date.now(); random-port suggestions ride the 49152..61000 band dodging
  the busy set with a deterministic linear exhaust.
- **E-08-59 (S7.3 pushed-stamp discipline: equal replaces, only older
  drops)**: the store drops a pushed status only when the in-shelf row is
  STRICTLY newer (current.updatedAtMs > incoming.updatedAtMs); an
  equal-timestamp push REPLACES last-write-wins - ms-resolution publishers
  can collide and arrival order is the sequencer. sortStatuses is a
  stable sort, so equal stamps keep input order (display-only concern).
- **E-08-60 (S7.2 secrets mirror verbatim; the UI never echoes)**: the
  store mirrors bridge-configured instances VERBATIM, including
  StoredSecret `value` strings - the S7.2 shared shape carries them and
  config truth/at-rest ownership is doc 09's, not the UI's to rewrite.
  UI-owned faces bind to a no-echo discipline (no console/log paths exist
  in the ui ssh libs today; the pages slice's toasts/log dialogs must
  render status metadata only, never values).
- **E-08-61 (S7.4 ssh runtime key scheme)**: doc 01's key vocabulary
  ('local', 'host:<id>', mobile per-device) covers no ssh machine; NND
  pins `ssh:<id>` via sshRuntimeKey(), prefix-distinct from paired host
  ids so the two id spaces cannot collide. Doc 09/P12 owns the actual
  switch wiring; localUrl already rides the ready/degraded phase rows.
- **E-08-62 (S7.2 parse choices: value flags and basename program word)**:
  VALUE_FLAGS mirrors real-ssh value options; `-q` is deliberately NOT
  one (quiet-mode boolean; swallowing its neighbour turned
  `ssh -q host` into destination null). The program word matches on the
  path BASENAME (`ssh`/`ssh.exe`, case-insensitive) so POSIX absolute
  paths and `SSH.EXE` variants are excluded too; attached values (`-p465`)
  and `-E/-W`-style strays parse as boolean trails, which cannot
  displace the destination (last-positional rule is immune).
- **E-08-63 (S7.3 importer simplifications, not doc-pinned)**:
  parseSshConfig is flat-line: aliases dedupe across the WHOLE file
  (ssh's first-match cascade is ignored - harmless for candidates), `*`
  is excluded while any glob alias stays a `pattern` row without the
  usability check, Match/Include/comment lines skip (an `Host` row
  inside a Match block still parses - benign for candidates). Include
  expansion remains doc-09 bridge work.
- **E-08-64 (S7.3 bridge-less posture and stream survival)**: with no
  bridge, loadConfig answers `loaded` with an empty shelf and EVERY
  trigger (refresh/import/connect family) records
  'desktop ssh bridge is unavailable...' in lastError instead of failing
  quietly; with a bridge, a failed config read still attaches the status
  listener - a transient desktopSshConfig failure must not orphan the
  pushed-event channel (the only status channel S7.3 defines).
- **E-08-65 (§9 origin-consumption judgment cluster: IPv6 arm, port
  canonicalization, bare-host slew, dup headers, direct-exposure spoof)**:
  the §9 host-equality rule is HOST-ONLY by doc, and five choices ride on
  top. (a) Bracketed IPv6 literals get a dedicated bare-host branch
  (`[::1]:4090` etc.); the pre-fix bare regex had no bracket arm, so an
  IPv6 Host header parsed null forever and every IPv6-dialed browser
  origin stayed fail-closed against the doc's "an origin whose host
  equals the forwarded/host header passes" promise - fixed, and
  unbracketed junk IPv6 text (`fe80::1`) still parses null (fail closed;
  browsers never emit that shape as a Host). (b) Bare-header ports
  canonicalize the WHATWG way (`:080` == `:80`, `:08080` == `:8080`)
  BEFORE the 80/443 default-port drop, so the URL-parsed origin side and
  the bare-header candidate side reach the same rendered host (the doc's
  edge-terminated `:443` parity, now also for junk-padded ports).
  (c) Schemelessness is accepted: a bare-host (`my.tunnel.app`, no
  scheme) Origin compares equal to its own Host - browsers never emit a
  schemeless Origin, and a client that does is not origin-bound anyway,
  so the equality sweep adds nothing to gain; junk with a scheme and no
  host (`javascript:alert(1)`) parses null and fails closed.
  (d) A DOUBLED Origin/Host header must never masquerade as ABSENT: the
  upgrade-gate header harvest joins multi-valued headers with `, ` so the
  merged value parses as no origin and the upgrade is destroyed (the
  pre-fix behavior silently dropped array-valued headers, turning a
  disallowed origin into an absent one - fail-OPEN). (e) x-forwarded-host
  SPOOF posture on DIRECT (no-proxy) exposure: the gate consumes forwarded
  headers by doc design (§9); a malicious BROWSER page cannot set
  x-forwarded-host on a WS upgrade (browsers own Origin and forbid
  arbitrary upgrade headers), and a client that can is not origin-bound
  anyway, so the spoof gains nothing where the gate bites - and direct
  exposure is already bounded to loopback peers by the E-07-3 loopback
  cap (E-08-5 rate-limit family reasoning). Registered, not fixed.
- **E-08-66 (dev proxy origin overwrite for the §9 terminal WS gate)**:
  the vite dev /api proxy (changeOrigin) rewrites Host to
  127.0.0.1:<target port> while relaying the browser Origin
  (http://localhost:<vite port>) UNCHANGED, so the §9 origin gate would
  destroy every dev terminal WS upgrade the moment it landed. Fixed in
  the proxy config, not the gate: the /api proxy now sends
  `headers: { origin: apiTarget }` - the §3.9 relay dialer's
  origin-overwrite convention ("client origins are unreliable") applied
  to the dev hop; http-proxy merges the `headers` map into BOTH the web
  and ws passes (setupOutgoing), and changeOrigin then fixes the Host, so
  Origin and Host render the same host on the gate. Pinned by a config
  read test (form drift re-opens the dev doom).
- **E-08-67 (redactSensitiveUrl: helper shipped, display faces defer)**:
   §12.1's "client-side host URL display is redacted" shipped NO
   implementation — the doc's display consumers (§6.5 device rows /
   switcher, banner probes) are §6.4/6.5 P12 surface. The P8-8 sweep
   adds the canonical helper (`packages/ui/src/lib/redact-url.ts`,
   doc-exact regex `^(t|.*(?:token|auth|secret|api).*)$`i, userinfo
   stripped, unparsable input returned verbatim) with ui pins. The
   faces that render host URLs must route through it when they land
   (P12); the §6.1 pairing dialog shows the LINK/label, not host URLs,
   so nothing currently displays an unredacted URL.
- **E-08-68 (§6.4/6.5 identity-gated probe cluster defers to P12)**:
   §12.5's "identity gating before credentials" and the LAN-candidate
   serverId trust bind to the desktop/mobile probe and hot-switch
   machinery (the `wrong-service` status type already sits in
   ui/targets), which stay P12 per the P8-5a slice map. What exists is
   pinned: serverId rides every candidate (p8-4b), serverId stability
   is identity-singleton (p8-5c), URL tokens are bound to their parent
   (p8-1-auth-ui) and tunnel sessions to their tunnelId (p8-1-tunnel).
   The desktop shell's `requestHeaders` write-side Authorization filter
   is doc 09 (P12) for the same reason.
- **E-08-69 (foreign relay frame numerals fail closed; were silently
   ignored)**: the §12.5 sweep probe fed a numeral-0x7f frame through
   the host leg and the codec DECODED it (decodeTunnelFrame never
   validated the §3.6 type range; unknown types flowed into the
   dispatcher as ignorable noise — a hostile peer could desync the
   ledger grammar unnoticed). Fixed in BOTH mirrors: decodeTunnelFrame
   rejects numerals outside TunnelFrameType (CodecError 'unknown tunnel
   frame type N') so the leg/client fails the channel instead
   (fail-closed default, §3.4/§12.5). Byte format unchanged; only the
   refuse-not-ingest posture is new; pinned in both codec suites and
   by the §12.5 sweep sentinel + the 4002/unknown-close-code ui rows.
- **E-08-1 (JWT hand-rolled)**: the doc uses the `jose` library's SignJWT;
  NND hand-rolls HS256 sign/verify with node:crypto to avoid the
  dependency (JWT is `{type:'ui-session', iat, exp}` only; verification is
  constant-time recomparison). If richer JWT needs appear (server rename,
  alg flexibility), revisit.
- **E-08-2 (serverId slot)**: `serverId` (relay signing JWK hash) belongs to
  relay identity (step 8); /health greets without it until P8 relay lands.
- **E-08-3 (passkeys slot)**: global auth reset clears passkeys; the passkey
  store/binding arrives with step 5 - the reset route rotates the secret and
  clears sessions now; passkey purge joins the store when it lands.
- **E-08-4 (env names)**: `OPENCODE_JWT_SECRET` (doc literal) is read as
  `NOTNATIVE_JWT_SECRET` per the NOTES/03 brand seam; rate limit + tunnel TTL
  env keys carry the same documented picks via settings/clamps (no env-only
  surface implemented yet; settings normalization lands with the tunnels).
- **E-08-5 (rate limits in-memory)**: per-IP limiter counts in memory
  (documented source); persistence/cluster is out of scope per doc.
- **E-08-6 (client parsers)**: the ui pair-parsers (URL + string fallback)
  land with the pairing UX/client (P8-2+); the server encoder in P8-1 keeps
  byte-compat vectors ready.
- **E-08-7 (legacy cleanup is replacement-conditioned)**: section 2.7's
  "kind-tagged deduped mints also remove legacy untagged records with the
  same label" is implemented as tied to the dedupe-REPLACEMENT path only (a
  prior twin was found and replaced). A kind-tagged mint with no prior twin
  does not sweep: an unconditional sweep keyed on the resolved label would
  let a default fallback label ('Remote client') cross-device-kill another
  device's legacy record during migration, orphaning a live token. Locked
  by test (no-previous mint keeps the residue; replacement cleans it).
- **E-08-8 (revoked records are dedupe-opaque)**: dedupe replacement,
  expiry, and the relay signal treat revoked records as absent; a revoked
  twin is never replaced nor cleaned - it stays for audit and leaves only
  via purgeRevokedClients(), per section 2.7 "Records stay until
  purgeRevokedClients()". Re-pairing a revoked device therefore creates a
  fresh active record alongside the revoked one (tests pin both directions).
- **E-08-9 (store hardening cluster)**: (a) an unparsable issuer expiresAt
  fails CLOSED in authenticateBearerToken with the identical 401 text (no
  oracle), matching hasActiveRelayClients which already excludes unparsable;
  (b) store load drops shape-invalid records (strict-read posture mirrors
  the settings store) so a corrupt record cannot TypeError every later
  authentication; (c) remote-clients.json writes are atomic tmp+rename like
  settings-store - a mid-write crash can never truncate the inventory into
  an empty client store; (d) throttle stamps are deleted with removed
  records (memory hygiene, no external observable); (e) the 60 s throttle
  stamp advances even when the disk save fails: the throttle counts write
  attempts, in-memory record truth stands until the next successful save
  (unthrottled retry-on-every-request against a dead disk was rejected).
- **E-08-10 (cap split)**: the encoder enforces the whole triple cap
  (decoded JSON, base64url p, whole link). Parse-side enforcement of the
  same bounds plus strict p alphabet and length%4 rejection arrives with
  the client parsers (see E-08-6); b64urlDecodePayload stays lenient and
  is not exposed as a parser.
- **E-08-11 (URL-token query alias)**: the allowlist/gate accepts the doc
  literal `oc_url_token` AND the coordinated `nn_url_token` alias from
  DECISIONS.md's brand map (the UI client currently emits the alias).
  `oc_url_token` wins when both are present.
- **E-08-12 (URL-token map bounds)**: the in-memory token map is bounded
  at 512 entries with insertion-order eviction (doc pins no bound); tokens
  are pruned lazily on every resolve/mint.
- **E-08-13 (client-auth route family deferred)**: §2.7's
  /api/client-auth/clients authority rules (self-revoke, desktop-local/
  session authority, runWithClientCreateAuth create gate) land with the
  pairing UX slice; the store methods (revoke/purge/getActiveClient)
  exist and are gate-tested already.
- **E-08-14 (password source, registration discipline)**: the password
  resolves from env (`NOTNATIVE_UI_PASSWORD`, brand rename of
  OPENCHAMBER_UI_PASSWORD) only — the settings registry's
  `desktopUiPassword` stays accepted-never-returned and is deliberately
  NOT an auth consumer in this slice (the P4/P5 settings suites exercise
  the registry independently; a settings-driven password would silently
  lock those flows). The `--ui-password` CLI value joins when the doc 03
  CLI gene lands; the settings→auth wiring is pinned for the
  settings/auth UX slice with a gated follower test.
- **E-08-15 (429 body copy)**: the doc pins the 429 status + Retry-After
  and X-RateLimit headers but not a body; NND answers
  {error:'Too many failed login attempts', locked:true} and clears the
  session cookie on 429 and 401 alike (§2.3 step 3's "clear the session
  cookie" read to include lockout responses). Login 200 responses carry no
  X-RateLimit headers (the bucket was cleared; the headers read as
  rate-limited-response metadata).
- **E-08-16 (clear-cookie Secure mirror)**: CLEAR_SESSION_COOKIE_HEADER
  is fixed (no Secure); RFC 6265 deletion matches name/path/host only, so
  this is inert today. The mirror-on-Secure variant joins the
  reverse-proxy posture step (step 14).
- **E-08-17 (tunnel session fields + absolutism)**: the doc's session shape
  lists `expiresAt` and a stray `expiredAt` — NND stores `expiresAt` only
  and treats the duplicated name as doc noise. Tunnel-scope /api requires
  the tunnel session ABSOLUTELY (also while the local app is open; the
  doc's table row reads as unconditional). Clearing an invalid-present
  tunnel cookie rides the 401 (mirrors the ui gate's clear-on-invalid
  discipline). The connect failure response does NOT clear any cookie.
- **E-08-18 (bearer answers above the tunnel row)**: at tunnel scope
  GET /auth/session answers scope:'client' for a device bearer/URL-token
  credential BEFORE the §2.9 tunnel row — per §2.9's closing sentence
  ("device bearer tokens pass at any scope"); a tunnel-parked desktop
  keeps its /auth/session probe working. Registered for review; if the
  reference disagrees, the tunnel row wins with a one-line swap.
- **E-08-20 (ceremony seam + duplicate registration)**: the WebAuthn
  ceremony is exercised at SEAM level (options generation + one fail-closed
  verify against the real @simplewebauthn adapter; happy paths via an
  injected adapter). Real-device ceremony verification is a QA step for
  the settings/auth UX slice. Re-registering the same credential id on the
  same rpID replaces the saved record (idempotent re-pairing) — the doc is
  silent on duplicates; replacing beats permanently wedging a lost key.
- **E-08-21 (passkey login rides the login limiter)**: §2.4 "issues the
  session cookie exactly like password login" is read to include the
  §2.2 rate limit; /auth/passkey/authenticate/verify attempts/records/
  clears with the same per-IP budget and a 429 carries the same headers.
- **E-08-22 (publicOrigin slot, implemented 20261001-40)**: §2.4's
  additional expected origin reads the server-owned canonical/legacy setting
  at each ceremony operation. Only validated HTTPS or HTTP loopback origins
  are added, with normalized duplicates removed. The request-derived rpID,
  credential scope, challenge matching, and required user verification stay
  intact. Real P-256 registration/login tests prove the configured origin
  works and wrong origins or RP hashes fail. Real-device acceptance remains.
- **E-08-23 (relay identity store file)**: section 3.2 stores the signing
  and encryption keypairs in the settings registry; NND keeps them in a
  dedicated atomic dataDir file (relay-identity.json) until the registry
  gains relay keys. Machine-managed secrets, never user-editable; the
  push-relay key sharing lands with the push slice. The strict
  regeneration gate (never mint over a corrupt read) is honored.
- **E-08-24 (payload-guard strictness)**: section 3.6 pins payload SHAPES
  but not ranges; NND guards fail fast at parse: HttpResponse status must
  be a safe integer 100..599 (the doc hands `status` to the client
  Response; a malformed/600+ value constructing a nonsense Response was
  rejected as a design), WsClose code must be a safe integer (dispatcher
  later clamps to 1000..4999; NaN/Infinity never reach a byte writer) and
  reason stays string-or-absent, HttpRequest.hasBody boolean-or-absent.
  Cross-impl note: the reference OC client emits exactly these shapes, so
  tightening cannot kill legitimate frames — a deviation would 4xx at the
  guard level, not silently misparse.
- **E-08-25 (relay primitives hardening choices, not doc-pinned)**:
  (a) MAX_PENDING_FRAGMENT_STREAMS=256 — the doc bounds assembled MESSAGE
  bytes only; the assembler's pending-groups map was growable by a
  fragmented-frame flood across many stream ids; exceeding the bound is a
  CodecError (fail closed, channel error posture, same as message
  overflow).   (b) decryptor counter read is BigInt-exact: wire counters >
  2^53-1 are rejected pre-GCM ('exceeds the exact range') — a correct
  peer never mints one (2^53 frames is years of steady traffic even at
  100 k frames/s); without this,
  Number() collapsed 2^53 and 2^53+1 onto the same inexact value.
  (c) RelayIdentityStore.resolve() single-mints process-wide under
  concurrent calls (shared in-flight promise, identical identity object
  handed to every concurrent caller); across PROCESSES a simultaneous
  mint is last-writer-wins and acceptable — each process adopts whichever
  self-consistent file its round-trip verify read, and the relay host
  service slice mints once at boot. (d) Fresh-ts contract: authParams
  records the caller's ts verbatim; the host service must mint ts at
  socket open because a re-implementation worker rejects stale ts (doc
  §3.2). (e) encodeFragmentedMessage caps chunk SIZE (via chunkPayload)
  but not the total fragmented-message size — the outbound 16 MiB
   counterpart of the assembler bound rides the framer slice with the host
   WS maxPayload (§3.9); the peer assembler bounds it defensively today.
- **E-08-26 (host broker postures, decisions not doc-pinned)**:
  (a) Established-TEXT authority sits in the responder, not the broker:
  the broker routes post-established TEXT frames into the responder and
  only the responder decides duplicate-Hello re-answer / rekey-1008 /
  plaintext-1011. Without this the broker's 1011 short-circuit made the
  doc §3.4 duplicate-hello rule (and its 1008 rekey gate) dead code.
  (b) CONNECTING-socket teardown discipline: ws emits 'error' with zero
  listeners when a handshake-phase socket is aborted (terminate/close on
  a still-connecting dial) — every broker-owned socket carries a listener
  so a stuck relay dial can never kill the host process; the close event
  owns the leg bookkeeping.
  (c) One close decision per leg: the finish() path is map-guarded so the
  responder close, the open-timeout and the ws-close event can never
  double-fire onLegClosed (hosts observe leg-life decisions in order).
  (d) The reconnect-open returns the machine to `connected` and clears
  lastError on the fresh open; only a nonzero close code during
  disconnects labels lastError. (e) Control-sweep timings stay as the
  machine defaults in code (see section C); tests ride SHORT overrides
  per harness — the current restored from `timing` merge.   (f) The probe
  of ws's CONNECTING-abort also re-pinned that a client-initiated
  ws.close(1001) completes the full server-side close handshake through
  the relay pairing (idle-reaper teardown reaches the client leg as
  frames, not zombies). (g) Host-broker sendToClient rejects (no
  established leg / 64 KiB oversize) with a plain rejected promise — the
  demand-lifecycle slice owns catch-or-ignore discipline at its call
  sites; the leg's own chain self-heals (catch) so a failed send can
  never stall subsequent frames on the same leg.
- **E-08-27 (downstream window heuristics deferred, fixed-window posture)**:
  section 3.8's adaptive window (grow x2 only when the window itself
  limited throughput with near-best observed RTT; halve when delivery
  delay exceeds minRtt + 100 ms; adjustment once per window, never per
  frame) is DEFERRED past the relay host slices. The shipped scheduler
  runs the FIXED start window 64 KiB with the 1 MiB cap constant
  retained and byte accounting identical: in-flight (sent, unacked) raw
  frame bytes <= window; acks release exact boundaries; stream-zero
  bytes stay excluded from the ledger (the client's cumulative count
  excludes keepalives, so pings can never sit as outstanding boundary
  references). The heuristics land with the client-side 3.10 slice and
  its ACK RTT telemetry.
- **E-08-28 (relay config store file)**: §3.12/§11.2 author
  `privateRelay = {enabled, relayUrl}` in the settings registry; the
  registry has no relay keys yet, so NND keeps the machine-owned pair in
  a dedicated atomic dataDir file `relay-config.json` (0600; strict
  reader; corrupt presence is flagged, never healed, writes refuse) —
  the E-08-23 posture. The registry migration rides the settings/auth
  slices. `relayUrlLocked` pins a VALID `NOTNATIVE_RELAY_URL`; an
  invalid env falls through the chain rather than corrupting boot
  (the doc's env row assumes a valid value).
- **E-08-29 (machine claim postures, not doc-pinned)**: (a) a corrupt
  `relay-host.lock` reads as no-claim and is overwritten by the next
  claim — an attacker with data-dir write access already owns the
  machine, and the worker's 4001/identity arbitration remains the
  authority (pre-lock posture; string-pinned by test). (b) Claim WRITE
  failure is a tri-state (`claimed|contended|write-failed`): only
  `contended` stands a host down; `write-failed` proceeds ("behaves
  pre-lock") so a read-only data dir cannot hold the relay hostage.
  (c) The liveness probe is injectable (tests fake dead/foreign pids);
  default = `process.kill(pid, 0)` with ESRCH stale / EPERM alive.
  (d) The takeover grace is measured from standby ENTRY (not from the
  claim's death) — simple, monotonic, and the watch/poll/reconcile all
  honor the same clock; a fresh boot carries no standby and reclaims
  instantly. (e) `disable()` releases the claim but KEPT the 60 s poll
  and the 30 s watcher armed (P8-3a review fix): a later headless
  pairing write re-hosts within a minute without a reboot.
- **E-08-30 (mixed-mode L2 demux)**: the shared §3.7 batcher ships
  buffered singles as `[0x00]`, N-frame groups as `[0x01](len|frame)*N`,
  and setup/teardown/keepalive rows ENVELOPE-FREE (pinned by the P8-2c
  chain). The receiving demux (`decodeFrameOrContainer`) therefore
  treats a bare frame as a legal single. The naive "types never equal
  0x00/0x01" rule was WRONG (type 1 HttpRequest IS byte 0x01 — caught
  by review P0): the shipped rule treats `0x01` as a container ONLY
  when an exact length-prefixed multi-segment run parses where every
  segment is ≥ header-sized and every segment header type is a
  buffered type (the only frames a producer of `[0x01]` ever embeds);
  bare fallback otherwise; junk fails closed (channel error). Residual
  aliasing (a client that sends a bare HttpRequest whose streamId
  bytes continue to look like a buffered-type container) is
  self-inflicted, unreachable for JSON payloads, and contained by the
  stream dispatcher.
- **E-08-31 (terminal rows bypass the §3.8 queue)**: the 1008 refusal,
  the upstream-close mirror, and the StreamAbort-after-release ship
  through `sendFrameNow` (direct carrier, batcher flush-first) because
  their own `releaseStream`/`abortStream` cancel would otherwise drop
  the not-yet-pumped close — found by the production wire probe (the
  fake-worker harness consumed its own frames asymptomatically).
  Dispatcher-tier refuses (fragmented non-WS) remain non-fatal frame
  refusals; the LEG-HOST assembler owns the channel-level kill via the
  codec's throw (1011).
- **E-08-32 (pairing store is synchronous)**: §5.4 describes serialized
  mutations via a promise queue (`withStoreMutation`). NND's store, like
  `remote-clients.ts`, is a synchronous in-memory record set with atomic
  0600 file writes — the event-loop quiescence of sync ops already
  guarantees no interleaving, so the queue is a no-op here. Pin: if a
  future mint becomes async, the store MUST gain the promise queue (or
  the redeem's `usedAt` stamping races first-writer-wins) — the safeLitmus
  test pins the retry-safety that would break.
- **E-08-33 (candidate authority decisions, not doc-pinned)**:
  (a) redeem rate limiting uses a dedicated sliding window limiter
  (10/5 min) WITH NO lockout phase — the login limiter's 15-min lock is
  a separate contract; `Retry-After` derives from the window end;
  (b) the refresh endpoint's "client-reached address" reads the socket
  LOCAL address (what the device actually hit), never the Host header —
  a tunnel-relayed leg lands on loopback and is dropped, the interface
  scan continues;
  (c) explicit `serverUrl` MAY be loopback (the "This computer only"
  scope owns this); the auto request-origin FALLBACK is loopback-filtered
  and yields 400 'No usable pairing candidate' rather than a
  loopback-only link;
  (d) `includeRelay: true` + `ensureEnabledForPairing() === null`
  (register-haspopup/identity trouble) answers 503 rather than a
  silent relay-less link — the operator asked to be reachable;
  (e) the redeem mint's auth flow re-authenticates inside the handler
  (the gate outcome is not threaded through; the double bearer check is
  throttled by the 60 s lastUsed write stamp, so no file churn);
  (f) redeem attempts are keyed raw-socket:pairingId with NO lockout —
  this deliberately diverges from the login limiter (no lock phase per
  §5.5); x-forwarded-for is never consulted;
  (g) cancel of a used session answers cancelled:false (2/404 at the
  route) — a one-time grant has nothing left to revoke and the redeem
  stamp is the audit anchor;
  (h) error-class typing: auth classes carry E-08's one message via
  `InvalidPairingSessionError`; server faults are `MintFailure` /
  `PairingStoreFault` — the route 500s them, does NOT charge the redeem
  bucket, and the store rolls back the consume-on-confirm stamp;
  (i) GET pending-sessions/transports are manage-authority (a hijacked
  device token must not poll pairing state or learn the LAN topology);
  the §3.13 candidates refresh stays bearer-wide (it rides live
  transports);
  (j) store writes create the dataDir at 0700 into 0600 files (§12.2),
  and the auth-family singletons default through ENV.dataDir so a stock
  boot (env unset) shares the relay identity directory.

## C. Constants pinned this slice

Pairing: MAX_PAIRING_PAYLOAD_LENGTH 16384; pairing id `pair_` + 12 B hex;
secret 32 B b64url; fingerprint 4 B hex `XXXX-XXXX`; TTL 10 min; canonical
priorities direct 10 / creator-origin direct 20 / relay 30; redeem generic
error string exactly 'Invalid or expired pairing session'.
Auth: cookie `oc_ui_session` (HttpOnly, SameSite=Strict, Secure on https or
x-forwarded-proto), TTL 12 h / 7 d trust-device; rate limit 10/5 min -> 15 min
lock, no-IP 3 attempts; URL token `oc_url_` + 24 B base64url -> 60 s,
allowlists per section 2.6; client token `oc_client_` + 32 B b64url
(sha256 stored), label cap 80, lastUsed writes 60 s throttle; tunnel bootstrap
32 B b64url, TTL 30 min (clamp 1 min-24 h), newest-only; tunnel session TTL 8 h
(clamp 5 min-30 d); connect rate limit 20/5 min (5 with no IP), 10 min lock;
`/connect?t=` answers 302 to `/` on success with `oc_tunnel_session`
(HttpOnly, SameSite=Lax) and 401 text 'Connection link is invalid or expired.'
otherwise; credential endpoints at tunnel scope answer 403 with
`tunnelLocked:true`.
Relay host broker: control ping 30000 / pong grace 10000 (quiet window
beyond interval + grace terminates) / reconnect 1000 x2 cap 30000;
data open timeout 15000, idle reaper closes inbound-silent legs at
90000 with 1001, sweep 30000. Test-only SHORT timing overrides live in
the harness (per-test `timing` merge), never in production defaults.
Relay L3 host (P8-2c): batch window 150 ms / maxBatchBytes 24 KiB /
maxBatchFrames 32 (envelope reserve 1+4 B); downstream window starts
64 KiB (cap 1 MiB constant, E-08-27), queue caps 4 MiB bytes / 4096
frames / 4096 outstanding; response chunks 8 KiB under flow control
(legacy budget 64 KiB - 10); request-body buffer cap 512 KiB, delivery
 deadline 15 s; WS re-chunk cap = MAX_TUNNEL_PAYLOAD_BYTES; close codes
clamp 1000..4999 (default 1000); ws allowlist = the five path set from
section 3.9 (shared with the URL-token WS list).
Relay host service (P8-3a): claim watcher 30000, demand poll 60000,
CLAIM_TAKEOVER_GRACE_MS 120000 (standby-clock; boot reclaims via
tryClaim with no grace); default relay endpoint
`wss://relay.openchamber.dev/ws`; relay-config/locks are dedicated
dataDir files (`relay-config.json` 0600, `relay-host.lock` 0644 —
pid+timestamp non-secret; E-08-28/29); enable body cap 16 KiB
(bounded stream); batch-pump env `NOTNATIVE_RELAY_BATCH_WINDOW_MS`
 clamp 1..5000 default 150; hold-out envs `NOTNATIVE_RELAY_HOST`
off/on + `NOTNATIVE_ELECTRON_DEV` (on wins). Machine files per
instance: serverId + lock + config share the dataDir across instances
by design (identity arbitration at the worker).
Pairing/clients routes (P8-4a): redeem limiter sliding window 10 per
5 min keyed `<raw socket addr>:<pairingId>` (no lock phase, success
clears; bounded 64 KiB bodies); pairing session TTL 10 min, sweep
retention = inactiveAt+TTL (used/cancelled) / expiry (unredeemed);
client/pairing route bodies cap 64 KiB (shared bounded reader
`lib/http/read-bounded.ts`; relay enable stays 16 KiB); stores
`client-pairing-sessions.json` + `remote-clients.json` both 0600
atomic in the dataDir; the redeem route registers BEFORE the /api
gate (createClientAuthPublicRoutes), the gated family rides
`registerApiSurfaces`; boot demandSignals = hasActiveRelayClients()
+ hasActiveRelaySession().

Tunnels (P8-4c): cloudflared quick URL timeout 30 s (kill SIGINT + exact
text 'Tunnel URL not received within 30 seconds'), trycloudflare regex
over both streams; managed-remote: token temp file `openchamber-cf-*/`
0o600 written via `--token-file` (never argv), ready set
{registered tunnel connection / connection*registered / starting
metrics server / connected to edge}, fatal set {error parsing*config /
failed to *config / invalid token / unauthorized / credentials file
*not found / provided tunnel credentials are invalid}, liveness
fallback 6 s on ANY output, hard failure 20 s; managed-local configs
≤256 KiB non-empty .yml/.yaml/.json; spawnSync probes 5 s timeout
1 MiB buffer; ngrok: API poll 250 ms (test-shrinkable), URL timeout
30 s, api.ngrok.com gate 5 s, poll-answer signal 1.5 s; profile store
`cloudflare-managed-remote-tunnels.json` v1 0600 promise-locked (write
retries 3 x 100 ms via rmTempDir semantics for temp dirs only);
doctor flags `tokenProvided`/`hasSavedManagedRemoteProfile=1`; start
body cap 64 KiB; settings PUT caps 512 KiB; TTL clamps (already
§4.5) surface as ttlConfig {bootstrapTtlMs (0 when expiry disabled),
sessionTtlMs}; the /connect limiter keys the SOCKET address first
(XFF only as the no-socket fallback — §8.5 anti-spoof, supersedes the
P8-1 header-first keying); quick-tunnel child env carries HOME +
USERPROFILE + APPDATA pointed at the temp HOME on win32; .bat/.cmd/
.com PATH candidates are never launch targets (Node EINVAL posture).

## D. Invariants sweep (P8-8)

§12 re-audit as a checklist (step 15). Statuses: PINNED = a named
existing test suite pins it; NEW PIN = pinned by this slice; GAP-FIXED
= a hole fixed in code this slice, with tests; dev rows cite their
registered E-08-NN. The static greps live in
`packages/web/src/server/__tests__/p8-8-invariants-sweep.test.ts` (suite
name p8-8-invariants-sweep; rows (a)-(e) below).

### §12.1 never log or leak

| Row | Pin | Status |
| --- | --- | --- |
| Pairing secrets/hashes never in logs or long-lived replies | p8-4a-pairing-store 'sha256 secretHash ... never the plaintext' + 'lists pending sessions without secrets and without the hash'; p8-4a-client-auth-routes 'plaintext token exactly once'; p8-5b route/parity suites | PINNED |
| create/redeem (+429, cancel, purge) `Cache-Control: no-store` | p8-4a-client-auth-routes 'rate limits ... 429 keeps no-store' + no-store asserts (47/100/186); NEW static sweep (c): client-auth.ts answers only through the single no-store `json()` helper | PINNED + NEW PIN |
| Links render in the pairing dialog only; QR transient, never a file; CLI stdout link is the product surface | p8-5b pairing-dialog tests (QR next to the printable link, copy rows, open:false), p8-1-auth-core link caps; CLI print row per §5.9 (E-08-57 family); the startup-tunnel console link is the doc's own "printed/QR'd at tunnel start" row (§11 line 119/§4.7 line 1373) | PINNED |
| Device tokens (`oc_client_`) and URL tokens never join logs | NEW sweep (a): zero console/logger statement lines in server src mentioning authorization/cookie (comments excluded) | NEW PIN |
| URL tokens: 60 s + fixed allowlist | p8-1-auth-ui 'url tokens: mint/resolve, expiry, budget eviction, both parents' (393), 'rides the allowlist in both spellings' (638), 'expired URL tokens fall through' (437) | PINNED |
| cloudflared managed-remote: stdout drained unlogged, `--token-file` 0o600 non-argv, deleted on exit | p8-4c-tunnel-providers 'writes the token to a 0o600 temp file, spawns --token-file (never argv)' (81) | PINNED |
| Profile store never echoes tokens (preset ids only) | p8-4c-tunnel-profile-store 'tokens never leak into the file listing surface (§12.1)' (59); p8-4c-tunnel-routes 'managed-remote-token upsert ... §12.1: tokens never echo' (222-235) + doctor POST never-echo (204); NEW sweep (d): jsonRoute bodies token-free except the /connect bootstrap seat | PINNED + NEW PIN |
| Relay failChannel rows carry connectionId + reason only | NEW sweep runtime: leg-host sentinel — a hostile payload's bytes never join the failure reason (structural, ≤200 chars); E-08-69 joiner | NEW PIN |
| Client-side display redaction (`redactSensitiveUrl`) | ui redact-url.test.ts (doc-exact regex + userinfo strip + verbatim passthrough); wiring of display faces = E-08-67 | GAP-FIXED |
| Diagnostics/analytics never carry credentials | no diagnostics/analytics surface exists in the rebuild (§3.14 analytics + §6.4 probe machinery are P12); startupTrace is opt-in ring memory | Registered (E-08-68) |
| jwt-secret/relay keys/token stores 0o600; chmod-on-write; scrypt salt memory-only | NEW sweep (b): every `writeFileSync` in the 9 secret stores carries 0o600 (host-lock 0o644 = registered E-08-29 exception); p8-1-auth-core atomic writes; p8-2a/p8-3 config/identity strict-readers | PINNED + NEW PIN |
| Never log raw Authorization/cookie headers | NEW sweep (a) (same row as tokens) | NEW PIN |

### §12.2 server storage locations

| Row | Pin | Status |
| --- | --- | --- |
| `jwt-secret` 0o600 | p8-1-auth-ui 'secret holder loads the file, rotates...' (165) + regenerated/rewritten rows; sweep (b) | PINNED + NEW PIN |
| `remote-clients.json` 0o600 / dir 0o700, sha256 hashes | p8-1-auth-core 'persists atomically...strict-reads' (171); sweep (b) | PINNED + NEW PIN |
| `client-pairing-sessions.json` 0o600, sha256 secretHash | p8-4a-pairing-store 131/store rows; sweep (b) | PINNED + NEW PIN |
| `ui-passkeys.json` | p8-1-passkeys store hygiene (227/371); written 0o600 (doc says default umask — impl is stricter; noted, no delta) | PINNED |
| `relay-host.lock` {pid, claimedAt} default mode | p8-3-relay-host-lock suite (claim/reclaim/release rows); 0o644 explicit = E-08-29 | PINNED |
| `cloudflare-managed-remote-tunnels.json` 0o600 plaintext tokens | p8-4c-tunnel-profile-store; sweep (b) | PINNED + NEW PIN |
| `settings.json` (identity JWKs private halves, relay config, tunnel settings) | p5-3 settings suites; the identity/config halves ride the dedicated files (E-08-23/28) at 0o600 | PINNED |
| relay keys + `relay-config` dedicated files | E-08-23/E-08-28; p8-2-relay-primitives identity rows + p8-3-relay-host-lock config rows; sweep (b) | PINNED |
| In-memory only: scrypt salt, JWT binding, URL-token map, tunnel sessions, login limiter | p8-1-auth-core (password/salt), p8-1-auth-ui (jwt binding/limiter/url tokens), p8-1-tunnel (bootstrap/session in-memory) — none touch storage | PINNED |
| Doc paths read OPENCHAMBER_DATA_DIR/~/.config/openchamber | NND brand NOTNATIVE_DATA_DIR/`~\.notnative-desktop` per the E-08-4/E-08-38 brand seam | Deviation (registered) |

### §12.3 client storage

| Row | Pin | Status |
| --- | --- | --- |
| Browser/PWA: cookie jar only; nothing token-bearing in JS storage | NEW sweep (e): the ui runtime/relay file family carries no persistence APIs (localStorage/sessionStorage/indexedDB/caches) — grant/URL-token/bearer cannot leave memory; ui settings mirror excludes `secret` fields by registry rule; SessionAuthGate stores only the trust-device flag | NEW PIN |
| Runtime bearer is injected + memory-only; extra headers never keep Authorization | ui runtime-auth.test.ts (NEW): parse-side filter + set-once + no-overwrite + tokenless injection surface | NEW PIN |
| Desktop: requestHeaders never keep Authorization (parse AND write) | parse side = runtime-auth.test.ts NEW PIN; write/desktop-store side is doc 09 (P12) | NEW PIN + deferral (E-08-68) |
| Mobile secure store, metadata-only localStorage, migration | doc 11 mobile slice (P13) — outside this doc's build | Registered |
| `grant` never persisted; QR payloads never written to disk | sweep (e) + p8-5a E2E (grant rides the §3.3 URL), relay-primitives URL-shape pin, p8-5b dialog/QR rows | NEW PIN (e) + PINNED |

### §12.4 revocation semantics

| Row | Pin | Status |
| --- | --- | --- |
| `DELETE /api/client-auth/clients/:id` (self/desktop-local/UI session) | p8-4b-client-auth-authority 'plain tokens see only themselves, may only revoke themselves...' + p8-1-auth-core 'authenticate rejects revoked...' (269) + 'revoked residue survives until purge' (200) | PINNED |
| Pending pairing cancel | p8-4a-pairing-store 'cancel stamps once...' (191) + used-cancel {cancelled:false} (320) + cross-process cancel (409); p8-4a-client-auth-routes cancel rows (278) | PINNED |
| Passkey `DELETE /api/passkeys/:id` rpID-scoped | p8-1-passkeys 'revoke matches id AND rpID; auth-reset purge...' (351) | PINNED |
| `POST /api/auth/reset` rotation; device tokens survive; passkeys cleared | p8-1-auth-ui 'reset rotates the session secret; device tokens survive' (614) + env-backed refusal (719); p8-1-passkeys 'auth reset purges passkeys' (500) | PINNED |
| Tunnel stop/replace → cookie dead, listed inactive | p8-1-tunnel 'stop/replace: clearActiveTunnel revokes + nulls; wrong-tunnel sessions die with the new id' (217) + 'stop: artifacts die...' (423); p8-4c-tunnel-service replacement rows (60-75,135) | PINNED |
| Bootstrap newest-only revocation | p8-1-tunnel 'bootstrap tokens: newest-only, clamped expiry, one-shot redeem' (149) + one-time /connect (264) | PINNED |
| `/relay/disable` / demand loss | p8-3-relay-service 'disable persists the off-truth...' (325) + route rows (465) + demand-revival poll (390) | PINNED |
| URL token 60 s + allowlist sweep | p8-1-auth-ui 393/437/638 (see §12.1) | PINNED |

### §12.5 invalidation rules

| Row | Pin | Status |
| --- | --- | --- |
| One-time: pairing secret `usedAt` | p8-4a-pairing-store one-time + spent-id rows (118/200/229/349/396) | PINNED |
| One-time: bootstrap token (`usedAt` + newest-only) | p8-1-tunnel 149/264 | PINNED |
| One-time: URL token 60 s | p8-1-auth-ui 393 | PINNED |
| One-time: relay `grant` (single-use, unpersisted) | sweep (e) + p8-5a E2E grant-through-URL + relay-primitives client-role URL shape (grant only when provided) | NEW PIN + PINNED |
| One tunnel controller per instance | p8-4c-tunnel-service 'concurrent starts serialize (no orphaned controllers)' (173) + replacement/reuse rows (48-93) | PINNED |
| One relay host claim per machine/data dir | p8-3-relay-host-lock (17 claim rows) + p8-3-relay-service standby/grace/boot-reclaim (239-312) | PINNED |
| One host-control slot per serverId (4001) | p8-2-relay-host 'control replacement: lastError reflects the 4001 close...' (147) | PINNED |
| One client leg per connection; duplicate ⇒ 4002 | NEW sweep runtime: duplicate `connected`/sync announcements keep exactly ONE host-data dial (CountingIdentity dial counter); ui tunnel-client NEW 'terminal 4002 fails fast forever'; the 4002 itself is the worker's rule (E2E parity via p8-2/p8-5a) | NEW PIN |
| Candidates are snapshots; `usesRelay` sticky | p8-4b candidates rows (97/166: refresh per call, never URL-token-admitted); p8-1-auth-core 'relay flag is sticky' (269) | PINNED |
| Failed store read aborts reconcile (never fake no-demand) | p8-3-relay-service 'a demand read failure with NO affirmative throws' (181) | PINNED |
| Pending-list polling never fakes redemption | ui pairing.test 'a failed poll neither blanks the signal nor fakes redemption' (396) + p8-5b harness rows | PINNED |
| URL tokens bind to the parent session | p8-1-auth-ui 'both parents' (393) + 'bound to expired device parents fail closed' (448) + 'revoked device records kill their bound URL tokens' (668) | PINNED |
| Tunnel sessions bind to their tunnelId | p8-1-tunnel 'sessions: ... revoked/wrong-tunnel/expired rejection' (192) + stop/replace (217) | PINNED |
| JWTs bind to the rotatable secret | p8-1-auth-ui 494/614/719 + p8-1-auth-core 'secret holder loads the file, rotates...' (165) | PINNED |
| E2EE binds pinned `hostEncPubJwk` (rekey ⇒ 1008) | p8-2-relay-host 'a rekey attempt closes 1008; post-established plaintext closes 1011' (228) + p8-5a E2E | PINNED |
| LAN-candidate trust binds `serverId`; identity gating before credentials | p8-4b 'serverId rides the payload' (97) + p8-5c serverId stability; the probe/`wrong-service` flows are §6.4/6.5 P12 (E-08-68) | PINNED + deferral (E-08-68) |
| Passkeys bind per rpID + password binding | p8-1-passkeys rpID rows (181/195) + binding guards (227) + revoke rpID match (351) | PINNED |
| Unknown close code never grants grace | ui tunnel-client 'reconnect backoff...' (4008 rides the standard ladder, 236) + NEW 'an unknown close code is never terminal and rides the standard ladder' (4500) + NEW 'terminal 4002 fails fast forever' | PINNED + NEW PIN |
| Plaintext after `ready` kills the channel | p8-2-relay-host 228 (1011) | PINNED |
| A body that lost frames is aborted, not forwarded | p8-2-relay-dispatcher 'hasBody with ZERO body frames aborts...' (362) + stalled-stream deadline (376) | PINNED |
| A misclassified transport never hides relay demand | p8-1-tunnel classifier matrix (102/119) + p8-3-relay-service demand-throws rows (181/197) | PINNED |
| A leaked credential is useless after revoke | p8-1-auth-core 269/288 (hash-set validated on every request) + gate rows (427/668) | PINNED |
| A foreign frame numeral is protocol noise, not data | GAP-FIXED (E-08-69): both decodeTunnelFrame mirrors now CodecError outside TunnelFrameType; pinned in p8-2-relay-primitives + ui relay-primitives + the sweep sentinel | GAP-FIXED |

Sweep summary: 42 §12 rows audited; 30 PINNED (pre-existing, named
above), 9 NEW PINs (web sweep (a)-(e) static, web duplicate-leg + leg
sentinel, ui runtime-auth, ui 4002 + unknown-code-close, ui codec
foreign-numeral mirror count), 2 GAP-FIXED (decodeTunnelFrame type-range
fail-closed in both mirrors; redactSensitiveUrl helper), 3 registered
defer/deviation rows (E-08-67 wiring, E-08-68 §6.4/6.5 identity cluster +
desktop write-side filter + doc-11 mobile, brand paths). Counts of
suite-joined pins are exact in the test files. The sweep also exposed a
latent p8-3-relay-wire E2E race (per-batch stream consumption starved
frame-targeted probes whenever coalesced batches carried the wanted
frames for the NEXT probe) — the harness now uses a frameCollector with
per-frame waits (test-side; production paths unchanged, 511/36 web green
×2 consecutive full runs).

