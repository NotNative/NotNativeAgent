# Decisions (living document)

## Product identity

Product name **NotNativeDesktop** (short: NotNative). Brand map applied everywhere
(strings, keys, routes, globals, events). When the doc 02 contract is finalized with NNA,
harness-facing names may be re-coordinated — they are centralized in
`harness-constants` files (server + UI) so a rename is one file each side.

**Ecosystem roles (ADR 0020, 2026-09-16)**: NNA is the root, headless-first harness
product (harness + TUI + daemon lifecycle in core; no built-in GUI; add-on activation
contract — NNO today, NND as second consumer). NND is the GUI integration package
(web service + desktop shell + client engine) plus a standalone remote client; NND
client can only connect to NNA instances with the NND web-service package installed.
NNO is the business layer installed on top of NNA. Delegated contexts spawn per
consumer (run-as entitlement). Full framing: `docs/architecture/0020-nna-ecosystem-topology.md`.

| Reference (OpenChamber) | NotNativeDesktop |
|---|---|
| `openchamber:` DOM event / channel prefix | `notnative:` |
| `__OPENCHAMBER_*__` window globals | `__NOTNATIVE_*__` |
| `window.__openchamberAppReady` | `window.__notnativeAppReady` |
| `/api/openchamber/*` server routes | `/api/notnative/*` |
| `x-opencode-directory` header | `x-nnd-directory` (NNA-final) |
| `oc_url_token` query param | `nn_url_token` |
| `openchamber://` deep link | `notnativedesktop://` |
| `openchamber-ui://` protocol | `notnative-ui://` |
| localStorage prefix `openchamber.*` | `notnative.*` |
| env `OPENCHAMBER_*` | `NOTNATIVE_*` |
| CLI `openchamber` | `notnative` |
| OpenCode / "harness" | NotNativeAgent (NNA); interim mock implements the same contract |
| `@openchamber/ui|web` packages | `@notnative/ui|web` |
| SSE control stream `/api/openchamber/events` | `/api/notnative/events` |
| `OPENCODE_*` harness env | `NNA_*` (final coordination point with NNA repo) |

## Stack (docs-silent areas → chosen equivalent)

| Area | Reference | Ours + why |
|---|---|---|
| Server framework | Express 5 on Bun | **Hono 4 on Node 24** — Windows-native, typed routing for ~253 routes, first-class SSE streaming; Bun avoided on Windows |
| Server runtime/build | bun, bundled | **Node 24 native TS execution** (`node --watch src/server/index.ts`, erasable-syntax-only TS); no separate server build step on Windows |
| Package manager | bun workspaces | **pnpm 10** workspaces |
| UI build | Vite | **Vite 7** (same); React 19; no react-compiler initially |
| Styling | Tailwind + tokens (doc 14) | **Tailwind v4** (`@tailwindcss/vite`); token tables land with doc 14 phase; CSS-var placeholders until then |
| State | zustand | **zustand v5** (same role; doc 04 owns semantics) |
| Toasts | sonner | **sonner** (doc 05 expects its behavior) |
| Icons | lucide (inferred) | Deferred to doc-14 phase (icon+sprite system is owned there); text/emoji placeholders until then |
| Router | none (custom) | Same: custom `useRouter` (doc 01 §12) |
| Terminal renderer | ghostty/vt | **xterm.js** default; ghostty ABI re-derivation is a doc-07 phase decision |
| Diff renderer | Pierre | Decided at doc-06 phase (doc 06 gap note allows substitution behind the data model) |
| Base components | @base-ui/react (inferred) | Build small local primitives first; adopt Base UI at P3 if it earns it |
| i18n | 12 locales (doc 14) | Custom thin provider + en dictionary first; catalog format per doc 14 |
| Tests | vitest | vitest (unit/contract); browser smoke via manual `pnpm dev` + user verification; Playwright only if needed later |
| Data dir | doc 03 owns | Placeholder `~/.notnative-desktop` until P4 |

## Ports (development)

| Port | Use | Env |
|---|---|---|
| 3902 | dev API server (HMR mode) | `NOTNATIVE_HMR_API_PORT` |
| 5180 | dev Vite UI | `NOTNATIVE_HMR_UI_PORT` |
| 3000 | standalone server default (`notnative serve` era, P4) | `NOTNATIVE_PORT` |

## Architecture commitments (from doc 01, adopted)

1. One shared UI package serves every runtime via `__NOTNATIVE_RUNTIME_APIS__` injection;
   web entry implements `createWebAPIs` over HTTP routes.
2. UI talks to exactly one instance origin; harness traffic is proxied under `/api`.
3. Custom query-param router; no router library.
4. Runtime endpoint switching with the exhaustive store-reset contract (§11.2) — grows as
   stores arrive; every new per-instance cache must join the reset list or key by runtime.
5. Boot gating is authoritative; splash removal driven by validated state, never guesses.
6. GET coalescing allowlist, 30 s SDK reads / 4 s health probe, URL-token lifecycle with
   atomic swap + proactive refresh.
7. Mock harness lives at `packages/web/src/server/harness/` behind a `HarnessAdapter`
   interface; NNA integration = one new adapter file.
