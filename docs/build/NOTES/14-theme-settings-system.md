# NOTES 14 — Theme, settings, i18n, shortcuts (from docs/planning/14)

Doc read in full (1,553 lines). P5 sliced as below; nothing here relaxes the
doc contracts — this file records the seam renames, interpretation calls, and
what lands per slice.

## A. Slice map vs doc-14 build checklist (§L)

- **P5-1 (done)** — item 1+2 partial: `styles/design-system.css` token block
  (§B.1 aliases, generated seed, §B.2 radius/motion/fonts, §B.3 typography as
  static vars — delta E1), `@theme inline` mappings, ThemeProvider skeleton
  with Delta D8 resolved (system follows matchMedia both ways).
- **P5-2 (this slice)** — item 5: the theme system. `lib/theme/`:
  `types.ts` (Theme shape per §E.1/§E.6 incl. the full generator-consumed
  surface), `validation.ts` (`isValidTheme` per §E.6 validation list),
  `pr-colors.ts` (`withPrColors`), `color.ts` (hex math the generator needs),
  `derive.ts` (full-schema completion from seed palettes — the §E.7 port-tool
  concept: no half-mapped tokens), `css-generator.ts` (§A.2 layer 2: single
  style element id `nnd-theme-variables`, variant-scoped blocks, shadcn-alias
  vars with `!important`, `data-theme`, html class pair), `presets/*.ts` +
  `themes.ts` (38 built-ins, §E.2 order, alias map, `getDefaultTheme`).
  ThemeProvider upgraded to the §E.1/E.3 contract: mode + light/dark pair,
  runtimeKey-scoped storage, validation, transition suppression, browser
  chrome update, legacy mirror keys. NOT in this slice: settings registry
  theme keys (P5-3), i18n appearance strings (P5-4), shiki/diff/terminal
  consumers (P6/P7), iframe sync (no embedded surfaces yet), dev-HMR events.
- **P5-3** — item 6: settings registry table + parsers + snapshot generator +
  server gate + debounced PUT/mirror/auto-save machinery; fs-write no-op
  carry-over from P4-3.
- **P5-4** — items 3(partial, settings primitives with the `settingsItem`
  anchor), 7(SettingsWindow/pages/search), 8(i18n), 9(shortcuts engine —
  re-routed to P5-5), settings label keys.
- **P5-5 (shortcuts engine, done)** — item 9: config/schema/bindings/
  registry/dispatcher/hooks per §I.1–I.2 + §I.3 authority rules. NOT yet in
  slice (registered): the settings Recorder page + main-app router wiring +
  contextual ownership (§I.3/§I.4) ride the settings-UI slice; formatting
  helpers (§J) and the appearance picker §G.4 wiring land with the settings
  UI too.
  Count split recorded in PLAN/PROGRESS.

## B. Brand seam renames (openchamber → notnative/nnd; one list)

| doc-14 name | NND name |
|---|---|
| `openchamber.theme.v2:<key>` | `notnative.theme.v2:<enc runtimeKey>` |
| `openchamber.i18n.v1` | `notnative.i18n.v1` (P5-4) |
| `openchamber.settingsMirror.v2:<key>` / `openchamber.deviceSeeded.v1:<key>` | `notnative.settingsMirror.v2:*` / `notnative.deviceSeeded.v1:*` (P5-3) |
| style id `opencode-theme-variables` | `nnd-theme-variables` |
| class `oc-theme-switching` | `nnd-theme-switching` |
| `openchamber:settings-synced` / `-save-state` events | `notnative:*` equivalents (P5-3) |
| defaults `openchamber-light`/`openchamber-dark` | `notnative-light`/`notnative-dark` |
| legacy alias `app-light`/`app-dark` → flexoki | kept (alias map, themes.ts) |
| custom themes dir `~/.config/openchamber/themes/` | data dir `themes/` (server env; P4-2 route already serves it) |
| doc mirror keys `themeMode/useSystemTheme/selectedTheme*` + splash colors | kept verbatim (doc-neutral names), PLUS the branded `notnative.themeMode` key the shipped web splash reads (review F1) |

CSS token prefixes (`--oc-*`, glass class names `oc-glass-*`) stay `oc-`
verbatim per P5-1 (they are design-system internals, not brand seams).

## C. Theme system interpretation calls

1. **38 built-ins count ambiguity (§E.2, gap §M).** The doc lists 18 pair-marked
   families + 2 explicit vitesse entries, but 18 pairs + vitesse would overshoot
   the stated 38 (2 brand + 2 flexoki + 36 + 2 = 42). The only decomposition that
   adds up: **14 light/dark PAIRS** (fields-of-the-shire, aura, ayu, carbonfox,
   catppuccin, gruvbox, jetbrains, kanagawa, monokai, nightowl, nord, onedarkpro,
   solarized, tokyonight) + **6 SINGLES** (dracula, vesper, mono-plus, mono,
   vitesse-dark, vitesse-light): 2 + 2 + 28 + 6 = 38. Singles skew dark
   (dracula/vesper/mono-plus/vitesse-dark) with mono + vitesse-light filling the
   light bucket. Answering shanz's design call: `cycleTheme` cycles
   current-variant themes in registration order.
2. **Preset palette contents are ours** (§M: originals not transcribed). Each
   preset = a compact SEED (bg/fg/primary/status/syntax hues) expanded by
   `derive.ts` into the FULL required schema (§E.6) with the generator's
   documented default derivations (hover=darken10, active=darken20, muted=50%
   alpha, emphasis=lighten10). Surface muted/elevated always 8-digit-hex-end-90.
   `primaryForeground` picks by contrast (readable over the base) rather than
   the doc's "#fff" example — texture-consistent across dark primaries.
3. **Generator coverage** (§B.1 runtime token table): alias block, primary,
   surface, interactive, status, pr, syntax base+tokens, markdown, chat,
   tools, charts.series, loading, sidebar overlay cluster, theme config
   (fonts/transitions), typography vars. Radius overrides are
   forward-compatible input only (§E.6) — typed on ThemeConfig, never emitted.
4. **Typography via static vars, not the watcher** (delta E1, P5-1): the
   generator re-emits `--text-*` as FIXED constants in the runtime block
   (a theme cannot carry its own sizes); root scaling lands with the P5-3
   store (applyTypography sets the rem root per §B.3).

## D. Settings architecture notes for P5-3 (F.1–F.6)

- Registry is the single table (§F.5 inventory): **186 fields registered**
  (doc's ~160 + the F.4 LOCAL_DEVICE_KEYS/DESKTOP_SHELL_KEYS groups, which we
  register as first-class fields to keep one table). **Deferred groups**
  (register with P11/P12 consumers + `stt`/`dictation` with the voice page):
  tunnel*, githubClientId/Scopes (registered; UI later), skillCatalogs
  (registered), desktopUiPassword + hasDesktopUiPassword + desktopLanAccess*
  (registered as the secret/computed exemplar set), sttProvider/ServerUrl/
  Model/LocalModel/Language, dictationEnabled, agentMemoryFeatureAvailable.
- Snapshot generator `scripts/registry-snapshot.mjs` → root script
  `registry:snapshot` → checked-in copy
  `packages/web/src/server/lib/settings-registry.json` (the VS Code copy is
  N/A here). Staleness gate: `lib/settings/__tests__/registry.test.ts`
  re-renders the snapshot and fails on drift.
- Server gate (`server/lib/settings-gate.ts`) consumes ONLY the JSON
  snapshot (no TS import from ui): write-ineligible = unknown, computed,
  local, device-scope, owner desktop-shell; secret accepted and never
  returned; surface kinds constrain surface-scoped fields.
- Split store (`server/lib/settings-store.ts`): preferences.json
  `{version:1, fields:{key:{value,updatedAt,surfaces?}}}` + settings.json as
  the flat rollback mirror (unknown legacy keys preserved). Seed-once reads
  settings.json; unparseable preferences.json is never rewritten (writes fall
  back to the mirror path). Server resolves kind→surfaces[kind]→base on GET;
  kind values are never written to the base. `?surface=` is the query param;
  `x-nnd-surface` header is the fallback.
- Client engine (`lib/settings/persistence.ts`): cached GET 2 s TTL +
  in-flight dedupe (rides HP-6 coalescing), UpdateDesktopSettings → 200 ms
  debounce → keepalive PUT, lifecycle flush on pagehide/beforeunload/hidden/
  freeze/endpoint-switch, echo suppression vs server-known, pending overlay,
  mirror w/ 5-runtime index + eviction, device-seed marker, and
  `notnative:settings-synced {settings,bootstrap,adoptTheme}` (ThemeProvider
  adopts the theme pair on bootstrap grade). Value validation (invalid ==
  absent) happens client-side in parse.ts — the server stores registry-gated
  raw values by design (doc-14 §§F.3/F.4 split).
- Model-prefs 1200 ms cadence + store bindings (uiField markers in the
  registry) land when the stores exist (P5-4+); `autoSaveKeys()` is derived
  and already excludes them.
- fs-write no-op (P4-3 carry-over): identical-content writes skip the atomic
  rewrite (`unchanged: true`) so editor autosave loops don't churn mtimes.
- Seam name: the doc's server-side reader is `readMergedSettingsSync`; ours is
  `readMergedSettings` (routes are async-capable but the store is sync;
  rename follows ADR-0020's coordinated pass, D13).
- Device-scope keys DO reach the generic synced payload (they are registry
  fields); P5-4 store-apply adopters must consult the device-seed marker
  (expose via the persistence engine) so a stale server doc cannot re-apply.

## E. i18n plan for P5-4 (§H)

- `lib/i18n/`: runtime.ts (storage `notnative.i18n.v1`, detection chain
  stored → host global `__NOTNATIVE_HOST_LANGUAGE__` → `en`), messages/en.ts
  canonical flat dotted dictionary (closed `I18nKey` type), 11 non-EN locales
  as catalogs (partial, en-fallback — delta E2: full per-locale parity is a
  translation effort, not a build gate; runtime falls back to en key-by-key
  per §H.2 resolve chain), store.ts + context provider (upgrade of the P0
  stub, keeping `t`), bootstrap strings for splash/connection.
- The P0 stub's `shell.*` keys move into `messages/en.ts` unchanged so the
  existing consumers keep compiling.
- P5-4 landed outcome: single `messages/locales.ts` holds the 11 partial
  catalogs (per-locale file split arrives with real translation volumes);
  locale labels are ENDONYM table (`NATIVE_LABELS`) — the doc's
  `common.language.*` label keys are deferred until translations carry
  them; en ships shell + bootstrap + notification-template-default keys
  closed set. `label(locale)` keeps working for the appearance picker.
- I18n store: English synchronous, catalogs merged over en, module-cached;
  optimistic switch keeps `loadingLocale` marker then settles (sync catalogs
  settle on the next microtask; the async dynamic-loader contract remains
  for future bundles).

## F. Deltas / deferred register (new rows for PROGRESS)

| # | Item | Lands | Note |
|---|---|---|---|
| E1 | typographyWatcher static-sheet substitution | P5-1..3 done | static-sheet values match; dynamic root scaling is implemented by the settings appearance applier |
| E2 | non-EN locales as partial catalogs with en fallback | P5-4 | parity is authoring work; resolve chain per doc |
| E3 | 38-preset palette contents self-authored seeds | P5-2 | original JSONs untranscribed (doc gap §M) |
| E4 | iframe/embedded theme sync + VS Code adapter | defer | no embedded/VS Code surfaces until P10/P12 |
| E5 | custom theme import UX (Settings→Appearance reload) | P5-3 done | Appearance exposes Reload; the client reloads validated themes from GET /api/config/themes |
| E6 | syntax/terminal/diff theme consumers | P6/P7 | ✅ Current syntax, terminal, and diff consumers use active theme tokens (2026-09-30); no Shiki renderer exists in this build. §E.8 conversion contracts recorded. |
| E7 | splash shells speak the stored locale (§H.4 readStoredLocaleForBootstrap wired into HTML splash) | P12 | ✅ Ordered web bootstrap sets stored locale before the app module; locale changes also update the document language (2026-09-30). |
| E8 | `getCurrentIntlLocale()` glue (BCP47ByLocale → Intl consumers, §H.2 intl.ts) | P6+ | ✅ Shared BCP 47 helper is used by date/time/money, schedules, activity timestamps, token counts, and goal budgets; subscribed consumers repaint on locale changes (2026-09-30). |
| E9 | `useI18n.ts` as a separate hook file | folded into context.tsx | doc parity note; single export surface kept |
| E10 | normalizer collapse calls recorded | P5-4 done | bare `pt`/`pt-PT` → pt-BR; `es-419`/`en-GB` → base; LOCALES order is load-bearing for bare `zh` (pinned by test) |

## J. P5-6 settings-UI-core decisions (§A.3/§G/§I.3/§J/§B.3) + review dispositions

Landed: primitives with `settingsItem` anchors (SettingsSection carries a
section-level anchor too), the full page-tree registry (built pages:
general/appearance/chat/notifications/sessions/shortcuts; everything else
renders the registered-phase landing note), SettingsWindow + search index
(§G.6 ids == rendered anchors, enforced by a resolution gate test),
six built pages, the §I.3 recorder dialog + shortcuts page (customize-only
rows; overrides ride `shortcutOverrides`), §J time/money/timezone,
appearance appliers (rem-root scale, --padding-scale, radius remap delta
E11, font choices — stacks only), ShellShortcuts router install (mac-aware)
+ shell-owned actions, settings bridge + appliers bound at APP BOOT,
theme pair writes to the registry on USER INTENT, window-suspends-global
registry (§I.2) and the recorder invalidates armed prefixes (§I.4),
quality-gates gained the CP1252-mojibake scan.

Review dispositions: P0-1 scrollIntoView crash (jsdom stub + per-control
`data-settings-search-highlight` + timer cancel + jump assertions); P0-2
cycle_theme invalid hook fixed (settler ref); P1 boot bind; P1 anchor
orphans (fixed ids + section anchors + resolution net); P1 customize-only
rows; P1 theme registry writes; P1 mojibake (chat/notifications/general/
fs.ts + the gate); P1 `isMac()` plumbed into dispatcher + recorder strokes;
P1 registry suspension + prefix invalidation; P1 `opencodeBinary`
allowEmpty (empty clears the override). P2s landed: expiry/risk/exceeded/
modifier-only recorder pins, per-control highlight, `BUILTIN_SLUGS`
single-sourced, cornerRadius 0..1024 + goalBudget ≤1e8 parser caps,
browser-risk badge in the dialog. REGISTERED deferrals — E12 Base-UI
dialog upgrade (Escape-close/focus-trap/nested-dim/sr-only description),
E13 page i18n key sweep (labels hardcoded en today; keys join the closed
set page-by-page), E14 `?settings=` history integration, E15 notifications
permission-denied gating + permission reconciliation, E16 `voice`/`about`
slugs join the page registry with their pages, E17 recorder-dialog test
file (its wiring attributes + confirm-stays-local are engine-pinned only),
E18 control-form deltas (selects-for-radios on chat; enterToSend pair UI;
terminalFontSize reset semantics; filePreview event dispatch in P6).

## I. P5-5 shortcut engine decisions (§I.1–I.3) + review dispositions

Schema = 36 bindings mirrored 1:1 from §I.1 (17/5/7/3/4 across the five
categories; literal `ctrl+]`/`ctrl+[`; prefix-style `mod` and `mod+alt`;
internals `abort_run`, `cycle_thinking_variant`, `save_file`,
`find_in_file`). Engine decisions (recorded, not in the doc):

1. **Bare-prefix grammar** = ≥1 of mod|ctrl (alt/shift may join — §I.1's
   `switch_context_surface` is `mod+alt`); `{alt}`/`{shift}` alone are
   format errors. Empty `+` tokens rejected (corrupt overrides become
   format errors, never ghost prefixes). Schema round-trip is tested.
2. **Second chords are EXACT as declared** — `mod+k r`'s second is bare
   `r`; a held-Ctrl second is a mismatch → prefix clears. Pin for the
   recorder guidance copy.
3. **Armed prefix = the whole sibling family** (mod+k arms ALL mod+k
   candidates whose action has a live handler); arm-time snapshot of
   candidates (registered decision — late-registrant handlers require
   re-arming; the doc is silent, original OT re-resolved at dispatch).
4. **Windows mod≡Ctrl aliasing**: non-mac chords `ctrl`→`mod` at match
   time; mac keeps literal ctrl for ⌃]. AltGraph (win ctrl+alt) yields to
   text entry in both routers (§I.2 verbatim).
5. **Capture-phase second-key listener** added at router install (deferred
   §I.4 consumers need it; inner stopPropagation cannot kill sequences).
6. **Registry re-acquire**: removal promotes the next-in-line bound
   handler (§I.4 toolbar over fallback contract is robust to unmount
   order).
7. **recorderConflict(actionId, combo, overrides)** returns
   `{kind: exact|prefix|none, replaceable, otherActionId}` and resolves
   opponents WITH the live overrides — recorder-spec-shaped for §I.3;
   prefix conflicts block; exact customizable conflicts replace (loser →
   UNASSIGNED); internals block, never replaceable.
8. Expiry is strictly-greater (3000ms boundary dispatches; 3001 not) and
   swept LAZILY by the next keydown (no timer).
9. Display: named-key labels (comma→',', arrows→←/→, Esc); mac glyph
   order ⌃⌥⇧⌘; names Ctrl/Alt/Shift.
10. Review dispositions: P0 bare-prefix crash fixed; P1 router unInstall
    closure leak fixed (module-stored listener refs, symmetric teardown
    test); P1 capture listener; P1 AltGraph; P1 arming editable gate; P1
    registry re-acquire; P1 recorderConflict shape; P1 IME armed-second
    test made real (+preventDefault-during-composition decision: the
    matched second key preventDefaults to avoid composition insertion —
    pinned by test); P2 expiry pins, display tables, dead code, ghost
    tokens, normalizeEventKey whitelist, I18nKey-typed labels +
    round-trip label test. Deferred: recorder page, router wiring,
    §I.4/§I.5 helpers (settings-UI slice), formatting §J.

## H. P5-3 review dispositions (adversarial sub-agent, 2026-09-17)

FIXED this slice — both P0s: parse now collects `derived` (doc: "sent but not
user-settable"), ThemeProvider adoption is a FIELD-WISE merge (§K1: absent
keys never reset to defaults; single-key docs no longer inject the default
pair); the corrupt-preferences fallback now routes the SAME registry gate
(no more raw-patch leak into settings.json; real `dropped` list, per-surface
keys excluded there). P1 cluster: flush lost-update fix (per-key stringified
ownership + serialized flushes via an in-flight guard), endpoint-switch flush
rides `notnative:runtime-endpoint-will-change` (old instance gets the data;
`changed` resets serverKnown/cache/pending), typography caps pinned (pNum
min/max: fontSize+[padding] 50..200, terminal 9..52, editor 9..32),
permissionAutoAccept composite parser ({sessions, revision}), GET overlay +
cache-advance on successful flush, write-side sanitation (client applies
field.parse before buffering). P2s in-slice: computed keys respect their
surfaces (web GET has NO hasDesktopUiPassword), pure-query surface param on
/api/config/settings (header fallback survives only on the bridge route),
pList dedupe-before-cap aligned with "caps are limits", notificationTemplates
composite (i18n keys, {completion,error,question,subtask}), skillCatalogs/
projects/terminalShell deferred-shape notes, mirror no-op digest (mtime
churn), device-seed consumer contract documented, save-state repeat-quiet,
shared renderer module (scripts/registry-render.mjs) for both generator and
staleness test, engine `__resetEngineForTests()`, stale fs comment, PROGRESS
wording. Declared: secret keys ride the client write path (server accepts,
never returns, never mirrored) — §F.2 verbatim.

## G. P5-2 review dispositions (adversarial sub-agent, 2026-09-17)

FIXED this slice — F1 splash mirror split (both doc-neutral keys AND branded
`notnative.themeMode` now written; index.html resolves `system` via
matchMedia); F2 customs wrapped withPrColors + partial-`pr` merge; F3
flip-flop guards PINNED by tests (OS flip + storage adoption write nothing);
F4 color math table tests; F5 exact derivation values pinned (hover/active/
emphasis/muted-alpha, pr merged chain, token passthrough); F6 theme-color
metas patched in place (plain + media variant). Also: alias-block
duplication removed (F7), non-hex optional values filtered at the generator
edge (F8), write intent rides the SETTER directly instead of a cross-effect
flag — adoption/OS-flip writes are impossible by construction, intent is
kept when the runtime key is still transient (F9/F12/F13), legacy seed maps
selectedThemeId/selectedThemeVariant and persists the scoped copy once,
readonly store API object (F9 done via action restructure), memory-only
`meta` handling (F13). REGISTERED for P5-3: server /api/config/themes
first-wins id dedupe when the Reload UI lands; readableForeground primary
contrast pick declared (C.2); config.radius typed as forward-compatible
input (C.3); C.4 wording fixed (typography vars are fixed re-emission, not
theme-carried sizes).
