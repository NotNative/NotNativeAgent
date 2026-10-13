# NotNativeDesktop

> **Folded (20261012-2):** this product now lives in the NotNativeAgent repository
> at `desktop/`. NND development, documentation, and release activity happen there;
> this checkout is an archive that must not receive further focused development.

A cleanroom re-implementation of [OpenChamber](https://github.com/openchamber/openchamber)
— a workspace for running and reviewing AI coding-agent work — built from the
static-analysis specifications in [`docs/planning/`](docs/planning/00-INDEX.md).
OpenChamber implementation code must not be copied into this product. The
[executable build guide](docs/build/PLAN.md) governs current NNA integration;
the planning corpus supplies reference behavior and UX detail.

- **Harness:** [NotNativeAgent](docs/architecture/0020-nna-ecosystem-topology.md)
  (NNA) owns the engine, governance, and lifecycle. NND is its optional GUI
  integration package, not an independently installed agent runtime. The
  installed NND package requires NNA and registers with it during setup. When
  NNA is absent, the installer can install a carried NNA release after checking
  its release manifest against a SHA-256 obtained from a trusted source. Pass
  `-NnaDependencyRoot`, `-NnaDependencyManifestSha256`, and
  `-InstallNnaIfMissing` for unattended setup. The sibling checkout remains a
  development-only source fallback; unattended runs require explicit opt-in.
  A mock harness remains available for isolated development tests.
- **Surfaces today:** local web GUI and Electron desktop shell. VS Code and
  mobile are long-term deferred.
- **Start here:** `docs/build/PLAN.md` · `docs/build/PROGRESS.md` · `docs/build/DECISIONS.md`

The target Windows product has a persistent NNA-supervised NND service, reachable
from browser or desktop, with complete native settings and chat/visibility support.
NNA's TUI retains its own identity and tabs. This target remains in progress:
the selected NNA installation now supervises the persistent service, and Electron
attaches as a client. Actual disposable installed-payload and Chromium checks pass.
Existing-data migration, login startup, recovery and complete settings parity remain open.
Package registration and source integration tests do not establish installed acceptance.

## Dev loop

```bash
pnpm install
pnpm dev          # API :3902 + Vite UI :5180 → open http://127.0.0.1:5180
pnpm test         # unit/contract tests (vitest)
pnpm typecheck
pnpm build && pnpm start   # production UI bundle served by the Node server
```

## Browser background notifications

Configure `NOTNATIVE_PUSH_SUBJECT` as an operator contact such as
`mailto:operator@example.com` or a public HTTPS contact page. Sending stays
disabled without a valid contact. Use a secure production browser connection,
enable the desired events in Settings → Notifications, and register the browser
there. A UI session or trusted-device credential is required; anonymous local
access cannot register push. Existing subscriptions created before recipient
expiry/revocation metadata was added must be registered again.

Push delivery pauses while an interactive client is visible. Notification
clicks open the referenced session through NNA's authenticated lookup. An
existing window at that exact session URL is focused; other drafts stay open.
Live browser delivery acceptance remains in progress.

## Layout

```
packages/ui      @notnative/ui   shared React UI: shell, stores, sync engine, runtime adaptation
packages/web     @notnative/web  server (Node+Hono) + HTML/JS entrypoints + harness adapters
packages/electron                Electron shell (doc 09)
docs/planning    cleanroom specification (input)
docs/build       build-time notes, decisions, progress (our output)
```
