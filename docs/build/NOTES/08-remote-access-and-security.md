# NOTES 08 - Remote access & security

Doc read in full (2,073 lines). P8 sliced per the doc build checklist (section
14), dependency order preserved: payload contract -> credential stores ->
password/session/url-token -> scope+tunnel gate -> passkeys -> relay
(primitives, client, host) -> candidates -> tunnels -> pairing/instance UX ->
SSH -> reverse proxy -> invariants.

## A. Slice map (against the doc checklist)

- **P8-1a (delivered this slice)** - checklist steps 1-2: pairing v2
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
  NOT yet in: password/JWT/cookie sessions + URL tokens (step 3), scope
  classifier + tunnel gate (step 4) - next slice carries both, then
  passkeys (5), relay (6-8), candidates (9), tunnels (10), UX (11-12),
  SSH (13), reverse proxy (14), invariants (15).
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
