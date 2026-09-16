# NotNativeDesktop Reference — 11. Mobile Surface

Complete re-implementation specification for OpenChamber's mobile story: the
**hosted mobile web surface** the OpenChamber server serves to phones/tablets
(`mobile.html` → `MobileApp`), and the **Capacitor native shell** (`packages/mobile`,
iOS + Android) that wraps the same build with native plugins, push, widgets, deep
links, QR pairing, and dev tooling.

Audience: engineers with zero access to the source repository. Everything needed to
implement the mechanism is inline; `(src: packages/...)` citations are traceability
only. Where a behavior belongs to another document, it is referenced and not re-specified.

Cross-references (do not re-spec here):

- **01 architecture/app-shell** owns the shared app shell, the hosted desktop surface,
  the PWA install path, and `RuntimeAPIs` — the consumer-facing API surface this
  document consumes. The mobile surface calls the same APIs; only its deltas are
  labeled here (see section C.10 "Harness ports").
- **04 sync/state** owns the sync engine, bootstrap, reconnect, session-ui store,
  notification store, and reconciliation. Mobile re-mounts the same `SyncProvider`;
  only its endpoint-key semantics and resume triggers are specified here.
- **05 chat/session UI** owns the chat underside (chat view, message rendering,
  composer internals, plan view). This doc owns the mobile *shell* around it:
  layering, gestures, keyboard choreography, and composer-shell state machine.
- **08 remote access/security** owns private relay (E2EE tunnel) internals, pairing
  protocol and QR payload issuance server-side. This doc owns the mobile *pairing
  UX* (scanner, candidate probing, saved connections) and token storage on device.
- **03 server/API** owns the OpenChamber server routes and notification delivery;
  push/relay handoff endpoints are listed here only as consumed contracts.
- **14 settings/theme** owns the settings registry and theme tokens; this doc owns
  only mobile-specific layout deltas (keyboard mode, splash colors, safe areas).

---

## A. Mobile strategy overview

### A.1 Two surfaces, one renderer

OpenChamber ships **one mobile renderer** — the React tree `MobileApp` — built as a
second HTML entry of the shared web bundle and delivered two ways:

1. **Hosted mobile web surface.** The OpenChamber server serves the web build
   statically, including `mobile.html` beside `index.html` (both are Vite rollup
   inputs, src: packages/web/vite.config.ts line 136). A phone hitting the server in
   a browser gets either the desktop app (`index.html`) or the mobile app, decided
   once at boot by a surface heuristic (B.2), or by `?surface=mobile` in the URL.
   The browser copy has **no** onboarding/instances/QR features: auth is the classic
   server password gate (01 owns it), and the runtime is same-origin.
2. **Capacitor native shell.** `packages/mobile` copies the finished web build into
   `dist/`, renames `mobile.html` → `index.html` so the WebView boots straight into
   `MobileApp` with no surface selector (src: packages/mobile/scripts/prepare-web-assets.mjs;
   packages/mobile/README.md), and Capacitor serves it from a bundled local origin.
   The app contains **no embedded server**: it connects to an existing OpenChamber
   server over direct HTTP (LAN/tunnel) or through the private relay (08). Native
   capabilities come from Capacitor plugins plus two iOS app extensions.

### A.2 The exact split of features

| Capability | Hosted `mobile.html` (browser) | Capacitor shell |
|---|---|---|
| Chat, session tree, workspace drawer, settings, theme | Yes | Yes (same shared UI) |
| Server password unlock (browser `SessionAuthGate`) | Yes | No — per-instance unlock flow instead (C.7) |
| Connection onboarding screen, saved instances, QR scan, `Instances` entry | No | Yes (commit: "Capacitor-only", src: packages/mobile/HANDOFF.md line 19) |
| Web push subscription (service worker) | Yes (04/03 own it) | No — APNs/FCM instead |
| In-app local notification dispatch (Web Notifications API) | Yes | No — replaced with no-op APIs at boot (B.1.3) |
| Native push registration | No | Yes (C.6) |
| Deep links (`openchamber://`), widgets, app badge | No | Yes (C.8, C.9) |
| Server-update toast (renderer update) | Yes | No — native app updates via store; Android shows a store-download toast (F.6) |
| Secure token storage | No (token inline in localStorage) | Yes, OS Keychain/Keystore (C.7.6) |
| Keyboard handling | `dvh` + `interactive-widget` | plugin + FLIP choreography (B.7, C.5.3) |

The gate for "am I the native app?" is
`isCapacitorMobileApp()`: `window.Capacitor.isNativePlatform() === true` OR
`window.location.protocol === 'capacitor:'` (src: packages/ui/src/apps/mobileNativeChrome.ts:6).
The generic `isCapacitorApp()` in `lib/platform.ts` is the same check used platform-wide.

### A.3 Native platform identity at runtime

- `getClientPlatform()` returns `ios` | `android` (from `Capacitor.getPlatform()`),
  else `vscode` | `desktop` | `web` (src: packages/ui/src/lib/platform.ts:65). The
  server uses this to tag push tokens and visibility beacons; only `ios`/`android`
  count as push-recipient mobiles.
- `isIPadApp()` — Capacitor reports `ios` for iPad too; iPadOS WKWebView masquerades
  as macOS Safari, so the tell is Capacitor-`ios` AND (explicit `iPad` UA OR a
  Mac-like platform/UA with `maxTouchPoints > 1`) (src: packages/ui/src/lib/platform.ts:49).

---

## B. Hosted mobile web surface (also the root of the native UI)

Because the Capacitor app runs the exact same renderer, everything in section B
applies to *both* copies of the surface except where marked "**hosted only**" or
"**native only**".

### B.1 Entry pipeline

#### B.1.1 `mobile.html` (src: packages/web/mobile.html)

- Viewport meta (exact string): `width=device-width, initial-scale=1.0, maximum-scale=1.0,
  user-scalable=no, viewport-fit=cover`. The later keyboard mode setting may append
  `interactive-widget=resizes-content` (B.8.2); it edits this meta element at runtime.
- **Blocking pre-paint theme script** — runs before CSS/React to kill the
  white→theme flash on cold launch:
  1. Read localStorage keys `themeMode` (`light`/`dark`/`system`), `useSystemTheme`,
     `selectedThemeVariant`.
  2. Decide `isDark`: explicit mode wins; `system`/unset follows
     `prefers-color-scheme: dark`; a `selectedThemeVariant` of light/dark is the tiebreak.
  3. Add `dark` or `light` class to `<html>`, set `style.color-scheme` the same way
     (this drives the WebView's canvas color during the pre-CSS gap).
  4. Background color: `splashBgDark` / `splashBgLight` localStorage — the resolved
     theme `surface.background` the theme system persists (14). Fallbacks are the
     default flexoki dark/light backgrounds: `#171515` / `#fffdf4`.
  5. Set BOTH `--background` inline on `<html>` AND `root.style.backgroundColor`.
     Setting the var is required because design-system.css ships a *non-important*
     baked `.dark { --background: … }` default that would overpaint a plain element
     background the moment the sheet loads; inline vars win over that until React's
     `!important` theme vars take over.
  6. All of it wrapped in try/catch — restricted storage just defers to React init.
- Body: `<body class="h-full bg-background text-foreground"><div id="root" class="h-full">`.
- `<title>OpenChamber Mobile</title>`.

#### B.1.2 `mobile-main.tsx` (src: packages/web/src/mobile-main.tsx) — **harness port**

1. Create the runtime API object: `createConfiguredWebAPIs()` from the web runtime
   (01 owns this factory). This is the `[HARNESS PORT]`: on your agent harness you
   must produce an object satisfying `RuntimeAPIs` (01 §marked section) *before* the
   app boots.
2. Stamp `window.__OPENCHAMBER_RUNTIME_APIS__` with it.
3. Dynamic-import `@openchamber/ui/apps/renderMobileApp` and call
   `renderMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__)`.

#### B.1.3 `renderMobileApp` boot sequence (src: packages/ui/src/apps/renderMobileApp.tsx)

Order matters; do not commute steps:

1. `window.__OPENCHAMBER_SURFACE__ = 'mobile'` — stamped BEFORE anything else so
   `isMobileSurfaceRuntime()` consumers (perf tuning, sync paging, device info) see
   the stable answer. On a native shell this one line keeps an iPad in landscape in
   the mobile device branch (B.3.2).
2. `preloadMarkdownRenderer()` — warm the chat renderer chunks.
3. shared prefs init chain: `initializeLocale()`, then
   `initializeAppearancePreferences()`, `syncDesktopSettings()`,
   `applyPersistedDirectoryPreferences()`, `startAppearanceAutoSave()`,
   `startModelPrefsAutoSave()`, `startTypographyWatcher()`; the chain ends in
   `markAppBootReady()` which releases the font splash gate in `MobileApp`.
4. `installMobileWidgetSnapshotBridge()` — native-only consumer; installs
   `window.__OPENCHAMBER_WIDGET_SNAPSHOT__ = () => JSON.stringify(snapshot) | null`
   (C.9.4). Harmless in a browser.
5. `getDeviceInfo()` synchronously — applies `device-mobile` / `mobile-pointer`
   classes to `<html>` BEFORE the first React paint (mobile typography in
   `mobile.css` keys off them; applied late they shift layout a frame after mount).
6. **Native notification no-op**: if `Capacitor.isNativePlatform()` is true (or
   `capacitor:` protocol), replace `apis.notifications` with
   `{ notifyAgentCompletion: async () => false, canNotify: () => false }`.
   Rationale: a WKWebView cannot distinguish foreground from background
   (`document.hasFocus()` lies), local notifications leaked while the app was open,
   and the Web Notifications API never displays inside a WKWebView. APNs/FCM is the
   only native channel (C.6).
7. **Auth gating split**: render `<MobileApp apis={resolvedApis}/>` bare on the
   native shell (it has its own connect flow); wrap it in the shared
   `<SessionAuthGate>` in a browser (01 owns the gate).
8. Providers around both: `StrictMode`, `I18nProvider`, `ThemeSystemProvider`,
   `ThemeProvider`, `DiffWorkerProvider`.

#### B.1.4 Surface decision (hosted; src: packages/ui/src/lib/runtimeSurface.ts)

Single authority `detectHostedSurface()`, priority order:

1. explicit stamp `__OPENCHAMBER_SURFACE__` (set at boot; never re-detected), then
2. URL override `?surface=mobile|desktop`, then
3. Capacitor shell → `mobile` always,
4. desktop shells (electron/VS Code) → `desktop`,
5. phone heuristic: `min(window.innerWidth, screen.width) <= 768` AND touch/coarse
   pointer (pointer:coarse, or hover:none, or maxTouchPoints>0).

`watchHostedSurfaceViewport()`: the stamp is fixed, so if the viewport later stops
matching the phone heuristic (window crossed 768), clear the stamp and
`location.reload()` after an 800 ms resize debounce. Shells and explicit URL
overrides never auto-switch.

### B.2 Screen-first frame rules (shared by both copies)

`src: packages/ui/src/styles/mobile.css` (775 lines). Highlights the re-implementation must keep:

- Mobile typography overrides on `:root.mobile-pointer:not(.desktop-runtime)`:
  markdown 1rem, code 0.875rem, ui-header 0.9375rem, ui-label 0.875rem, meta 0.875rem,
  micro 0.8125rem; applied with `!important` because variants override the same vars.
- Touch targets: all buttons / `[role="button"]` ≥ 36×36 px. Inputs/textareas ≥ 36 px
  tall AND `font-size: 16px !important` for text-type inputs — **16 px is the iOS
  no-zoom threshold**; an autofocus input at 14 px triggers the iOS zoom-on-focus.
- Page scroll lock: `[data-page-scroll-lock="true"] { overflow: hidden !important;
  overscroll-behavior: none; }` — the app shell, drawers, and sheet host all carry it.
- Root height: `100dvh` when supported (`@supports (height: 100dvh)`), legacy
  `-webkit-fill-available` fallback otherwise. The fallback is REQUIRED for iOS but
  MUST NOT win on Android: `-webkit-fill-available` freezes the root at the
  pre-keyboard height on Android Chrome when `interactive-widget=resizes-content`
  shrinks the viewport, clipping the composer behind the keyboard with no scroll to
  reach it.
- Safe-area tokens (iOS + PWA block, and duplicated for the Android Capacitor class,
  see C.5.2): `--oc-safe-area-top/right/bottom/left` from `env(safe-area-inset-*)`;
  `--oc-safe-area-bottom-visual = clamp(0, bottom*0.35, 12px)` — a *visual* inset that
  does not steal tap room under the home indicator. Helper classes
  `.header-safe-area` (padding-top), `.main-content-safe-area`, `.bottom-safe-area`
  consume them. The Capacitor android app additionally has
  `--oc-app-bottom-safe = max(16px, bottom inset)` and opt-in
  `.oc-bottom-safe-surface { padding-bottom: var(--oc-safe-area-bottom) }` for
  Android 15 edge-to-edge.
- Installed PWA body::after gradient: a bottom `linear-gradient` over the home
  indicator area (height `--oc-safe-area-bottom-visual`), fading from the theme
  background to transparent, `pointer-events: none`, z-index 1000.
- Toasts (`sonner` toaster) anchored top-center with
  `offset = calc(var(--oc-safe-area-top, 0px) + 16px)` on native and PWA.
- Code blocks inside markdown keep horizontal scroll
  (`overflow-x: auto; overflow-y: hidden`) but vertical page scroll is owned by the
  chat scroller.
- Message text selection: `-webkit-user-select: text; -webkit-touch-callout: none`
  with a `.show-system-menu` opt-back-in for the custom selection menu's "More" action.

### B.3 Device / tablet layout model

#### B.3.1 `DeviceInfo` (src: packages/ui/src/lib/device.ts)

`getDeviceInfo()` computes per render tick (rAF-batched, resize + pointer/hover
media-query listeners, external store):

- breakpoints xs..2xl (0/640/768/1024/1280/1536);
- `hasTouchInput` = pointer:coarse OR hover:none OR maxTouchPoints>0;
- `hasTouchOnlyPointer` = coarse OR hover:none;
- desktop-shell override `?surface=desktop` pins everything to desktop;
- decision: on the **mobile surface runtime** (stamped in B.1.3) it answers
  `deviceType: 'mobile'` unconditionally — *no* tablet/desktop branch is allowed to
  leak from shared components on an iPad or Android tablet. Tablet upgrades are a
  separate size class (B.3.2), never a device type.
- Root classes applied: `device-mobile`/`device-tablet`/`device-desktop` +
  `mobile-pointer` when touch; `desktop-runtime` for shell runtimes.

#### B.3.2 Tablet layout — a size class, not a device check
`src: packages/ui/src/lib/device.ts:368-447`

```
TABLET_LAYOUT_MIN_SHORT_SIDE_PX = 600   // Android 'sw600dp' convention
WORKSPACE_PANEL_MIN_WIDTH_PX    = 1000
```

`readTabletLayout()`:

- `enabled = isIPadApp() || min(width, height) >= 600`
  (iPads short-circuit on identity: iPadOS reports odd viewports in Split View /
  Slide Over, and a known tablet must not flip to the phone layout in a narrow slice).
- `roomyForPanels = enabled && width > height && width >= 1000`
  (there is room for the workspace beside the chat — sessions sidebar ~320 +
  panel ~380 + a readable chat).

`useTabletLayout()` is a live hook: rAF-batched resize + orientation media-query
listener; foldables change size class *while running* and every consumer re-decides.
The Android activity keeps the WebView alive across folds via `configChanges`
(C.4.1); iOS never recreates JS state on rotation either, so both shells rely on this
hook, never on a mount-time check.

Consequences by device (the shipping model):

| Device state | Tablet layout | Workspace |
|---|---|---|
| Phone (short side < 600) | off | full-cover drawer |
| 7"+ tablet portrait | on | drawer (width < 1000) |
| 7"+ tablet landscape | on | side panel |
| Book foldable unfolded (long side < 1000) | on | drawer in BOTH orientations |
| Book foldable folded shut | off | phone layout |
| iPad (any) | on (identity) | panel only when roomyForPanels |

#### B.3.3 Orientation

`useOrientation()` = `matchMedia('(orientation: landscape)')` live. The only
subscribes that meaningfully change layout: `workspaceAsPanel = roomyForPanels`
(orientation + width), and keeping draft starter chips while
`isTabletLayout && (isPortrait || hasHardwareKeyboard)` (B.8.5). There is **no**
orientation lock in the renderer; iOS allows portrait + both landscapes on iPhone,
portrait(upside-down included) + landscapes on iPad (C.4.2); Android follows the
manifest `configChanges` (C.4.1).

### B.4 Shell model (src: packages/ui/src/apps/MobileApp.tsx `MobileShell`)

The mobile root never mounts the desktop `MainLayout`. Its structure:

```
<div class="oc-mobile-app-shell main-content-safe-area flex h-[100dvh] flex-row ..." data-page-scroll-lock="true">
  [tablet] <aside> persistent sessions sidebar (left, resizable) </aside>
  <div class="flex h-full min-w-0 flex-1 flex-col">
    <MobileHeader/>
    <main> ChatView (always the center of the shell) </main>
  </div>
  [phone] MobileSessionsSheet parked off-screen (kept warm, drawer variant)
  [tablet] <aside> workspace panel (right, resizable, only when roomyForPanels) </aside>
  [phone] MobileWorkspaceDrawer (full-cover variant)
  layers: MobileFullscreenSurface × (plan | instances | settings | update)
</div>
```

Layer/z concept, top-most first (this exact order drives the Android back button):

1. `openPlan` — a plan opened fullscreen from the workspace drawer's Notes tab.
2. `activeSurface` — one app-level surface at a time: `instances` (native only),
   `settings` (rich drill-down with its own back stepping), `update` (hosted only).
   Opening one replaces the previous; closing returns to chat. On a tablet these
   render as centered dialogs (`surfaceVariant 'dialog'`), on phones fullscreen.
3. workspace drawer/panel (right).
4. sessions sheet / sidebar (left).

The header has **no overflow menu** (README: mobile concept). It is: sessions list
button (left) · session title doubling as the recent-sessions switcher trigger with
rotating chevron · metadata button · workspace button (right) with an amber dot when
the active project/worktree has uncommitted changes (src: packages/ui/src/apps/MobileHeader.tsx).

### B.5 Session-tree UX and stores

The drawer/sidebar content is `MobileSessionsSheet` (src: .../apps/MobileSessionsSheet.tsx,
~2300 lines). Structure and contracts:

- **Tree**: projects (sorted manual/az/za/date-added/recent — same options and
  labels as the desktop sidebar; shared persisted setting) → per-project
  worktree buckets (root bucket when sessions live at the project root; label =
  branch name, else folder name; sessions matched by directory-path containment and
  exact worktree match) → sessions sorted by recency desc. Unmatched sessions go to
  a "recent" pseudo-group. Subsessions (children via `session.parentID`) render
  nested under their parent with `CHILD_INDENT_STEP = 16` px extra per level; base
  session row indent is `PROJECT_SESSION_INDENT = 40` px so titles align with parent
  labels. `SESSIONS_PER_BUCKET = 7` with "show more" per bucket.
- **Expansion persistence**:
  - `useMobileSessionTreeStore` (zustand + persist, storage key `mobile-session-tree`):
    `projectExpanded: Record<projectId, boolean>` and
    `worktreeExpanded: Record<`${projectId}::${bucketKey}`, boolean>`. Missing key =
    default; **projects default expanded, worktree groups default collapsed**. Stored
    only as explicit user overrides; selecting a session never forces a node open
    (src: packages/ui/src/stores/useMobileSessionTreeStore.ts).
  - `useMobileSessionExpansionStore` (plain zustand, no persist): parent-session
    expansion for subsessions. Survives sheet close/unmount (module-level) and resets
    on full page reload (src: packages/ui/src/stores/useMobileSessionExpansionStore.ts).
- **Row interactions**: tap selects (and closes the sheet only where the sidebar is a
  guest on a tablet — `roomyForPanels === false` — per C of README §13; on the phone
  close is unconditional); left/long-press context actions: rename (AI rename
  available), pin, archive, delete, worktree delete dialog, project edit surface
  (icon/label/color/icon image); drag-to-reorder via dnd-kit (useDragToReorder — same
  engine as `sortProjectByManualOrder`); pinned sessions sort to top (pinned store).
- **Search**: fuzzy title/id/directory/project-label match (`matchesRankQuery`,
  matches `rankByQuery` conventions) with a clear button.
- **New session**: "+" opens the new-session draft (directory explorer dialog or
  project preselect); "new worktree" dialog for git projects.
- **Footer** (app-level, same on drawer and sidebar): left = connected instance
  label (native only → opens the Instances surface); right = settings button and,
  hosted only, a pending server-update item (src: MobileApp.tsx `sessionsFooter` —
  `showUpdateItem` requires `!isCapacitorMobileApp() && updateAvailable &&
  runtimeType in {desktop, web}`).
- Sheet is *permanently mounted* on phones (parked off-screen while closed) so
  sessions/worktree state stays warm and the drawer opens with data already on
  screen (`MobileSessionsDrawerContainer`). Tablet sidebar is also always mounted,
  animating width, content hidden by opacity when closed.

### B.6 Navigation gestures

`useEdgeSwipe` (src: .../apps/useEdgeSwipe.ts) — passive touchstart/touchend only
(never blocks chat scrolling or code-block horizontal scroll):

| Gesture | Zone | Action |
|---|---|---|
| left edge → rightward | 32 px (iOS), **80 px Android** (system back gesture overlap) | open sessions drawer / tablet sidebar |
| right edge → leftward (from chat) | same zone | open workspace drawer |
| left swipe from workspace drawer | mirrored (enabled only while open) | close workspace |
| right swipe from sessions drawer | mirrored | close sessions |

Commit rules: one finger; ≥ 64 px horizontal travel; `|dy| <= 0.7 * |dx|` (keeps it
horizontal); travel must head toward the screen center.

### B.7 Composer deltas (what mobile changes vs desktop)

The composer (05 owns its internals) gains a mobile **shell state machine**
(src: .../components/chat/composer/state/useMobileComposerShell.ts) plus keyboard
choreography classes. Implement each rule — these encode real platform bugs, do not
"simplify":

- States: collapsed **pill** (idle, keyboard down) ↔ expanded **full composer**.
- `expand()` runs `flushSync(setExpanded(true))` and then focuses the editor:
  - **native (Capacitor)**: focus on the next `requestAnimationFrame` with
    `{ preventScroll: true }` — WKWebView pauses frame presentation during the
    keyboard transition; focusing inside the first frame after commit makes the
    keyboard rise from the tap and the composer appear *during* the rise instead of
    a two-step. A native WebView raises the keyboard even for focus outside a
    gesture task.
  - **mobile browsers**: focus synchronously inside the tap with
    `{ preventScroll: false }` — browsers only open the soft keyboard for focus
    calls made synchronously from the gesture, and only their native scroll reveal
    positions the composer.
- Collapse triggers, in priority: (1) native keyboard-hide signal — the
  `oc:keyboard-intent {open:false}` event (C.5.3) fires BEFORE the shell layout
  restores so the pill swap lands in the SAME frame as the keyboard's hide,
  flushSync, making keyboard + composer a single measured motion, not a staircase;
  (2) 250 ms idle fallback once nothing holds the composer open (focus, dictation,
  any overlay panel/attach controller; an authoritative
  `editorRef.current.isFocused()` DOM check inside the timer protects against
  programmatic refocus races); (3) dictation end (30 ms grace for insert-then-focus).
- `alwaysExpanded` mode: while a hardware keyboard is attached there is no soft
  keyboard to buy space back from, so it stays expanded permanently and instead of
  collapsing between keystrokes. Live condition — a detached keyboard later
  re-enables normal collapse (no forced collapse).
- Root-class barriers published from this hook:
  - `oc-composer-expanded` (layout effect, SAME frame as the pill swap; keyed on
    keyboard state it vanished mid-rise as a visible second jump) — hides the
    draft-screen starter chips unless `oc-keep-draft-starters` is set (B.8.5).
  - `oc-browser-keyboard-open` (browser and PWA only): focused composer is the
    best keyboard proxy a browser has; CSS mirrors the native keyboard-open rules
    (draft starters hidden). On installed PWA, keyboard-close also schedules a
    scroll reset (0,0) after 350 ms because WebKit can leave the layout viewport
    panned with a dead strip at the bottom.
- Overlay handoff (`oc:mobile-overlay-opened/closed` DOM events from the shared
  `MobileOverlayPanel` portal root `#mobile-overlay-root`): while an overlay opens
  with the composer focused/blurred within 800 ms, mark "restore keyboard" and
  refocus the editor 180 ms after the last overlay closes; on an installed PWA the
  close event must be handled synchronously IN the closing click's flush (iOS
  refuses programmatic focus outside a user gesture — Safari in-browser is lenient,
  standalone is not), followed by two scroll-into-view reveals at +300/+650 ms
  aligning the form's BOTTOM with the visible edge, and a 600 ms focus-hold window
  where blurs are rejected right back (iOS may retract the rising keyboard as the
  closing tap settles).
- Blur handling: browser/PWA defers `setFocused(false)` by 120 ms (outlives the
  tap's synthesized click, which lands a few ms after the blur-induced reflow and
  would otherwise miss its target); Capacitor commits synchronously (flushSync)
  because the `oc:keyboard-intent` collapse arrives a few ms after blur via
  setTimeout(0) and React's scheduling can lose that race.

### B.8 Keyboard handling & the keyboard-mode setting

#### B.8.1 Native shell (Capacitor) — `resize: 'none'` + manual choreography

`capacitor.config.ts` pins the Keyboard plugin to `resize: 'none'` (and
`resizeOnFullScreen: true`, `autoBackdropColor: 'dom'`): the WebView keeps full
height and the **UI follows the keyboard itself**. The built-in `native` resize only
lands AFTER the keyboard animation finishes (~1.5 s visual lag). All variables set
by `useNativeMobileChrome` (C.5.3):

- `--oc-keyboard-inset` — keyboard target height from the moment `keyboardWillShow`
  fires; overlays animated against it.
- `--oc-kb-layout` — the same height applied to the shell's LAYOUT only at the
  invisible settle point (B.8.1 FLIP below).
- `--oc-kb-scroll-inset` — reserved strip inside the chat scroller, applied at the
  START of the rise and pinned immediately.

FLIP choreography (the shell height is never transitioned; animating `height`
reflows the whole shell every frame — the source of composer/chat micro-jitter):

- **show** (0.25 s, `cubic-bezier(0.38, 0.7, 0.125, 1)`): composer (and pinned
  chat/scroller per CSS) slide via inline transform (WebKit does not reliably
  transition transforms driven by CSS custom properties — inline styles are the
  contract); at the end the shell snaps `height: calc(100dvh - var(--oc-kb-layout))`
  and transforms return to 0 in the same frame. Also: measure the shell's current
  `padding-bottom` (the bottom safe inset it will give up) so
  `slide = keyboardHeight - safeBottom` is exactly the strip the scroller loses;
  the caret is hidden during the animation (`oc-kb-caret-hold` hides
  `caret-color` for textareas/inputs and `.cm-cursor`/`.cm-dropCursor` for the
  CodeMirror-based composer) because WKWebView draws the caret as a native layer
  that ignores CSS transforms and visibly "flies" across the screen.
- **hide** (0.2 s): shell snaps back immediately (still behind the keyboard),
  movers FLIP-offset to the raised position with transitions off, one forced
  offsetHeight flush, then they transition down. The earliest reliable hide
  trigger is `document`-level `focusout` from a text input (deferred one task so a
  synchronous refocus does not false-trigger); `keyboardWillHide` shares the same
  handler and is a no-op if already run.
- Events dispatched for consumers: `oc:keyboard-intent` (open bool),
  `oc:keyboard-anim` ({phase, slide, durationMs, easing}), `oc:keyboard-settled`
  (open bool). Consumers that re-pin: chat timeline scroller (one cheap scrollTop
  write), terminal view (TerminalView re-fits on settled), composer autocomplete
  max-height measure.
- iOS only: the WebKit form accessory bar (prev/next + Done) is disabled —
  `Keyboard.setAccessoryBarVisible({ isVisible: false })`.
- **Android**: `windowSoftInputMode="adjustResize"` (manifest) does it natively; the
  JS side only listens to events — `oc-keyboard-open` class for CSS and a
  deterministic re-pin on settled (the native resize alone leaves the auto-follow
  gate idle). No inset/transform choreography (dvh already shrinks).

Chrome (browser) keyboard handling is the *mode* below.

#### B.8.2 `mobileKeyboardMode` setting (hosted/PWA)

`MobileKeyboardMode = 'native' | 'resize-content'` (src:
packages/ui/src/lib/mobileKeyboardMode.ts; persisted in localStorage
`openchamber.mobileKeyboardMode`; device-local, never synced — 14 owns the setting
entry "Mobile keyboard behavior" under Settings → OpenChamber with options
"Follow browser" (native) and "Resize content" (resize-content); default
`resize-content`).

- `native`: viewport stays exactly the base string (browser default pan + viewport).
- `resize-content`: appends `, interactive-widget=resizes-content` to the viewport
  meta so supported Chromium browsers shrink the layout viewport when the keyboard
  opens (instead of only panning). `applyMobileKeyboardMode` rewrites the meta
  element content and sets `data-oc-mobile-keyboard-mode` on `<html>`.
- The desktop App applies it identically (src: packages/ui/src/App.tsx:295) — the
  mobile surface inherits the same user preference.

#### B.8.3 Hardware keyboard detection (src: packages/ui/src/lib/hardwareKeyboard.ts)

`useHardwareKeyboard()` — in-memory, module-level store. Two sources, native wins:

1. **Native (iOS)**: the shell stamps
   `window.__OPENCHAMBER_HARDWARE_KEYBOARD__` at document start from `GCKeyboard.coalesced`
   and keeps it live via `oc:hardware-keyboard` CustomEvents and an idempotent
   `startHardwareKeyboardBridge()` adoption (C.5.4). Known BEFORE any focus — the
   draft screen and composer start in the right shape.
2. **Inference (Android, browsers, hosted)**: `observeNativeKeyboardHeight(h)` from
   `keyboardWillShow` — a real height ≥ 120 px means soft keyboard; < 120 px means
   only the iOS shortcut strip (not a keyboard); `observeEditorFocus()` starts a
   600 ms probe — no keyboard event in the window ⇒ hardware keyboard. A soft
   keyboard already up (`oc-keyboard-open` class) suppresses the probe (refocus
   through it sends no second event).

Root class `oc-hardware-keyboard` toggles with the value; safe default is `false`
(phone behavior).

#### B.8.4 Keyboard viewport invariants (browser/PWA)

- 16 px inputs (zoom), dvh (not -webkit-fill-available) on dvh-capable Android.
- Fullscreen composer in mobile browsers: ChatInput pins the form to the
  visualViewport (class `oc-browser-kb-fullscreen`; the mobile header is hidden
  under it via CSS because the form cannot out-stack it). In installed PWA
  (standalone; offsetTop is 0) the composer instead pads its content down by
  `--oc-safe-area-top + 0.5rem` to clear the status bar / Dynamic Island, and the
  shell height pins to `100lvh` (iOS 26 standalone can leave `100dvh` stuck at the
  keyboard-shrunk value after hide; lvh is always full-screen and identical at load).
- Standalone composer padding-bottom gains
  `max(16px, env(safe-area-inset-bottom))` while the keyboard is down, cancelled
  while open (`:not(.oc-browser-keyboard-open)`), with a 220 ms transition so the
  delayed class flip (blur race) lands as a slide, not a dip.
- Body-portaled bottom sheets: `.keyboard-inset-surface { bottom:
  var(--oc-keyboard-inset) }` on native; their max-height subtracts the keyboard
  inset AND top safe area (`max-height: calc(100dvh - keyboard - max(0.75rem, top))`)
  because `100dvh` does NOT shrink in the Capacitor app — without the cap a sheet
  grows past the status bar. Full-screen scroll views outside the shell (e.g. the
  connect screen, `oc-keyboard-fill-screen`) shrink to
  `calc(100dvh - var(--oc-keyboard-inset))` with `min-height: 0` so their internal
  scroll can lift fields above the keyboard.

#### B.8.5 Draft starters

The draft (new-session) screen keeps its starter chips while the keyboard is up
only when there is room: `oc-keep-draft-starters` on the root when
`isTabletLayout && (isPortrait || hasHardwareKeyboard)` (src: MobileApp.tsx:244).
Landscape + soft keyboard still hides them.

### B.9 Terminal touch usage (src: packages/ui/src/components/terminal/TerminalViewport.tsx)

- The terminal lives in a `touch-none` container; a pointer-capture gesture state
  machine handles touch (`pointerType === 'touch'` only):
  - **pending → scrolling**: if movement ≥ 8 px, drag scrolls the buffer
    (`scrollLines`) with a line accumulator (`lineHeight = max(12, fontSize*1.35)`),
    `preventDefault()` on cancelable moves;
  - **pending → selecting**: a 350 ms long-press without movement calls
    `selectWordAt(x, y)`; further moves `extendSelectionTo`; a context menu
    (disabled on touch in favor of this) offers copy/paste; paste reads the system
    clipboard via the surface's `pasteFromClipboard` re-entrancy guard (lifetime
    counter invalidates stale pastes across sessions);
  - **tap**: commits focus. On Android the pointer-captured `touch-action:none`
    tap cannot raise the IME, so `Keyboard.show()` is invoked explicitly via the
    Capacitor keyboard plugin (no-op off Android).
- Teardown invariant: if a focused editable (terminal DOM holds IME focus) is
  removed mid-IME-composition, Android WebView input dispatch wedges — blur it
  first and `Keyboard.hide()` on Android before disposing.
- The PTY runs on the connected OpenChamber server over the shared authenticated
  transport; never a local shell on the phone. Closing the workspace surface
  detaches the renderer; the server session survives for reattachment
  (src: packages/mobile/README.md line 16).
- The mobile root mounts `useTerminalSessionKeepalive()` because `MainLayout`
  is absent; without it the server idle-reaps background PTYs (running project
  actions included) while the workspace drawer is closed (src: MobileApp.tsx:121).

### B.10 Workspace surfaces (read-only pointers; 05/06/07 own undersides)

Right-side tabs (persistent across open/close so tab state survives):
**Changes / Files / Terminal / Notes / MCP** (src: apps/MobileWorkspaceDrawer.tsx):
- **Changes**: top-level Changes / Branch / Commit / Pull Requests selector;
  checkout, sync, staging commit only under Changes; comparisons are a read-only
  file list opening one file diff at a time; shared source pickers are bottom
  sheets on phones and anchored popovers on tablets; commit lists the latest 50
  commits of the checked-out branch; PRs show the published GitHub diff (excluding
  local edits and unpushed commits) with search + explicit refresh; closing
  suspends comparison reads; changing repository/instance resets navigation; a new
  file link from chat opens the working-tree diff (src: packages/mobile/README.md:17).
- **Files**, **Terminal** (B.9), **Notes** (opens a plan as a fullscreen layer above
  the drawer; Android back steps back into the drawer), **MCP** (quick
  enable/disable toggles + add-server action row that opens Settings' MCP page
  pre-seeded with a draft).
- Opening from anywhere: `DedicatedMobileAppProvider` exposes shell actions
  (`openChanges({diffPath, animated?})`, `openFiles()`, `openSettings()`) consumed
  by deep-link navigation and chat file links (a chat link can jump straight into a
  Changes diff: `pendingChangesDiff` state, deliberately NOT cleared on close, so
  the pane's navigation survives close/reopen).
- The drawer slides in over 320 ms `cubic-bezier(0.22, 1, 0.36, 1)`; closes via
  header X, the mirrored edge swipe, Escape (unless the terminal tab owns keys), or
  Android back.

---

## C. Capacitor native shell (`packages/mobile`)

### C.1 Identity, runtime model, packet origin

| Item | Value | src |
|---|---|---|
| appId / bundle id / applicationId | `com.openchamber.app` | capacitor.config.ts |
| appName / display name | `OpenChamber` | capacitor.config.ts |
| webDir | `dist` (the renamed web build; `mobile.html` → `index.html`) | capacitor.config.ts |
| `androidScheme` | `https` (Android WebView origin = `https://localhost`) | capacitor.config.ts |
| `allowMixedContent` (Android) | `true` — the https-origin WebView must reach `http://192.168.x.x` LAN servers; cleartext allowed at manifest level too (C.4.1) | capacitor.config.ts |
| iOS scheme | Capacitor default `capacitor://localhost` (WKWebView) | — |
| versionCode/versionName | `1` / `"1.0"` default; CI env `OPENCHAMBER_ANDROID_VERSION_CODE/NAME` override | android/app/build.gradle |
| minSdk / compileSdk / targetSdk | 24 / 35 / 35 | android/variables.gradle |
| iOS deployment | App 15.5 (all Pods forced ≥ 15.5), WidgetKit ext 17.0, NSE 15.5 | Podfile, HANDOFF |

Server-side CORS: the packaged-client origin allowlist MUST include
`capacitor://localhost` (iOS) and `https://localhost` (Android scheme) — else every
WebSocket upgrade from the Android app 403s while SSE "works" (src:
packages/web/server/lib/security/request-security.js:9; packages/web/server/index.js:1678;
also `openchamber-ui://app` for the desktop shell).

### C.2 What the shell IS

A WKWebView / Android WebView loading a bundled copy of the web build (the
`MobileApp` renderer), native capabilities via Capacitor plugins + two iOS
extensions (src: packages/mobile/HANDOFF.md:9). The native app never embeds the
OpenChamber web server or the agent harness; it is always a *client* of an
existing OpenChamber server, reached directly (LAN/tunnel) or via the private
relay (08). First launch shows a connection screen; saved connections
are managed from the `Instances` footer entry (a persistent left sidebar on
tablets).

### C.3 Plugin matrix — exact list

From `packages/mobile/package.json` + `ios/App/Podfile` + `capacitor.config.ts`:

| Plugin (npm id) | Version | Purpose | Config / notes |
|---|---|---|---|
| `@capacitor/core` (+ `@capacitor/cli` dev, `@capacitor/ios`, `@capacitor/android`) | ^8.4.1 | shell, CapacitorHttp | `CapacitorHttp` used directly in connect flows (C.7.3) |
| `@capacitor/app` | ^8.0.0 | appStateChange / resume / backButton / appUrlOpen / getState / minimizeApp | see C.5, C.8 |
| `@capacitor/keyboard` | ^8.0.0 | keyboard events, accessory bar, show/hide | `resize:'none'`, `resizeOnFullScreen:true`, `autoBackdropColor:'dom'` |
| `@capacitor/status-bar` | ^8.0.0 | overlay/inslet + theme background | iOS overlay:true style DEFAULT; Android overlay:false + themed bg (C.5.1) |
| `@capacitor/push-notifications` | ^8.1.1 | APNs/FCM registration; tap events | `presentationOptions: []` (never a foreground APNs banner); brings `firebase-messaging` |
| `@aparajita/capacitor-secure-storage` | ^8.0.0 | Keychain/Keystore token store | called via NATIVE methods `internalGetItem/internalSetItem/internalRemoveItem` (C.7.6) |
| `@capacitor-mlkit/barcode-scanning` | ^8.1.0 | QR pairing scanner | Android uses CameraX-backed `startScan()` (bundled barcode model, no Google Play Services needed); iOS uses plugin `scan()`; CAMERA permission + `NSCameraUsageDescription` |
| `serve-sim` (devDependency) | ^0.1.45 | simulator browser stream + CLI controls | dev only (D.4) |

capacitor.config.ts plugin block (verbatim semantics):

```
Keyboard: { resize: 'none', resizeOnFullScreen: true, autoBackdropColor: 'dom' }
StatusBar: { overlaysWebView: true, style: 'DEFAULT' }
PushNotifications: { presentationOptions: [] }
```

`presentationOptions: []` contract: the server ALWAYS sends (no racy visibility
gate, see C.6.4); iOS suppresses the foreground banner because presentation is
empty; background pushes show normally. [HARNESS PORT]: if your shell is not
Capacitor, you must still honor "native foreground shows nothing" + "background
shows" for your OS notification surface.

### C.4 iOS / Android project specifics

#### C.4.1 Android (`android/app` + manifest, src: packages/mobile/android)

Manifest (`android/app/src/main/AndroidManifest.xml`):

- Application: `networkSecurityConfig=@xml/network_security_config`
  (base-config `cleartextTrafficPermitted="true"`, trust system **and user**
  anchors — plain-http LAN is a core feature), adaptive icon refs, RTL support,
  `AppTheme`/`AppTheme.NoActionBarLaunch` (splash).
- MainActivity: `configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation"`
  (folding/rotation RESIZES the WebView instead of recreating it — the tablet
  layout hook depends on this), `launchMode="singleTask"`,
  `windowSoftInputMode="adjustResize"`, MAIN/LAUNCHER intent filter, exported.
  NOTE: there is **no** `openchamber://` intent-filter in the manifest — deep links
  on Android arrive through push tap events (`PushNotifications` plugin) rather
  than custom-scheme opens; the scheme registry is iOS-first (C.8).
- `FileProvider` authority `${applicationId}.fileprovider` with `@xml/file_paths`
  (exported=false, grantUriPermissions).
- FCM default notification icon meta:
  `com.google.firebase.messaging.default_notification_icon = @drawable/ic_stat_notify`
  (monochrome silhouette for the status bar/shade).
- Permissions: `INTERNET`; `CAMERA` (+ `uses-feature camera required="false"`;
  without the uses-permission the runtime prompt never fires);
  `POST_NOTIFICATIONS` (Android 13+; runtime prompt issued by the push plugin on
  register; older versions allow by default); `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`
  (+ `uses-feature microphone required="false"`) for voice dictation — Capacitor's
  `BridgeWebChromeClient` forwards the WebView `AUDIO_CAPTURE` request to the
  Android prompt only when declared.
- Gradle: `google-services.json` is **committed** (Firebase project
  `openchamber-8bf7e`); the Google Services plugin is applied conditionally when
  the file exists (build.gradle try/catch). CI signing block reads
  `OPENCHAMBER_ANDROID_KEYSTORE_PATH/PASSWORD/KEY_ALIAS/KEY_PASSWORD`; release
  build signs only when all four exist, otherwise unsigned (debug scripts produce
  an unsigned debug APK at `android/app/build/outputs/apk/debug/app-debug.apk`).
- Adaptive launcher icon: full-bleed background color + `ic_launcher_foreground`;
  sources under `packages/mobile/assets/` (`icon-only.png`,
  `icon-foreground.png`, `icon-background.png`), regenerable with `@capacitor/assets`.

#### C.4.2 iOS (`ios/App`, src: packages/mobile/ios/App)

- `Info.plist`:
  - `NSAppTransportSecurity`: `NSAllowsArbitraryLoads=false`,
    `NSAllowsArbitraryLoadsInWebContent=true`, `NSAllowsLocalNetworking=true`
    (LAN http servers loadable from the web view; nothing else exempted).
  - Usage strings (verbatim intent): `NSLocalNetworkUsageDescription` "OpenChamber
    connects to OpenChamber servers on your local network."; `NSCameraUsageDescription`
    "OpenChamber uses the camera to scan a server's pairing QR code.";
    `NSMicrophoneUsageDescription` "OpenChamber uses the microphone for voice
    dictation in the chat composer."
  - `CFBundleURLTypes` scheme `openchamber` (role Editor, name
    `com.openchamber.app.deeplink`).
  - `ITSAppUsesNonExemptEncryption = false` (skips per-build export compliance).
  - Orientation: iPhone portrait + landscape left/right; iPad adds upside-down.
  - Scene manifest: single scene, `SceneDelegate` class, `LaunchScreen` storyboard,
    `UIViewControllerBasedStatusBarAppearance=true`.
- `AppDelegate.swift` + `BridgeViewController` (host of the WebView):
  - forwards APNs registration callbacks to Capacitor's
    `capacitorDidRegister(FailToRegister)` notifications (custom AppDelegate must
    repost them; the stock template does).
  - `apnsEnvironment` global: read from the embedded
    `embedded.mobileprovision` (isoLatin1 decode; regex
    `<key>aps-environment</key>\s*<string>development</string>`) → `"development"`
    else `"production"` (App Store builds carry no embedded profile → production).
  - `BridgeViewController.capacitorDidLoad()` — injects document-start user scripts:
    `window.__OPENCHAMBER_APNS_ENV__ = '<development|production>'` and
    `window.__OPENCHAMBER_HARDWARE_KEYBOARD__ = <bool from GCKeyboard.coalesced>`.
    Scripts MUST be added in `capacitorDidLoad`, NOT in
    `webViewConfiguration(for:)` — Capacitor's `prepareWebView` replaces the
    configuration's userContentController right after that call and silently
    discards anything added there; `capacitorDidLoad` runs after the swap but before the
    page load.
  - Hardware keyboard publish: re-publish at `viewDidAppear` and at +0.3/+1.0/+2.5 s
    (two races: GCKeyboard connected-before-page fires into a dead context, and
    GameController populates `coalesced` a beat after launch), plus on each
    foreground (`GCKeyboardDidConnect/DidDisconnect` notifications otherwise;
    recompute `coalesced != nil` on disconnect — a second keyboard may remain,
    Stage Manager/dock swaps); publishes via
    `evaluateJavaScript` setting the global + dispatching
    `oc:hardware-keyboard { attached }`.
- `SceneDelegate` (iOS 26 UIScene lifecycle host — Capacitor 7's template still
  uses legacy window setup; TN3187 forces scenes on the latest SDK):
  - builds the window from `Main` storyboard (root `CAPBridgeViewController`);
    forwards `openURLContexts`/`userActivity` (universal links) into
    `ApplicationDelegateProxy` so `App.appUrlOpen` still works.
  - `sceneDidBecomeActive`: re-assert WebView chrome; zero the app badge
    (`UNUserNotificationCenter.setBadgeCount(0)` on iOS 17+, else
    `applicationIconBadgeNumber=0`); refresh hardware keyboard state; write widget
    snapshot.
  - `sceneWillResignActive`: write widget snapshot (leave the freshest view).
  - `configureWebViewChrome`: `webView.isOpaque=false`, background clear (web
    layer paints its own themed canvas); on iOS 26 hides the Liquid-Glass scroll
    edge effects (`topEdgeEffect`/`bottomEdgeEffect` on `scrollView`) via KVC —
    they are `UIScrollEdgeEffect` objects, NOT views (`as? UIView` silently fails
    and leaves a dark band under the status bar in dark mode).
  - `writeWidgetSnapshot()` — evaluates
    `(typeof window.__OPENCHAMBER_WIDGET_SNAPSHOT__ === 'function') ? __OPENCHAMBER_WIDGET_SNAPSHOT__() : null`,
    stores the JSON string in shared
    `UserDefaults(suiteName: "group.com.openchamber.app")` under key
    `widgetSnapshot`, and calls `WidgetCenter.shared.reloadAllTimelines()` —
    SKIPPED when unchanged (identical JSON) to conserve the WidgetKit reload
    budget.
- Entitlements (all three targets — app, widget, NSE): App Group
  `group.com.openchamber.app`; the app additionally
  `aps-environment = development` (in-repo value; switch to `production` for
  TestFlight/App Store builds and match the server's APNs environment routing).
- Targets: `OpenChamberWidget` (WidgetKit, deployment 17.0) and
  `OpenChamberNotificationService` (Notification Service Extension, 15.5), both
  hand-wired into `App.xcodeproj/project.pbxproj` and embedded via a copy phase.
- Podfile: platform 15.5, `use_frameworks!`; plugin pods
  (Capacitor, CapacitorCordova, AparajitaCapacitorSecureStorage,
  CapacitorMlkitBarcodeScanning, CapacitorApp, CapacitorKeyboard,
  CapacitorPushNotifications, CapacitorStatusBar); post_install forces every pod
  target to deployment 15.5 (Xcode 16+/iOS 26 SDK rejects < 15; MLKit needs 15.5)
  and silences the quoted-include framework header warning (Capacitor Cordova
  compatibility headers).

### C.5 Native chrome — driven from the web layer

All hooks live in `src: packages/ui/src/apps/mobileNativeChrome.ts`. They no-op on
hosted web.

#### C.5.1 Status bar

- iOS: `StatusBar.overlaysWebView(true)` (content under the bar), style DEFAULT
  (content decides), `show()`. Re-assert on mount, once after 400 ms, and on every
  `appStateChange → active`: a custom UIScene lifecycle (iOS 26) plus returning
  from background silently drops overlay state and flashes an opaque bar.
- Android: `overlaysWebView(false)`, `setBackgroundColor(themeBg)` where
  `themeBg = splashBgDark/Light` (fallback #171515/#fffdf4), style mapped
  (Theme `Style.Dark` = light text for a dark background; `Style.Light` = dark
  text), show(). A `MutationObserver` on the `<html>` `dark` class re-applies on
  theme flips without an app restart. On Android 15+ edge-to-edge both overlay
  calls are no-ops — the app pads itself from Capacitor-injected `--safe-area-inset-*`
  vars (B.2, C.5.2).
- Root marker classes: `oc-capacitor-app` (keyboard-inset CSS applies only here,
  not in the browser-hosted PWA) and `oc-platform-android` (platform branch).

#### C.5.2 Safe areas (Android native)

`src: packages/ui/src/styles/mobile.css:458-497`. Every `--oc-safe-area-*`
definition in the iOS/PWA blocks is gated behind `-webkit-touch-callout` or
`display-mode: standalone`, neither of which matches the Android Capacitor
WebView. The Android block therefore reads Capacitor-injected inline vars first:
`--oc-safe-area-top: var(--safe-area-inset-top, env(safe-area-inset-top, 0px))`
(and right/bottom/left), `--oc-app-bottom-safe: max(16px, var(--oc-safe-area-bottom))`
(Android 15 edge-to-edge: the app draws under the navigation bar and opt-in
`.oc-bottom-safe-surface` pads). Capacitor reports a zero bottom inset while the
keyboard is up, so keyboard inset and safe inset never stack.

#### C.5.3 Keyboard (implemented per B.8.1; source: mobileNativeChrome.ts:105-357)

Recap of the exact contract every re-implementation must reproduce:
`resize:'none'`; `keyboardWillShow` carries the final height and starts a 250 ms
inline-transform FLIP with one invisible settle (`--oc-kb-layout`); hide is 200 ms,
triggered by focusout (early, in-page) OR `keyboardWillHide` (shared, idempotent);
`--oc-kb-scroll-inset` reserves the chat strip immediately; caret is hidden during
the animation; `oc:keyboard-intent/anim/settled` events choreograph consumer
re-pins; accessory bar off on iOS; Android only receives signal events
(`oc-keyboard-open`, settled re-pin) because `adjustResize` + dvh already shrink.

#### C.5.4 Hardware keyboard bridge

Implemented per C.4.2 (iOS side) + B.8.3 (JS side). Android has no equivalent
native session — it infers per B.8.3 source 2 (keyboardWillShow height from the
Capacitor keyboard reader, editor-focus probe).

#### C.5.5 Lifecycle, resume, back button

`useNativeMobileLifecycle(onResume)`:
- resume detection is belt-and-suspenders: `App.appStateChange` (isActive),
  document `visibilitychange` (hidden ⇒ latch; visible ⇒ fire), and
  `App.addListener('resume')`. Exactly one `onResume()` per background→foreground
  (a `wasInactive` latch). iOS appStateChange can be missed after a long suspend —
  hence the duplicate triggers.
- Sets root class `oc-native-app-active` while active.

`useNativeAndroidBackButton(onBack: () => boolean)`:
- `App.addListener('backButton')`; if `onBack()` returns true the app consumed it; otherwise
  `App.minimizeApp()`. `MobileShell` implements the layer ladder exactly per B.4:
  plan → settings drill-down (Settings registers a back handler via
  `registerBackHandler`; it steps nav→page list→item before the surface closes) →
  active surface → workspace → sessions sheet → minimize.

### C.6 Push notifications (device side; delivery ownership → 03)

#### C.6.1 Registration flow

1. Gateway: `useNativePushRegistration({ enabled: isNativeMobileApp && isConnected })`
   (src: apps/useNativePushRegistration.ts) — additionally gated on the
   `nativeNotificationsEnabled` user setting (14 owns the toggle; default on).
2. `checkPermissions()` → if not granted `requestPermissions()` (Android 13+
    POST_NOTIFICATIONS runtime prompt happens here) — give up silently if denied.
3. `PushNotifications.register()`; listeners on `registration` (token.value) and
   `registrationError` (console warn).
4. On token: send to the connected server via
   `apis.push.registerApnsToken({ token, platform: getClientPlatform() /* ios|android */,
   environment: getApnsEnvironment() })`. [HARNESS PORT] your `PushAPI` must accept
   exactly this payload; `environment` values `'sandbox'|'production'` only.
5. iOS environment mapping: `window.__OPENCHAMBER_APNS_ENV__` =
   `'development' → 'sandbox'`, `'production' → 'production'`, absent (Android or
   older shell) → undefined (server defaults production). Read from the embedded
   provisioning profile per C.4.2 — Xcode/dev-signed installs register sandbox
   tokens, TestFlight/App Store register production ones.
6. Turning the setting OFF calls `apis.push.unregisterApnsToken({ token })` with the
   last registered token (separate effect; a transient disconnect never
   unregisters). Token re-registration happens whenever the connection (active
   server endpoint) changes because the effect is gated on `isConnected`.

#### C.6.2 Server → relay handoff (from APNS.md; full delivery rules → 03/08)

- Server persists the token with its UI session (`POST /api/push/apns-token`,
  `DELETE /api/push/apns-token`), binds it on the central relay signed with the
  server's auto-generated ECDSA P-256 key; the relay routes each token to APNs
  (iOS) or FCM (Android) by its stored platform tag.
- Payload is deliberately content-free: fixed scenario title ("Agent response is
  ready" / "needs your input" / "needs permission" / "hit an error") + session
  name as body, plus an absolute `aps.badge` = number of distinct collapse tags
  pushed since the app last foregrounded. Cleared by: visibility beacon
  `visible:true`, opening a session, and sending a message (server endpoints reset
  it; also mirrors the device clearing its own badge on activate).
- Push carries `data: { sessionId, url? }` for tap deep links (C.8.2) and the NSE
  reads `aps.badge`/`sessionId`/`runtimeKey` (C.9.5).

#### C.6.3 Privacy/state invariants

- Native app ⇒ local notification APIs are no-ops (B.1.3 step 6). There is exactly
  one channel; permission UX = the OS prompt only, surfaced through register.
- Foreground suppression is suppress on the CLIENT (iOS presentationOptions) — the
  server does not gate APNs on visibility because a suspended WKWebView cannot
  reliably report hidden. Web-push visibility gating is a server feature (03).

#### C.6.4 Presence-aware suppression (visibility beacon)

`usePushVisibilityBeacon({ enabled: true })` (src: hooks/usePushVisibilityBeacon.ts),
heartbeat every 20 s via `apis.push.setVisibility({ visible, platform })`:

- **Native (Capacitor)**: visibility is driven AUTHORITATIVELY from
  `App.appStateChange` (+ initial `App.getState()`), NOT from
  `document.visibilityState/hasFocus()` — a WKWebView reports `hasFocus()==false`
  while foregrounded, which leaked pushes. Initial state sent on mount.
- **Web/desktop**: `visibilitychange`/`pagehide`/`pageshow`/`focus`/`blur`;
  `visible = visibilityState === 'visible' && document.hasFocus()`; periodic
  heartbeat only reports positive (never forces false), pagehide reports false.
- Server rule (03): a mobile push is skipped while ANY interactive client
  (desktop/web/vscode — platform !== ios/android) is freshly visible; gated on the
  desktop's visibility, never the phone's own (push-runtime.js:283).

### C.7 Connect flows (device side; pairing/relay protocol → 08)

src: packages/ui/src/apps/mobileConnections.ts (1740 lines), MobileConnectionWelcome.tsx,
MobileQrScannerOverlay.tsx, mobileQrScan.ts, mobileConnectionUi.ts.

#### C.7.1 Data model

```
MobileTransportCandidate = { kind:'direct', url } | { kind:'relay',
  relay: { relayUrl, serverId, hostEncPubJwk } }
MobileSavedConnection = { id, label, candidates: ordered set (index 0 first),
  lastUsedAt, hasToken? (native) | clientToken? (web only) }
```

- Metadata in localStorage key `openchamber.mobile.connections.v1`, max 12
  entries, sorted most-recent-first. Native records NEVER contain the token —
  only `hasToken` (wide invariant: token writes awaited BEFORE endpoint switch).
- Relay descriptor = { relayUrl (ws/s), serverId, hostEncPubJwk (EC P-256 public
  JWK, kty/crv/x/y only) } — the E2EE trust anchor (08).
- Ordering rule for a saved device: direct candidates first (https before http),
  relay last (fallback). One token per device works over all transports.
- Device identity: `openchamber.mobile.deviceId` (localStorage UUID, fallback
  ephemeral) → server dedupe key `mobile:<id>`; pairing OR password re-login reuse
  one device record (`dedupeKey`).
- Runtime key: `relay:<serverId>@<relayUrl>` for relay transport, else the
  normalized direct URL. The SAME key is passed for all of one device's
  transports, so LAN⇄relay is a *transport-only* switch (no remount; session,
  pagination and view preserved via the rebind path in 04 + MobileApp
  `runtimeEndpointEpoch` check) while a different key = full instance reset.

#### C.7.2 Secure token storage (native)

`@aparajita/capacitor-secure-storage` — but ONLY its native methods
(`internalSetItem/internalGetItem/internalRemoveItem`, fields
`{prefixedKey, data, sync, access}` / `{prefixedKey, sync}`), called by hand:
the plugin's high-level JS methods lazy-load a platform JS module that stalls in
this WebView (src: mobileConnections.ts:631-660 comments). Key = prefixed
`openchamber.mobile.token.<encodeURIComponent(storageKey)>` where storageKey is
the relay identity (preferred, stable across DHCP changes) or the normalized
direct URL. Keychain access = whenUnlocked (0). Every call bounded to 3 s; a
hung Keychain must never block the connect flow. Legacy records carrying an
inline token are migrated (write to secure store, verify by re-read, strip from
metadata; report migrated/failed counts).

#### C.7.3 Request layer (native http first)

`requestWithTimeout(url, init, { totalTimeoutMs })`:
1. race `CapacitorHttp.request` (from `@capacitor/core`) with a
   `MOBILE_NATIVE_HTTP_TIMEOUT_MS = 2500` cap — needed to reach plain-http LAN
   servers that the secure webview's fetch may not reach;
2. else browser `fetch` with the remaining budget of
   `MOBILE_CONNECT_TIMEOUT_MS = 8000`.
Fast-mode (`fast: true`) probes use `MOBILE_FAST_PROBE_TIMEOUT_MS = 2500` total.
All connect logs go to `console` AND a debug ring buffer (`[mobile-connect]`/
`[mobile-storage]` prefixes) surfaced by a hidden panel (long-press the welcome
logo or a connection row; MobileConnectionDebugPanel).

#### C.7.4 Candidate probing (`probeConnectionCandidates`)

Order + rules (all timeouts above):
1. Direct chain in order: `/health` GET (unauthenticated — NEVER send the bearer
   token to an unchecked address) → **identity gate**: if the device has a relay
   pairing, `/health`'s `serverId` must match the expected one (re-assigned LAN
   address may now belong to a different machine; older servers without serverId
   pass unless mismatch); then `/auth/session` with the token —
   `credentials: token ? 'omit' : 'include'`, bearer-only (a leftover valid
   `oc_ui_session` cookie would else answer "authenticated" for a revoked token).
   401 (or `authenticated:false`, `disabled !== true`) ⇒ **needs-login** (applies
   to every transport — same shared token). Tokenless native flow additionally
   requires cookie scope `'client'` (a cookie-only session can't drive the
   native runtime transport) ⇒ needs-login ⇐ mint a token.
2. Relay probe: open the E2EE tunnel (08: `createRelayTunnelClient({relayUrl,
   serverId, hostEncPubJwk})`), fetch `/auth/session` THROUGH it (15 s default,
   full-connect budget 8 s when racing, fast 2.5 s). No `/health` needed — the
   E2EE handshake already proves host identity; `/auth/session` proves
   liveness + token in one request. With `keepTunnel` an ok probe RETURNS the
   open tunnel which the caller adopts as the runtime tunnel (skips a second
   connect + handshake). `401`/not-ok ⇒ needs-login.
3. **Race**: if a device carries both direct and relay candidates, direct probes
   run first and keep priority via a `RELAY_RACE_HEADSTART_MS = 1500` head start
   on the relay probe; first ok/needs-login verdict wins; the loser's work is
   discarded (unused relay tunnels closed). Every-direct-unreachable hands over
   immediately to an already-started relay probe.

#### C.7.5 The three user-facing flows (welcome screen + Instances sheet share one controller)

1. **Scan QR (primary)**: `scanConnectionQr` requests camera permission via the
   plugin; Android uses the CameraX-backed `startScan()` + `barcodesScanned`
   listener (bundled model; no Play Services; QR_CODE only) with a
   pairingStringFallback parse (old WebViews mangle non-special URL schemes —
   `new URL('openchamber://…')` yields host ""/pathname "//connect", so a string
   parser exists); iOS uses plugin `scan()`. Abortable (stopScan + listener
   removal on unmount/cancel). Payload parse:
   - new-format pairing `openchamber://connect?{v=2,p=base64url(pairingPayload)}`
     → `{ pairing }` (validate: v=2, ≤16 KiB, candidates normalize, secret, not
     expired) → `redeemPairingConnection`.
   - Legacy direct-token QR (`https?://…` or a payload with url+clientToken) →
     prefill manual form → connect.
   Payload shape (for review; issuance → 08):
   `{ v:2, pairingId, secret, label?, fingerprint?, expiresAt?, candidates: [
     { type:'lan'|'tunnel', url, priority? } | { type:'relay', relayUrl, serverId,
       hostEncPubJwk, grant?, priority? } ] }` (src: packages/ui/src/lib/connectionPayload.ts).
2. **Manual**: server URL + optional label + optional client token ( autocorrect
   off via `mobileInputKeyboardProps` — keyboards mangle URLs; 16 px inputs). A
   pasted `openchamber://connect?...` in the URL field is treated as a pairing
   link. Connect interns the URL → candidates, probes, and on needs-login drops
   into the password unlock form (metadata persisted first so a failed unlock
   keeps the entry).
3. **Saved connections list**: each row = icon + label + display URL (first
   direct candidate; `relay://<serverId>` pseudo-URL for relay-only devices) with
   per-row spinner; tap reconnects.

**Pairing redeem steps** (fingerprint of the client half; protocol → 08):
establish the first reachable live transport across all candidates (health gate +
identity gate again) → POST `/api/client-auth/pairing/redeem` with
`{ pairingId, secret, clientLabel:'OpenChamber Mobile', clientKind:'mobile',
deviceName:'OpenChamber Mobile', devicePlatform, dedupeKey }` (single-use secret —
other candidates are NOT retried once redeem runs) → response `clientToken`
issued → write secure token (native; error authRequired if Keychain write fails)
→ persist metadata with ALL candidates → `switchToTransport` (a relay tunnel from
the redeem step is adopted as the runtime tunnel, not closed) → onConnected.

**Password unlock steps** (password-protected servers; auto-shown when a probe
answers needs-login): establish live transport → POST `/auth/session`
`{ password, trustDevice: true, issueClientToken: true, clientLabel:'OpenChamber
Mobile', clientKind:'mobile', devicePlatform, dedupeKey }` (relay login rides the
tunnel; cookies never cross it so the issued token is mandatory there) → require
issued `clientToken` UNLESS (direct ∧ non-native) where a cookie-only success may
proceed → persist token (native, awaited) → switch → onConnected. Password
operations carry an operation tracker (begin/cancel/isCurrent) so a cancelled
unlock never races a superseding connect (every await re-checks).

**Transport switch**: direct → `switchRuntimeEndpoint({apiBaseUrl: url,
clientToken, runtimeKey})`; relay → `apiBaseUrl = window.location.origin`
(runtimeFetch routes runtime paths through the live E2EE tunnel — there is no
network base URL), descriptor passed, tunnel adopted. Any successful switch
triggers `scheduleCandidateRefresh` (background-only, 5 s after bootstrap):
GET `/api/client-auth/connection/candidates` through the ACTIVE transport, must
echo the connection's serverId; fresh `lan` URLs REPLACE old http candidates;
https (tunnel-class) candidates and the relay candidate are preserved; an empty
answer is ignored (never delete on a possibly-transient empty response); then, if
currently on relay, one more reprobe opportunistically hot-switches back to LAN.

#### C.7.6 Saved-connection editing invariants

- EDIT must never silently drop transports the form doesn't show: typed URL
  replaces the http:// (LAN-class) directs only; https:// directs and the relay
  candidate are always preserved (dropping the relay changes the Keychain token
  key and orphans the token).
- A token key change without a new typed token MIGRATES the stored token to the
  new key instead of leaving it stranded (move + verify); delete removes the
  stored token too. [Declared gap → 08: canonical secure-storage naming; the
  scheme here is app-owned (`openchamber.mobile.token.<key>`)].

### C.8 Deep links

#### C.8.1 Vocabulary (src: packages/ui/src/apps/deepLinks.ts — pure, no React/Capacitor)

| Intent | URL | Applied to |
|---|---|---|
| session | `openchamber://session/<id>?dir=<dir>` | `sessionUIStore.setCurrentSession` directly (works pre-shell) |
| new-session | `openchamber://new` or `openchamber://new-session?dir=&project=&agent=&model=` | opens draft + target preselect (direct store) |
| sessions | `openchamber://sessions?filter=all|attention|recent` | shell handler (open sessions drawer/sidebar) |
| status | `openchamber://status` | routed to sessions drawer (legacy status panel removed) |
| settings | `openchamber://settings[/<section>]` | shell handler (settings fullscreen/dialog, optional section) |
| changes | `openchamber://changes[/<path>?staged=true]` | shell handler (workspace Changes) |
| view | `openchamber://view/files|mcp|instances|update` (bare `view/changes` → changes intent) | shell handler |

Parse is tolerant: unknown routes → null (no throw); host-or-path segment
handling; query fallbacks (`?id=`). iOS widgets encode the same URLs
(WidgetDeepLink mirrors this file, src: OpenChamberWidget/WidgetShared.swift:44).

#### C.8.2 Sources and the stash

`useDeepLinkSource({ ready: isNativeMobileApp && isConnected && isInitialized })`
(src: apps/deepLinkNavigation.ts):
- `App.addListener('appUrlOpen')` — custom scheme/external links (widgets, Live
  Activities, external apps). iOS key paths: AppDelegate/SceneDelegate forward URL
  contexts into Capacitor's ApplicationDelegateProxy.
- `PushNotifications.addListener('pushNotificationActionPerformed')` — notification
  taps: prefer `data.url` / `data.deeplink`; fall back to bare `data.sessionId`
  (forwards compatibility with older senders).
- BOTH listeners register unconditionally from app boot (a cold-launch tap/open
  must not be lost on the connect/splash screen). Module-level stash holds the
  NEWEST pending intent ("newest wins"), flushed when `ready` flips true and re-
  flushed when shell handlers register; if a handler for the intent type isn't
  registered yet the intent is re-stashed. Shell handlers come from
  `useDeepLinkHandlers` in MobileShell (B.4 layer openers). Session/new-session
  intents never need a handler (they drive the session store directly).

### C.9 iOS widgets, Control Center, and the notification service extension

(src: packages/mobile/ios/App/OpenChamberWidget/*.swift, OpenChamberNotificationService/*)

- **Snapshot pipeline** (single source of truth): web store snapshot (B.1.3 hook)
  `buildMobileWidgetSnapshot()` returns
  `{ runtimeKey, attentionCount, recentSessions[≤6: {id,title,unread,project}] }`;
  `needsAttention = unseenCount > 0 && (!isSubtask || notifyOnSubtasks)` — mirrors
  the sidebar's unread dot. The native shell serializes it on scene
  activate/resign into the App Group `UserDefaults(suiteName:
  group.com.openchamber.app)` key `widgetSnapshot`, then reloads timelines only
  when the JSON changed.
- **Widgets**: a medium home-screen widget (recent sessions list with
  filled-orange/hollow-ring unread dots + a 2×2 quick-action grid:
  new session / status / instances / settings, each a `Link` with a deep link)
  plus lock-screen accessory and an iOS 18-style Control Center control (capabilities
  per HANDOFF; all read the shared snapshot; timeline provider also requests a
  periodic self-refresh so uneven reload budgets converge).
- **NSE** (`OpenChamberNotificationService`): runs on every push with
  `mutable-content: 1` (server/relay sets it, 03) even when the app is closed.
  It makes NO network calls: reads `aps.badge` (authoritative attention count),
  flips the pushed session's row unread in the snapshot, corrects/clears the
  snapshot when the push's `runtimeKey` differs from the stored one, rewrites the
  App Group snapshot, reloads widget timelines, and delivers the notification
  unchanged.

### C.10 Harness ports (shared-UI contract deltas)

The mobile renderer consumes the SAME `RuntimeAPIs` as every other surface (01
owns the full interface) — no mobile-specific API namespace exists. Deltas:

| Port | Consumers | Contract notes |
|---|---|---|
| `apis.push.setVisibility({visible, platform})` | both copies | heartbeat 20 s; platform tags the surface |
| `apis.push.register/unregisterApnsToken({token, platform, environment})` | native only | `platform` `'ios'|'android'`; environment `sandbox|production` |
| `apis.notifications` | native replaces with no-ops at boot | hosted keeps 01 behavior |
| `window.__OPENCHAMBER_RUNTIME_APIS__` | mobile-main entry | created by `createConfiguredWebAPIs()` (web runtime; harness must substitute its factory, 01/02) |
| `window.__OPENCHAMBER_APNS_ENV__` | iOS shell injects | consumed by push registration |
| `window.__OPENCHAMBER_HARDWARE_KEYBOARD__` + `oc:hardware-keyboard` | iOS shell injects | consumed by keyboard detection |
| `window.__OPENCHAMBER_WIDGET_SNAPSHOT__()` | iOS shell invokes | returns JSON string or null |
| `window.__OPENCHAMBER_SURFACE__` | renderer stamps `'mobile'` | must be set before any isMobileSurfaceRuntime consumer |
| relay descriptor `hostEncPubJwk`/`serverId`/`relayUrl` | connect flow | E2EE tunnel client — 08 owns semantics; mobile only stores + opens it |

Server endpoints consumed by the mobile app (all standard OpenChamber server —
03 owns): `/health` (with `serverId`), `/auth/session` (GET/POST unlock,
`clientToken` issuance), `/api/client-auth/pairing/redeem`,
`/api/client-auth/connection/candidates`, `/api/push/apns-token` (POST/DELETE),
`/api/push/visibility` (POST/GET), plus every shared runtime route via
`runtimeFetch` (SSE-locked transport in the shell — see C.11 quirk 3).

---

## D. Dev / build pipeline

### D.1 Build chain (src: packages/mobile/HANDOFF.md Build pipeline; package.json scripts)

```
bun run --cwd packages/web build            # web/dist built (index, mobile, mini-chat entries)
    → scripts/prepare-web-assets.mjs          # rm -rf mobile/dist; cp web/dist → mobile/dist;
                                            #   mobile.html → index.html (rename for boot entry)
    → cap sync                              # copy dist → ios/android + regenerate plugin config + pods
      → xcodebuild (ios) / gradle assembleDebug (android)
```

`sync` runs through `scripts/with-mobile-env.mjs` (D.2). The root workspace build
uses `build:assets` (prepare only) so it doesn't rebuild web.

Native-facing helper scripts (all wrapped):

| Script | Wraps | Effect |
|---|---|---|
| `scripts/with-mobile-env.mjs <cmd>` | every build/deploy command | env contract D.2; shells out with `shell:true`, inherits stdio |
| `scripts/ios-sim-build.mjs` | `build:ios:simulator` | web build + `cap copy ios` (no pod regen) → STRIP the `CapacitorMlkitBarcodeScanning` pod line from Podfile → `pod install` → `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build` → FINALLY restore Podfile + `pod install`. Reason: GoogleMLKit has no arm64-simulator slice; the scanner needs a camera the simulator lacks, so dropping it for simulator builds loses nothing (the JS side degrades cleanly: `getScannerPlugin() → null → isQrScanSupported() false`) |
| `scripts/ios-sim.mjs boot|install|launch|run` | `sim:*` | `xcrun simctl`: default device `iPhone 17 Pro`; app path resolved from `xcodebuild -showBuildSettings` `TARGET_BUILD_DIR` → `App.app`; `run` = install + launch (bundle id `com.openchamber.app`) |
| `scripts/ios-sim-dev.mjs [--no-build]` | `sim:dev` | build (unless skipped) → `ios-sim.mjs run` → `serve-sim --detach -q` (JSON {url}) → prints the preview URL and stays foreground; Ctrl+C kills the stream |
| `scripts/android-device.mjs devices|install|launch|run|logcat` | `android:*` (not aliased at root) | adb devices (list `device` state, not `unauthorized`); `install -r` of `android/app/build/outputs/apk/debug/app-debug.apk`; `am start -n com.openchamber.app/.MainActivity`; logcat bound by pid (or Capacitor/Chromium tags) |
| `prepare-web-assets.mjs` | `build:assets` | see chain above |

### D.2 Toolchain env contract (`with-mobile-env.mjs`)

- `DEVELOPER_DIR` = `$DEVELOPER_DIR` → `xcode-select -p` output → `/Applications/Xcode.app/...`.
  Honoring `xcode-select` is deliberate (beta/alternate Xcode; hardcoding forced
  builds onto the wrong SDK).
- `JAVA_HOME` = `$JAVA_HOME` → `/opt/homebrew/opt/openjdk@21` (JDK 21 required —
  gradle fails with "source release: 21" otherwise).
- `ANDROID_HOME`/`ANDROID_SDK_ROOT` = env → `/opt/homebrew/share/android-commandlinetools`
  (needs platform-tools, platforms;android-35, build-tools;35.0.0 + licenses).
- `PATH` gets `$JAVA_HOME/bin` and `$ANDROID_HOME/platform-tools` prepended (adb).
On another machine: override env; never edit the script.

### D.3 Commands (package-level + root aliases)

From `packages/mobile` (or `mobile:*` aliases): build, build:assets, sync,
build:android:debug, build:ios:simulator, sim:boot/install/launch/run/dev/serve/list/kill,
open:ios, open:android, android:devices/install/launch/run/logcat, type-check,
lint. Validation set: `bun run type-check:mobile`, `bun run lint:mobile`,
`bun run mobile:build:android:debug`, `bun run mobile:build:ios:simulator`.
Web-inherited warnings (KaTeX font URLs, onnxruntime-web eval, chunk-size) are
expected and non-fatal.

### D.4 serve-sim dev loop (src: .agents/skills/serve-sim/SKILL.md)

`serve-sim` streams the booted simulator's framebuffer to a browser preview and
exposes CLI controls. Scripted flow (observability boundaries per step):
`mobile:build:ios:simulator` → `mobile:sim:run` (boot/install/launch) →
`mobile:sim:serve` (detached, JSON `url` is the ONLY authoritative stream
address) → `mobile:sim:kill` when done. Manual controls:
`bunx serve-sim tap <nx> <ny>` (normalized 0..1 — prefer tap; separate
gesture begin/end can register as long-press), `type "<text>"`,
`button home`, `rotate portrait`, `--list -q`; accessibility tree at
`http://localhost:3100/ax`. Preconditions: macOS host, Xcode (set
`DEVELOPER_DIR` if xcode-select points at CommandLineTools), Node 18+, a
bootable simulator. Run CLI commands from `packages/mobile` (binary in its
node_modules). Known quirk: if the browser preview UI stays stale while the
app visibly changes, check the raw MJPEG stream before assuming the simulator
died.

### D.5 Vite / assets

- The web build emits three entries; the mobile copy is bundles-only (no server
  assets). `mobile.html`'s only server-integrated piece is the same-origin
  `/src/mobile-main.tsx` module; in the native bundle it load from `dist/` over
  the shell's local scheme.
- Chunking: Vite preload helpers pinned to `vendor-vite-runtime`; shiki langs/
  themes and CodeMirror legacy modes stay per-module dynamic chunks (a single
  vendor chunk would drag ~7.4 MB of grammars into the eager graph) (src:
  packages/web/vite.config.ts:140-180).

---

## E. Release considerations (as documented in-repo)

src: packages/mobile/HANDOFF.md (The gap: CI/release automation; Store review readiness), mobile/README.md (Generated Assets).

- **Identity**: App Store/Play name `OpenChamber`; ids `com.openchamber.app`,
  `com.openchamber.app.OpenChamberWidget`, `com.openchamber.app.OpenChamberNotificationService`.
- **Icons/splash**: still Capacitor-generated in both platforms (Android adaptive
  sources under `packages/mobile/assets/`; regenerable via `@capacitor/assets`).
  Replace before any release branding work (explicit in-repo note).
- **Done in-repo**: iOS Privacy Manifest (`PrivacyInfo.xcprivacy` — declares no
  tracking + required-reason UserDefaults API for the App Group snapshot);
  `ITSAppUsesNonExemptEncryption=false`; camera/mic/local-network usage strings;
  Android SDK levels meet Play's current requirement (target/compile 35, min 24).
- **Release-time to-do (console/infra, not code)**: privacy policy URL (both
  stores); iOS App Privacy nutrition label + Android Data Safety form (collected
  data: device push token — otherwise the app talks only to the user's own
  server); production APNs for App Store builds (aps-environment `production` +
  relay sends to production rather than sandbox); demo instance + credentials for
  reviewers (App Store 2.1 / Play); Guideline 4.2 appeal — cite native features
  (push, widgets, Control Center, QR pairing) in review notes.
- **CI gaps (next work per HANDOFF)**: Apple Developer app IDs (3) enabled for
  App Group + Push; certificates/profiles for all three targets; App Store
  Connect API key for testflight upload (`xcodebuild archive` + notarytool or
  fastlane gym/pilot); macOS runner honoring the D.2 env contract. Android:
  release keystore as CI secret + signed AAB (`bundleRelease`); Play Console
  internal track + service-account upload (fastlane supply or Play Developer
  API); Linux runner with Android SDK + openjdk 21. `google-services.json`
  committed so FCM builds in CI without extra setup. Relay/push secrets (APNs
  key, FCM service account) live in relay infrastructure, NOT app CI. Version
  and build-number bumping is not automated yet.

---

## F. States catalog (mobile app lifecycle + hosted recovery)

`MobileApp` render-order state machine (src: apps/MobileApp.tsx:1197-1336):

| # | State | Trigger / condition | UI |
|---|---|---|---|
| S0 | Font splash | shared-prefs chain not resolved (`useFontsReady` false) | centered animated logo, full screen |
| S1 | Cold-launch auto-connect splash | native; no runtime endpoint; `autoConnectPhase 'pending'|'attempting'` | logo + "Connecting to <label>" with busy dots below (absolutely positioned so the logo stays centered) |
| S2 | Native connect screen | `autoConnectPhase 'done'` AND (no endpoint OR not connected) | `MobileConnectionWelcome`: notice banner (why auto-connect failed: unreachable / auth-expired w/ server label), Scan QR (primary), saved connections list, collapsible manual form, password unlock form when pending |
| S3 | Native reconnect loader | endpoint set but bootstrap not finished (`isConnected` false) | logo (static when `showConnectionRecovery`) |
| S4 | Native recovery error | S3 persists > 4 s AND server unreachable/auth problem | title + native copy of network description + "Cancel" button returning to S2 (drops endpoint) |
| S5 | Hosted boot splash | browser; not connected AND recovery timer pending | logo only (avoids flashing unreachable during the first beat) |
| S6 | Hosted recovery error | browser; > 8 s not connected | `sessionAuth.error.networkTitle/Description` (shared copy) |
| S7 | App (SyncProvider + RuntimeAPIProvider + TooltipProvider) | connected OR `connectionPhase 'reconnecting'` (never blank the shell on a transient drop) | full shell; a fixed logo overlay covers it while the last-session restore is pending (bounded 6 s) |
| S8 | Reconnecting | `!isConnected && connectionPhase === 'reconnecting'` | S7 stays mounted; sync engine (04) handles retry UI |
| S9 | Transport-only switch | endpoint-changed with SAME runtimeKey | no remount: `reconnectAppForTransportSwitch()` re-binds sync; latency invisible by design |
| S10 | Instance switch / disconnect | different runtimeKey | full store reset + bootstrap (`resetAppForRuntimeEndpointChange`, epoch bumps remount SyncProvider); deleting the ACTIVE connection transitions to S2 |

- **Offline/native**, background→foreground: `useNativeMobileLifecycle(onResume)`
  fires the re-probe ladder (C.7 resumed); verdicts → keep-and-refresh (S7),
  hot-switch (S9), or disconnect-to-connect-screen (S2 with notice); retry
  ladder 4 s/10 s before declaring dead; `online` events run the same probe
  debounced 1.5 s (Android Wi-Fi switch does NOT background the app).
- **Cold launch with persisted endpoint**: don't trust a stale persisted
  `isConnected: true`; classify with a fast re-probe FIRST; drop to S2 with a
  labeled notice on unreachable/needs-login; background-retry with full budget on
  unreachable (fast probe races a just-woken network/relay: false "unreachable"
  is common — one background retry with `skipIfConnected` so a manual connect
  wins).
- **Native bootstrap guard**: never `initializeApp()` with an empty endpoint on
  native — Capacitor's static server would answer every request with index.html
  and the bootstrap would "succeed" against a fake backend (S7's poisoned-empty
  state must not exist).
- **Last-session restore**: after a successful cold-launch connect, the session
  that was open last time reopens — but only after an authoritative sessions
  snapshot confirms it still exists (a stale pointer is cleared), and only if the
  user hasn't picked a session meanwhile; an open draft does NOT block the
  restore (a draft at boot is the default, not a user choice). Overlay stays up
  until the decision lands (≤ 6 s valve).
- **Hosted PWA install path (pointer → 01)**: installed from the browser
  — desktop "Install" in the address bar; iOS Safari Share → Add to Home Screen;
  Android Chrome menu → Install app. From outside the network the PWA needs a
  tunnel + strong UI password (native apps handle reachability via relay — 08).
  The installed PWA standalone-mode safe-area/dvh rules are in B.2/B.8; the
  mobile surface's own URL is `/mobile.html` on the served build.

---

## G. Delta table vs desktop web (UX-difference summary)

| Aspect | Desktop (01) | Mobile (this doc) |
|---|---|---|
| App root | `MainLayout` (sidebar + right panel) | `MobileShell`: drawers/sidebars around an always-centered `ChatView`; no overflow menu |
| Sessions | persistent sidebar; dense tree | phone: slide-in drawer (always mounted, parked); tablet: persistent resizable sidebar 280-560 px (default 320) |
| Workspace | right sidebar tabs | right drawer (phone/full-width, 320 ms slide) or resizable panel 380-900 px (tablet, only when width ≥ 1000) |
| Tables/dropdowns | desktop popovers | bottom sheets on phones; anchored popovers on tablets; app-level surfaces fullscreen (phone) vs centered dialog (tablet) |
| Title bar | window chrome | `MobileHeader` 56 px with safe-area padding; title = session switcher trigger |
| Input | text inputs any size | 16 px inputs (iOS no-zoom), 36 px touch targets, autocorrect off on URL/token fields |
| Composer | always full | pill↔full state machine; keyboard choreography; dictation morph; hardware-keyboard alwaysExpanded |
| Scroll | wheel-driven | dvh viewport, scroll-lock, edge swipes (32/80 px zones), momentum code-block scrolling |
| Terminal (07) | pointer + hotkeys | touch gesture machine (drag=scroll, long-press=select, tap=focus/raise IME), copy/paste via menu (context menu disabled for touch) |
| Keyboard | irrelevant | `resize-content` viewport mode, native FLIP choreography, hardware-keyboard bridging, `interactive-widget` |
| Auth | server password gate once per browser | browser: same gate; native: per-instance unlock + one client token per device stored in Keychain/Keystore, device dedupe record |
| Connection | same-origin only | ordered transport candidates (LAN/tunnel; relay fallback), auto-connect, resume re-probe ladders, identity-gated probes |
| Notifications | web push + in-app | native: APNs/FCM only (local notifications disabled); presence beacon; foreground suppression; badge; hosted keeps web behavior |
| Updates | server-update flow | hosted adds server-update drawer item; native: store updates (Android gets a download toast; hosted-only update surface) |
| Widgets/deep links | none | iOS widgets + Control Center + NSE; `openchamber://` intents from taps/widgets |
| State salt | window per surface | same stores; extra persisted stores: `mobile-session-tree`; viewport-keyed tablet sidebar widths |
| Tablet | n/a | size-class layout (600/1000 px rules), foldable-aware, live `useTabletLayout` |

---

## H. Edge cases and invariants (checklist of hard rules)

**Connection/probing**

1. Never send the bearer token over an unverified direct address: `/health` first
   (unauthenticated), identity-gate versus the paired `serverId`, THEN
   `/auth/session` bearer-only.
2. A stale cookie must never mask a revoked token: native probes always use
   `credentials:'omit'` when a token exists.
3. `needs-login` is global across transports (one shared token); unreachable is
   per-transport.
4. A cookie-only authenticated session is insufficient on native (needs scope
   `client` = issued device token).
5. Token writes are awaited BEFORE the runtime switch; Keychain failures surface
   as `authRequired`, never silent success.
6. One device = one token = one runtime key (`relay:<serverId>@<relayUrl>` or the
   normalized direct URL) so LAN⇄relay never resets the app.
7. Candidate refresh must never delete everything on empty answers; it replaces
   only `lan`-class entries and only when the server echoes the right serverId.
8. Transport-only endpoint changes must not remount SyncProvider (rebind path);
   key changes must fully reset (stale-store poisoning is worse than a reload).
9. The single-use pairing secret is spent on redeem against the first reachable
   transport; never re-post it to other candidates.
10. Relay probe adopts its open tunnel into the runtime (no second handshake);
   an unused loser tunnel is always closed (leak-free race).
11. A fast verdict must not pin the splash: fast probe → connect screen quickly +
   ONE background full-budget retry (`skipIfConnected` guards the manual race).
12. Cold-launch auto-connect splits WHY it fell through (unreachable vs
   revoked auth) — landing silently reads as data loss.

**Layout/keyboard/safer areas**

13. 16 px text inputs, 36 px touch targets on mobile pointer — non-negotiable
    (iOS zoom + reach).
14. Keyboard: `resize:none` + FLIP on iOS; `adjustResize` + signal events on
    Android; never mix (double-counting insets).
15. Shell height never animates; transforms + one invisible settle; caret hidden
    mid-animation (WKWebView native caret layer ignores transforms).
16. Chat scroller keeps a constant viewport across keyboard transitions
    (constant `clientHeight`; deterministic re-pin on settled events).
17. `100dvh` may be stuck after keyboard hide on standalone iOS — pin shell to
    `100lvh` in the PWA; do not freeze `-webkit-fill-available` on
    dvh-capable Android.
18. Android 15 edge-to-edge: read Capacitor-injected `--safe-area-inset-*` inline
    vars first (env () may read 0), and opt-in surfaces pad the nav-bar side;
    keyboard inset and bottom safe inset never stack (zero-period rule).
19. Body-portal sheets must subtract the keyboard inset + top safe area from
    `100dvh`-based max-heights (the WebView never shrinks on its own).
20. Tablet layout is size-class-driven and live; folding must never leave a
    sidebar open over a phone-width screen (auto-close on losing the class).
21. App-level overlays center on the CHAT column (`--oc-chat-inset-*`), not the
    window, once sidebars produce insets.

**Native lifecycle**

22. Status bar overlay state must be re-asserted after backgrounding and scene
    re-activation (iOS 26 UIScene lifecycle drops it silently).
23. Widget snapshots must only reload timelines on change (reload budget);
    attention count mirrors the in-app unread logic including the subtask opt-out.
24. The app badge is zeroed on activation (server restarts the count; in-app
    indicators take over), and the server's pending badge clears on
    open-session/message-sent signals, not just the visibility beacon.
25. Native push registration is gated on native platform, connection, and the
    user setting; unregistering on setting-off must use the LAST token; a
    transient disconnect never unregisters.
26. Local notification APIs must be no-ops on native (WKWebView
    foreground/background ambiguity); APNs/FCM is the only channel; the foreground
    banner is suppressed client-side (`presentationOptions: []`), never server-side.
27. Deep-link listeners register from app boot (cold taps can't be lost) with a
    newest-wins stash flushed at ready; session intents resolve via the session
    store even before the shell mounts.
28. Removing a focused editable with an IME composition wedges Android WebView
    input — blur + hide keyboard before teardown (terminal surface contract).
29. The WebView never recreates JS state on rotation/fold (Android
    `configChanges` holds screenSize etc.); all layout decisions must be live
    hooks, never mount-time constants.
30. iOS 26: WKWebView chrome must clear background/opaque and hide scroll edge
    effects; user scripts inject in `capacitorDidLoad` only.
31. `oc:hardware-keyboard` / `__OPENCHAMBER_HARDWARE_KEYBOARD__` are idempotent;
    inference is abandoned forever once a native answer arrives.

**Renderer-level**

32. `window.__OPENCHAMBER_SURFACE__ = 'mobile'` must be stamped before any
    surface-dependent consumer; device classes applied before first paint.
33. On native, notifications APIs are retired at boot; hosted keeps its own
    notification path (04/03).
34. Bootstrap on native requires a non-empty runtime endpoint (fake-backend
    invariant from F).
35. Session tree expansion: project/worktree state persists (explicit overrides
    only, defaults = projects open, worktree groups collapsed); subsession
    expansion is session-scoped memory.
36. Mobile keeps the terminal PTY alive with its own keepalive hook (no
    MainLayout on this surface).

---

## I. Build checklist (implementation order for a clean-room port)

1. **Renderer shell**: `mobile.html` (viewport string, pre-paint script, splash
   bg keys), `mobile-main.tsx` harness `createConfiguredWebAPIs` port; boot
   sequence order of B.1.3; `SessionAuthGate` split (browser vs native).
2. **Device + layout**: port `device.ts` classes, `useTabletLayout` /
   `readTabletLayout` (600/1000), `useOrientation`, `useTabletStandalonePwaRuntime`;
   `mobile.css` tokens (typography, safe areas, scroll lock, dvh rules, bottom
   gradient, toast offsets).
3. **Mobile shell**: `MobileShell` composition (B.4), `MobileHeader`,
   edge-swipe hook, layer ladder + Android back, `MobileFullscreenSurface`
   variants, `--oc-chat-inset-*` publication, wide-chat layout class.
4. **Sessions tree**: bucket matching, indentation, persisted/unpersisted stores,
   footers, dnd reorder, search, sort options shared with desktop; per-bucket page size.
5. **Workspace drawer**: tab set + tab persistence, Changes/Files/Terminal/Notes/MCP
   panes, `pendingChangesDiff` persistence contract, drawer animation, plan layer.
6. **Composer mobile layer**: `useMobileComposerShell` rules verbatim (flushSync
   points, focus timing, collapse triggers, overlay handoff, PWA focus/restore),
   draft starters rules, mobile.css composer paddings.
7. **Keyboard**: `mobileKeyboardMode` lib + settings entry (14); native chrome
   hook (status bar both platforms, keyboard choreography iOS, signal-only
   Android); hardware keyboard bridge; keyboard CSS variables contract.
8. **Connect flow**: candidate model + storage, secure store, request layer
   (native-http-first), probing algorithm + identity gates, race + headstart,
   password unlock, pairing redeem, transport switch + rebind, resume ladder,
   online listener, auth-expiry reaction, candidate refresh, connect screen UX,
   debug panel + logging trail.
9. **QR scan**: scanner overlay + plugin paths (Android startScan, iOS scan),
   payload parsers (URL + string fallback), permission failures.
10. **Push**: registration hook + server endpoints; iOS env injection; badge/
    visibility integration; Android FCM icon/config.
11. **Deep links**: vocabulary module, sources (appUrlOpen + notification taps),
    stash/flush, shell handlers; widget URL encoder parity.
12. **Native extras**: widgets snapshot bridge + SceneDelegate write, NSE, app
    badge zeroing, iOS 26 scroll-edge hiding, Android manifest set (configChanges,
    adjustResize, cleartext, permissions, FCM icon), cleartext networking security
    config, google-services.json plumbing.
13. **Build tooling**: prepare-web-assets, with-mobile-env, ios-sim-build (MLKit
    strip), ios-sim, ios-sim-dev, android-device, serve-sim integration; root
    aliases; validation commands.
14. **Testing**: type-check:mobile + lint:mobile + both native builds; on-device
    verification suite per D.3 + keyboard/safe-area invariants H.13-17; sim
    stream-based interaction checks (D.4).

---

*End of 11. Sources: packages/mobile (README, HANDOFF, capacitor.config.ts,
package.json, android + ios trees, scripts), packages/web (mobile.html,
mobile-main.tsx, vite.config.ts, server push/notifications + request-security),
packages/ui (apps/Mobile*, mobileConnections, mobileNativeChrome, mobileQrScan,
mobileWidgetSnapshot, deepLinks, deepLinkNavigation, device, hardwareKeyboard,
mobileKeyboardMode, runtimeSurface, platform, styles/mobile.css, composer shell,
terminal viewport), packages/docs/content/docs/mobile.mdx.*
