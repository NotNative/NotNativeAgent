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
- NOT yet in: password/JWT/cookie sessions are now in; NEXT: scope
  classifier + tunnel gate (step 4) - next slice carries both, then
  passkeys (5), relay (6-8), candidates (9), tunnels (10), UX (11-12),
  SSH (13), reverse proxy (14), invariants (15).
  NOT wired: /api/client-auth/clients authority routes (§2.7 core-routes
  set, E-08-13) - they ride with the pairing/UX slice; the settings-store
  `readStoredSecretValue` accessor exists for that wiring.
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
