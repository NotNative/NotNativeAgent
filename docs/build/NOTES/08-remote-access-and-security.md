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
- NOT yet in: password/JWT/cookie sessions, scope classifier + tunnel
  gate, and passkeys are now in; NEXT: relay (6-8), candidates (9),
  tunnels (10), UX (11-12), SSH (13), reverse proxy (14), invariants (15).
  NOT wired: /api/client-auth/clients authority routes (§2.7 core-routes
  set, E-08-13) - they ride with the pairing/UX slice; the settings-store
  `readStoredSecretValue` accessor exists for that wiring. /api/system/
  shutdown's requireShutdownAuth tunnelscope flavor rides the doc 03
  system-family route; tunnel TTL settings keys ride the tunnels slice.
- Deferred beyond P8-1: passkeys (step 5, @simplewebauthn registry path),
  relay primitives/client/host (steps 6-8, E2EE transcript), candidates +
  restore (9), tunnel providers (10), pairing/instance UX (11-12), SSH (13),
  reverse-proxy posture (14), invariant sweep (15).

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
