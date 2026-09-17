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
  anchor), 7(SettingsWindow/pages/search), 8(i18n), 9(shortcuts).
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

- Registry is the single table (§F.5 inventory, ~160 keys) with scope/parser/
  flags/binding; everything else derives. Snapshot JSON
  `{version:1, fields:{...}}` is generated by `scripts/registry-snapshot.mjs`
  → checked into `packages/web/src/server/lib/settings-registry.json` (no VS
  Code package — the vscode copy is N/A; gates: snapshot test + web server
  sanitizer consuming the snapshot file).
- Surfaces implemented: `web` + `desktop` (desktop = Electron, P12) with
  `x-nnd-surface` header stamp (runtime already ships it); `vscode`/`mobile`
  field markers stay in the registry for forward compat but their UIs don't
  exist yet.
- Per-surface writes ride the `?surface=` QUERY PARAM (§F.2, CORS-simple).
- Server GET/PUT from P4-2 becomes registry-gated: unknown keys dropped,
  invalid values dropped as absent, secrets accepted-not-returned, computed
  accepted-not-persisted, `preferences.json` split store (§F.3 two files).
- AUTO_SAVE decomposed: appearance keys via store subscription (P5-3+,
  when ui-store exists), model prefs 1200ms cadence stays parked until the
  model-catalog store binds (registered, not silently dropped).

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

## F. Deltas / deferred register (new rows for PROGRESS)

| # | Item | Lands | Note |
|---|---|---|---|
| E1 | typographyWatcher static-sheet substitution | P5-1 done | identical values; dynamic root scaling still owes applyTypography (P5-3) |
| E2 | non-EN locales as partial catalogs with en fallback | P5-4 | parity is authoring work; resolve chain per doc |
| E3 | 38-preset palette contents self-authored seeds | P5-2 | original JSONs untranscribed (doc gap §M) |
| E4 | iframe/embedded theme sync + VS Code adapter | defer | no embedded/VS Code surfaces until P10/P12 |
| E5 | custom theme import UX (Settings→Appearance reload) | P5-3+ | GET /api/config/themes exists; page lands with settings UI |
| E6 | shiki/terminal/diff theme consumers | P6/P7 | contract noted §E.8 |

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
