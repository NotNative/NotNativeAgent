# NOTES — Doc 02: Harness Integration Contract

Source: `docs/planning/02-opencode-harness-contract.md` (1484 lines, SDK 1.18.30 ground truth).
This doc owns the seam UI ↔ server ↔ harness. Doc 03 owns NND-owned routes; doc 04 owns client reduction; here: the wire contract NNA must satisfy (and that our mock harness must fake faithfully).

## 1. Two-tier map (load-bearing)
- Browser never talks to harness. Server namespace `/api` = NND routes (shadow first) + reverse proxy (everything else, one `/api` strip).
- Harness auth added by server only; browser credentials never reach harness.
- One global upstream SSE reader (`GET /global/event`) shared by all server consumers + browser fan-out.

## 2. Wire conventions (Tier-1 proxy contract we must reproduce)
- Proxy: strip first `/api`; timeouts: default 4 min upstream; **interactive OAuth 15 min** (`provider/*/oauth/callback`, `mcp/*/auth/authenticate`).
- Failure translation: timeout → `504 {"error":"… upstream timed out"}`; connect fail → `503 {"error":"… service unavailable"}`; readiness hold (12 s grace, poll 75 ms) → `503 {error, restarting:true}`; exempt paths never held.
- Header hygiene: drop hop-by-hop + `authorization` request-side; drop `www-authenticate`/`content-encoding` response-side; force `accept-encoding: identity`.
- **Session list sanitation** (server-side, GET /api/session + /api/experimental/session): keep-list `id, slug, projectID, workspaceID, directory, path, parentID, title, agent, model, version, time, cost, tokens, share, metadata, project`; `summary` minus `diffs`; `revert` → `{messageID, partID?}`.
- `?directory=` values realpath-canonicalized server-side (cached). Worktree bootstrap gate holds directory-scoped requests (5 min) — NND-side, keep hook point.
- Directory transports (SDK §3.5a): directory header on **all** methods (percent-encoded); GET/HEAD interceptors move header → `?directory=` (and `location[directory]` for v2 `/api/` paths), delete header; POST/PATCH/DELETE/SSE keep header. Encoding marker header `*-directory-encoding: uri` for non-Latin-1, decoded+stripped in flight.
- Response bodies from harness are **bare payloads** (`Session[]`, `boolean`, 204 void…). `{data,error,response}` is the SDK-facade envelope synthesized client-side; **v2 harness surface (`/api/session/...`) returns `{data: …}` on the wire** (per rows 22-23).

## 3. Directory normalization (HP-4 restated, confirmed)
trim → `\`→`/` → drive upper → trailing-slash trim (keep root `/`) → empty⇒null. Normalized path is the store/cache key everywhere.

## 4. Harness REST inventory (rows we proxy; P-ids)
Core (P-02/04/05): `GET /path`; `GET /project/current`; `GET|POST /session`; `GET|PATCH|DELETE /session/{id}`; `GET /session/{id}/message` (+limit/before) → `[{info,parts}]`; `GET/DELETE /session/{id}/message/{mid}`; `PATCH/DELETE …/part/{pid}`; `GET /session/{id}/todo`; `POST /session/{id}/prompt_async` (**204**, body `{messageID?, model{providerID,modelID}, agent?, variant?, tools?, format?, system?, delivery?("steer"|"queue"), parts[]}`); `POST /session/{id}/message` (sync 200 `{info,parts}`); `POST /session/{id}/command` (model as `"p/m"` string, 200 `{info,parts}`); `POST /session/{id}/shell` (409 when busy); `abort`(boolean)/`revert`→Session/`unrevert`/`summarize`(boolean)/`fork`(Session, `{messageID?}`)/`init`; `GET /session/{id}/children`; `GET /session/{id}/diff?messageID=`; share/unshare; `GET /session/status?directory=` — **authoritative idleness map, omission=idle only after successful snapshot; null vs {} distinction load-bearing**.
Permissions v1: `GET /permission` (`PermissionRequest[]`), `POST /permission/{id}/reply {reply:"once"|"always"|"reject", message?}` → boolean, **404 = already settled (treat as success)**. v2 under `/api/session/...`: create `{id?,action,resources[],save?,metadata?,source?{type:"tool",messageID,callID},agent?}` → `{data:{id,effect:"allow"|"deny"|"ask"}}`; get → `{data: PermissionV2Request}`, **404⇒resolved**; separate map from v1 — never gate a v1 reply on v2 404 (#3259).
Questions v1: `GET /question`; `POST /question/{id}/reply {answers:string[][]}` (empty array = none; `custom:true` ⇒ free text as sole element); `/reject`; header ≤30 chars.
Config: `GET /config?directory=` merged effective; `PATCH /config {config}` **global, never carries directory**; `GET /config/providers?directory=` → `{providers: Provider[], default:{[providerId]:modelId}}`.
Providers: `GET /provider` → `Provider[]`; `GET /provider/auth`; OAuth `POST /provider/{id}/oauth/authorize {method:number,inputs?}` → `{url,method:"auto"|"code",instructions}`; `callback {method,code?}` → boolean; `PUT/DELETE /auth/{providerID}`.
Agents/commands/tools: `GET /agent` (empty-vs-error matters; UI raw-route fallback; **throws on failure**), `GET /command`, `GET /skill`, `GET /experimental/tool/ids` → string[] ([] on failure allowed only here).
Files/find: `GET /file`,`/file/content`,`/file/status`,`/find`,`/find/file?query&dirs&limit&type` → relative string[], `/find/symbol`.
Misc: `GET /global/health` → `{healthy:true,version}`; `POST /global/upgrade {target}` → `{success,version|error}`; `GET /mcp` statuses (`connected|disabled|failed|needs_auth|needs_client_registration`); vcs.*; PTY optional; worktree experimental optional.

## 5. Event stream (P-06/07)
- Global frame: `id: <n>` + `data: {"directory":"<dir>","payload":{"id","type","properties"}}`. Directory stream (`GET /event?directory=`) tolerant: envelope OR bare `{id,type,properties}`.
- Resume: `Last-Event-ID` header; replay from cursor; stall ⇒ abort+reconnect (250 ms delay; stall timeout 20 s, 60 s if >1 active session). Heartbeats `:heartbeat\n\n` (20 s) are keep-alive only, never state.
- Replay bounded: ≤2048 events / 8 MiB; unknown cursor ⇒ replayReset → clients resync from authoritative snapshots.
- Minimal event set (12.1): session.created/updated/deleted, message.updated/removed, message.part.updated/removed/delta, session.status, session.idle, permission.asked/replied, question.asked/replied/rejected, todo.updated, session.error, file.edited. Full §5.2 vocabulary for later; emit no-ops rather than dropping names.
- Ordering rules: causal within session; `message.part.updated` = durable boundary (same object REST returns); deltas keyed `(messageID,partID,field)` heal via next snapshot; `session.status` later-wins idempotent.
- Streaming shape: `session.next.text/reasoning/tool.*` are live transcription; materialization = `message.part.updated`.
- Worked examples: doc §5.2.1 (session.created full Session; text 3-frame + part materialization; tool lifecycle → ToolState pending/running/completed; permission ask; question ask; retry status w/ attempt+next; session.error APIError `{name,data:{message,statusCode,isRetryable,responseBody}}`; **synthetic restart interrupt carries `message` at error top level, real abort nests `data.message`** — reducer tolerates both, keep both).

## 6. Shapes (exact, §6) — extracted to `packages/ui/src/lib/nna/types.ts`
- Session: id/slug/projectID/workspaceID?/directory/path?/parentID?/summary{additions,deletions,files}/cost?/tokens{input,output,reasoning,cache{read,write}}/share?{url}/title/agent?/model{id,providerID,variant?}/version/metadata?/time{created,updated,compacting?,archived?}/permission[]/revert{messageID,partID?,snapshot?,diff?}.
- UserMessage: id/sessionID/role/time{created} single ordering key/format?/agent/model{providerID,modelID,variant?}/system?/tools?.
- AssistantMessage: +parentID(user msg id)/modelID/providerID/mode/agent/path{cwd,root}/cost/tokens{total?,…}/error?/finish?/time.completed?.
- Error union names exact: ProviderAuthError/UnknownError/MessageOutputLengthError/MessageAbortedError/StructuredOutputError/ContextOverflowError/ContentFilterError/**APIError**.
- Parts (all `{id,sessionID,messageID,type}`): text{synthetic?,ignored?,time?{start,end?}}; reasoning; file{mime,url,filename?,source?}; tool{callID,tool,state}; subtask; step-start{snapshot?}; step-finish{reason,cost,tokens}; snapshot; patch; agent{name,source?}; retry; compaction{auto,overflow?}. ToolState: pending{input,raw}/running{input,title?,metadata?,time.start}/completed{input,output,title,metadata,time{start,end,compacted?},attachments?}/error{input,error,metadata?,time}.
- Todo `{content,status,priority}`; SessionStatus idle|busy|retry{attempt,message,next,action?}; PermissionRequest v1 `{id,sessionID,permission,patterns[],metadata,always[],tool?}`; QuestionRequest `{id,sessionID,questions[{question,header,options[{label,description}],multiple?,custom?}],tool?}`; Project/Path/McpStatus per §6.8-6.9.
- Provider/Model: full §7.2 worked example — capabilities, cost, limit, variants keyset = thinking-level picker; `default` map per provider.

## 7. Invariants we must defend (§11)
1 status snapshot authoritative; 2 never mask failure as empty (throw-on-error reads; null≠{}); 3 injection/rotation/upgrade only for owned processes; 4 promptDispatched observed not accepted (204≠dispatch; confirm new user message ≤5 s; lookup failure ≠ loss); 5 waits need observed activity, timeout=failure; 6 validate model/agent/variant against directory's own lists before side effects, empty lookup ⇒ fail-open; 7 partial results/failedIds, one failure doesn't erase siblings; 8 transport failure ≠ refusal, ambiguous send never retried; 9 destructive ops excluded from agent tools; 10 loopback-only privileged callbacks + per-child token, timing-safe; 11 never log secrets (≤32 KiB sanitized tails); 12 heartbeats are diagnostics; 13 replay bounded, unknown cursor ⇒ authoritative repair; 14 sort by time.created; **caller messageID echoed verbatim** (ascendingId monotonic `msg_…`); 15 v1/v2 permission maps separate; 16 broken config files never rewritten; 17 busy sessions gate destructive restarts.

## 8. Selection precedence (§7.5): explicit request (validated) → target session's last user message → settings defaults → harness config (`default_agent`, `model:"p/m"`) → agent's own model → `opencode/big-pickle` (if exists) → first provider's first model → 400. Variant only if model.variants has key.

## 9. NND/NNA adaptation deltas (DECISIONS-synced)
- **D12** Harness responses bare (no `{data}`); facade synthesizes `{data,error,response}`; v2 harness surface keeps `{data}` on the wire.
- **D13** Renames for the seam: header `x-nnd-directory(-encoding)`; stdout contract `notnativeagent server listening on <URL>`; env `NNA_PORT/NNA_HOST/NNA_SKIP_START/NNA_BINARY/NNA_SERVER_PASSWORD` (`NNA_SERVER_USERNAME` default `nna`), health env `NNA_HEALTH_TIMEOUT_MS`(5000)/`NNA_HEALTH_INTERVAL_MS`(15000)/`NNA_HEALTH_CONSECUTIVE_FAILURES`(20)/`NNA_HEALTH_CACHE_MS`(750); Basic auth username `nna`. Control-synth family `notnative:*` (`session-status`, `session-activity`, `heartbeat`, `event-stream-ready`, `notification`, …) replacing `openchamber:*`; NOT on raw harness SSE (control stream/WS bridge only). All pending a coordination pass with NNA — single files: `server/lib/harnessNaming.ts` ↔ `ui/src/lib/nna/constants.ts`.
- **D14** Mock harness implements §12.1 minimal + selected §12.2 (v2 permission endpoints, tool ids, commands, fork/abort/revert/summarize, permission/question flows via "permission"/"question" text triggers). Lifecycle (P-01 spawn/stdout parse/port freedom), Basic auth (P-03), orphan registry, health monitor → NNA adapter concerns, not mock. Small-model/quota/catalog/TTS/terminal/git/fs = server-owned (P-21 etc. out of harness scope, doc 03).
- **D15** Wire names duplicated in `web/src/server/lib/harnessNaming.ts` (node can't import Vite-flavored ui module graph); the two files must change together.
- **D16** WS bridges (`/api/global/event/ws`, `/api/event/ws`) deferred to P2 with doc 04's pipeline; P1 ships SSE only (`/api/event`, `/api/global/event`) with Last-Event-ID replay. Frame vocabulary (§9.4) recorded in NOTES here for P2: `event{payload,eventId?,directory?}`, `ready{replayReset?}`, heartbeat frames, `backpressure{bufferedBytes,maxBytes}` (warn 12 MiB, close 1013 @16 MiB).
- Realtime-proxy escape hatch (`/api/notnative/realtime-proxy/sse|ws?url=`) when custom runtime headers exist — P8 desktop concern; recorded.

## 10. Test hinge points (§12.3) we can exercise already
messageID echo reconciliation; abort mid-part ⇒ part lands error, session idles; v1 reply while v2 404; question resync by id + custom answer round-trip; status omission=idle after snapshot; replay from Last-Event-ID; unknown cursor ⇒ reset semantics (P2).
