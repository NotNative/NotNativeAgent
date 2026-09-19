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
  settings-driven publicOrigin origin allowlist rides the settings
  runtime (E-08-22).
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

## B. Adaptation deltas (registered)

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
- **E-08-22 (publicOrigin slot)**: §2.4's settings-driven additional
  expected origin is not wired yet — the origin allowlist carries the
  request origin only until the settings runtime lands (E-08-4 tail).
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
