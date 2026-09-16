# Progress Log

Goal: full cleanroom build of NotNativeDesktop per docs/planning (see `PLAN.md`).

| Phase | Doc(s) | Status |
|---|---|---|
| P0 scaffold + shell | 01 | ✅ done 2026-07-21 (typecheck ×3 · vitest 6/6 · vite build · prod-serve + echo-loop smoke) |
| P1 harness seam | 02 | pending |
| P2 sync engine | 04 | pending |
| P3 chat UI | 05 | pending |
| P4 server/API | 03 | pending |
| P5 themes/settings | 14 | pending |
| P6 review | 06 | pending |
| P7 terminal | 07 | pending |
| P8 autonomy | 12 | pending |
| P9 knowledge/context | 15 | pending |
| P10 preview | 13 | pending |
| P11 remote/security | 08 | pending |
| P12 Electron | 09 | pending |
| (deferred) VS Code | 10 | long-term deferred |
| (deferred) Mobile | 11 | long-term deferred |

## Log

- 2026-07-21 · Read 00-INDEX + 01 in full. Scoping decisions recorded (harness=NNA
  later + mock now; web spine → Electron; defer 10/11; stack per DECISIONS.md).
  Writing P0 scaffold.
- 2026-07-21 · **P0 done.** Monorepo (pnpm·Node24-native-TS·Hono·Vite7·Tailwind4·
  zustand5), runtime lib (globals, url/auth/fetch-bridge+HP-6 coalescing, endpoint
  switch, surface stamp, splash, startupTrace, chunkRecovery), harness seam + mock
  harness (echo loop, SSE /api/event), control SSE, auth-session/url-token stubs,
  App boot state machine (10× retry → recovery screen), MainLayout skeleton
  (sidebar/header/chat/rail), vitest 6/6, production bundle served by the Node
  server. Verified: /health, /auth/*, /api/session echo POST→reply, / + assets 200.
  Known limits: agent sandbox cannot spawn esbuild → dev-loop (`pnpm dev`) is a
  user-terminal step; browser visual check pending user eyes at http://127.0.0.1:3902.

## Delta/Delayed register

| # | Item | Phase landing | Note |
|---|---|---|---|
| D1 | Mock harness semantics | P1 (doc 02) | P0 ships `/health`,`/auth/*`,`/api` proxy + control SSE only |
| D2 | Real auth (password/passkey) | P11 (doc 08) | P0 ships allow-all session + url-token mint |
| D3 | PWA manifest endpoint, SW update UX | P4 | P0 uses fallback manifest |
| D4 | GitHub/Linear/push integrations | P3/P4 | API members stubbed behind RuntimeAPIs optional fields |
| D5 | Terminal/git/files RuntimeAPIs bodies | P6/P7 | throwing stubs with typed contracts now |
| D6 | Electron globals/boot outcome | P12 | types now, behavior later |
| D7 | dev loop (`pnpm dev`) verification | user terminal | agent sandbox blocks esbuild/vite spawns; prod-build path verified instead |
| D8 | `system` theme variant via matchMedia | P5 (doc 14) | system currently renders dark |
| D9 | PWA manifest link + install/push hooks | P4/P11 | server endpoint exists; HTML prelude simplified |
| D10 | mobile surface | long-term | renders desktop tree + console warning |
| D11 | control-stream consumers | P2 (doc 04) | subscribed in App, handlers minimal |
