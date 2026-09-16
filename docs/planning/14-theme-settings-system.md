# 14 — Theme, Design Tokens, Icons, Settings, i18n, Shortcuts

NotNativeDesktop cleanroom reference. This document specifies OpenChamber's design-token system,
theme pipeline, icon system, primitive library surface, settings architecture, i18n layer, and
keyboard-shortcut engine, in enough detail to re-implement all of it on a different agent harness
without reading the original repository.

Source paths are cited as `(src: packages/ui/src/...)` for traceability only; the reader needs
nothing from this repo beyond this file.

Scope markers used throughout:

- `HARNESS PORT` — the mechanism reads or writes the agent harness's configuration (the OpenCode
  replacement in the cleanroom). Cross-references the harness API surface from document 02.
- Cross-references: 01 shell/chrome, 05 chat rendering copy, 06 editor (CodeMirror) styling,
  07 terminal, 09 desktop settings window, 10 VS Code registry gate, 11 tablet settings deltas.

Verified against the repository at version-pinned state 2026-09; every table below was transcribed
from full source reads, not summaries of summaries. Known gaps are listed in section M.

---

## A. Design system overview

### A.1 Stack (src: packages/ui/package.json)

| Concern | Choice | Notes |
|---|---|---|
| Styling | Tailwind CSS v4 (`tailwindcss ^4`, `@tailwindcss/postcss`) | Theme declared in CSS via `@theme inline`; no tailwind.config.js theme block |
| Headless primitives | `@base-ui/react ^1.4.0` (Base UI) | Dialog, Popover, Menu, ContextMenu, Select, Tooltip, Switch, Checkbox, Collapsible, Tabs are all Base UI. No Radix components are used (one stale CSS selector `[data-radix-popper-content-wrapper]` survives in two scroll-guard lists — ignore it) |
| Command palette | `cmdk ^1.1.1` | CommandPalette.tsx only |
| Toasts | `sonner ^2.0.7` | Wrapped by `components/ui/toast.ts` (see C.9) |
| Variants | `class-variance-authority ^0.7.1` + `clsx` + `tailwind-merge` | `cn()` helper in `@/lib/utils` |
| Animation utilities | `tw-animate-css ^1.3.8` (dev dependency) | Imported by the CSS entry; standard Tailwind v4 animation utilities (animate-in/out, fade/slide) come from it |
| Motion | `motion ^12.23.24` | Imperative animation where CSS is not enough |
| Syntax highlighting | `shiki ^3.23` in a web worker; CodeMirror 6 for the file editor | Cross-ref 06 |
| Terminal | xterm-compatible renderer + libghostty-vt wasm | Cross-ref 07 |
| DnD | `@dnd-kit/{core,sortable,utilities}` | Session tabs, rail ordering |
| Virtualization | `@tanstack/react-virtual 3.14.5` and `virtua` | Long chat lists, lists |
| Icons | `@remixicon/react ^4.7.0` (build-time only: paths pre-extracted into a sprite) | See D |
| Fonts | Fontsource packages fetched at runtime via `FontFace` loading | See B.4 |

**No HeroUI. `next-themes` is a declared dependency but is NOT used anywhere in `packages/ui/src`
— OpenChamber ships a fully custom theme engine (`ThemeSystemContext`). A cleanroom should not
re-implement it with next-themes; the custom engine exists because themes are two-variant pairs
(light id + dark id per surface), not a single light/dark toggle.**

### A.2 Token layering

There are three layers of CSS custom properties. A re-implementation must keep them distinct:

1. **Static defaults** — `packages/ui/src/styles/design-system.css` defines `:root` (light) and
   `.dark` fallback values in oklch, plus shell/environment tokens (`--oc-*`) and the Tailwind
   `@theme inline` mapping. These are what paint before any theme loads.
2. **Runtime theme injection** — `packages/ui/src/lib/theme/cssGenerator.ts` (`CSSVariableGenerator`)
   converts an active theme JSON into a `<style id="opencode-theme-variables">` element appended to
   `<head>`. The generator emits `:root { ...vars }\n.dark { ...same vars }` for dark themes and
   `:root { ...vars }\n:root:not(.dark) { ...vars }` for light themes, sets/removes the `dark`
   class on `<html>`, toggles each variable with `!important` for the shadcn-alias block, and sets
   `data-theme="light"|"dark"` on `<html>`. A theme switch replaces the single style element by id.
3. **Semantic scale** — `packages/ui/src/lib/typography.ts` (`SEMANTIC_TYPOGRAPHY`,
   `VSCODE_TYPOGRAPHY`) drives all font sizes via `--text-*` variables; `typographyWatcher.ts`
   injects them into `<style id="openchamber-typography-base">` at startup. Applied sizes differ
   per runtime: VS Code webviews use the tighter `VSCODE_TYPOGRAPHY` values; everything else uses
   `SEMANTIC_TYPOGRAPHY`. (src: lib/typographyWatcher.ts, lib/typography.ts, lib/theme/cssGenerator.ts:527-649)

Legacy-alias note: `--background/--foreground/--card/--popover/--primary/--secondary/--muted/...`
and `bg-background`-style Tailwind utilities still exist and are mapped in `@theme inline`; the
generator overrides them from theme JSON so old utilities keep working. Newer UI code prefers the
semantic tokens (`--surface-*`, `--interactive-*`, `--status-*`, `bg-interactive-hover`,
`bg-interactive-selection`).

### A.3 Component library policy

- `components/ui/*` are thin, tokenized wrappers over Base UI: they own styling (Tailwind classes
  reading token variables) and slot names (`data-slot="button"` etc.), not behavior.
- Settings pages never use raw Tailwind layouts; they use the shared building blocks from
  `components/sections/shared/SettingsSection` (`SettingsSection`, `SettingsTwoColumn`,
  `SettingsControlGroup`, `SettingsStackedField`, `SettingsFieldRow`, `SettingsInset`,
  `SettingsCheckboxRow`, `SettingsRadioGroup`, `SettingsRadioOption`, `SettingsChipGroup`,
  `SettingsGroupTitle`) and a set of exported class constants
  (`SETTINGS_SELECT_TRIGGER_CLASS`, `SETTINGS_SELECT_SIZE`, `SETTINGS_ICON_BUTTON_CLASS`,
  `SETTINGS_CONTROL_CLUSTER_CLASS`, `SETTINGS_CLUSTER_CONTROL_CLASS`, `SETTINGS_NUMBER_STEPPER_ROW_CLASS`,
  `SETTINGS_NUMBER_UNIT_CLASS`, `SETTINGS_NUMBER_INPUT_CLASS`, `SETTINGS_FIELDS_STACK_CLASS`,
  `SETTINGS_OPTION_STACK_CLASS`, `SETTINGS_CUSTOM_TRIGGER_CLASS`, `SETTINGS_SELECT_ROW_TRIGGER_CLASS`,
  `SETTINGS_FIELD_LABEL_CLASS`, `SETTINGS_HELPER_CLASS`). (src: components/sections/openchamber/*.tsx imports)
- Search/annotation convention: every Settings control carries `settingsItem="<dotted-id>"` which
  renders as `data-settings-item="<dotted-id>"` on the DOM. `SettingsView` uses that attribute to
  scroll-to-and-highlight a control after a search jump (see G.6). Any rebuilt settings UI must
  keep a stable, per-control, human-readable anchor id system.
- Typography utility classes used everywhere: `typography-ui`, `typography-ui-label`, `typography-micro`,
  `typography-meta`, `typography-settings-link` (defined in `styles/typography.css` and index.css).

### A.4 App shell CSS files

- `packages/ui/src/index.css` — the Tailwind entry (~800 lines): imports fonts/animations,
  loads `tw-animate-css` utilities, global scrollbar styling, `::selection` themed, per-runtime
  overrides (VS Code tool-card sizing note at ~line 771), markdown-content rules.
- `packages/ui/src/styles/design-system.css` — tokens (see B).
- `packages/ui/src/styles/typography.css` — semantic typography helper classes.
- `packages/ui/src/styles/mobile.css` — mobile-only chrome rules.
- `packages/ui/src/styles/fireworks.css` + `components/ui/FireworksAnimation.tsx` — celebratory
  overlay animation (used for milestones; decorative, optional in a rebuild).
- `packages/ui/src/App.css` — stale Vite starter file, unused by production code. Do not port it.

---

## B. Complete token reference

### B.1 Color tokens — static defaults (src: styles/design-system.css)

All values are as authored. Light theme is `:root`; dark theme is `.dark`.

**Shell / environment tokens (identical unless noted)**

| Token | Light | Dark |
|---|---|---|
| `--oc-safe-area-top/right/bottom/visual-bottom/left` | `0px` (mobile hosts overwrite) | same |
| `--oc-header-height` | `56px` | same |
| `--oc-visual-viewport-offset-top` / `--oc-visual-viewport-height` | `0px` / `100dvh` | same |
| `--oc-wco-left-inset` / `--oc-wco-right-inset` / `--oc-wco-titlebar-height` | `0px` (desktop window-controls overlays set these) | same |
| `--ui-regular-font-weight` | `400` | same |
| `--oc-scrollbar-thumb` | `oklch(0.32 0.03 50 / 0.4)` | same |
| `--oc-scrollbar-thumb-hover` | `oklch(0.32 0.03 50 / 0.6)` | same |
| `--padding-scale` | `1` (multiplies all spacing utilities; set by the `padding` setting) | same |
| `--oc-glass-blur` | `22px` | `26px` |
| `--oc-glass-opacity` | `52%` | `50%` |
| `--oc-glass-popover-opacity` | `50%` | `52%` |
| `--oc-glass-tooltip-opacity` | `62%` | `64%` |
| `--oc-glass-saturation` | `1.24` | `1.16` |
| `--oc-text-selection` | `color-mix(in srgb, var(--primary) 30%, transparent)` | same |
| Semantic `--text-*` defaults | see B.3 (they equal SEMANTIC_TYPOGRAPHY) | same |

**Core palette (shadcn-style aliases; oklch, with the authored hex comment)**

| Token | Light | Dark |
|---|---|---|
| `--background` | `oklch(0.97 0.02 85)` warm sand | `oklch(0.16 0.01 30)` (#151313) |
| `--foreground` | `oklch(0.25 0.02 40)` | `oklch(0.85 0.02 90)` (#cdccc3) |
| `--card` / `--card-foreground` | `oklch(0.99 0.01 90)` / foreground | `oklch(0.19 0.01 40)` (#1C1B1A) / foreground |
| `--popover` / `--popover-foreground` | `oklch(0.99 0.01 90)` / foreground | `oklch(0.24 0.01 40)` (#282726) / foreground |
| `--primary` / `--primary-foreground` | `oklch(0.65 0.2 55)` orange / near-white | `oklch(0.77 0.17 85)` (#edb449 golden sand) / `oklch(0.16 0.01 30)` |
| `--secondary` / `--secondary-foreground` | `oklch(0.92 0.02 80)` / foreground | `oklch(0.29 0.01 40)` (#343331) / foreground |
| `--muted` / `--muted-foreground` | `oklch(0.9 0.015 75)` / `oklch(0.45 0.02 50)` | `oklch(0.33 0.01 40)` (#403E3C) / `oklch(0.75 0.02 80)` (#b6b4ab) |
| `--accent` / `--accent-foreground` | `oklch(0.92 0.02 80)` / foreground | `oklch(0.29 0.01 40)` / foreground |
| `--destructive` / `--destructive-foreground` | `oklch(0.55 0.25 25)` / near-white | `oklch(0.65 0.15 30)` (#d98678) / `oklch(0.9 0.02 80)` |
| `--border` | `oklch(0.85 0.02 70)` | `oklch(0.31 0.01 35)` (#393836) |
| `--input` | `oklch(0.88 0.02 75)` | `oklch(0.33 0.01 40)` (#403E3C) |
| `--ring` | `oklch(0.65 0.2 55)` | `oklch(0.77 0.17 85)` |
| `--radius` | `0.5625rem` | same |
| `--chart-1..5` | blue `oklch(0.58 0.15 230)`, oasis-green `oklch(0.58 0.15 145)`, orange `oklch(0.65 0.2 55)`, rose `oklch(0.55 0.18 30)`, golden sand `oklch(0.6 0.16 85)` | `oklch(0.68 0.12 230)` (#5aa9d9), `oklch(0.68 0.12 145)` (#81af6c), `oklch(0.7 0.13 95)` (#c2974d), `oklch(0.65 0.14 45)` (#d8886d), `oklch(0.68 0.12 55)` (#d29470) |
| Sidebar group (`--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-primary-foreground`, `--sidebar-accent`, `--sidebar-accent-foreground`, `--sidebar-border`, `--sidebar-ring`) | `oklch(0.95 0.02 80)` / fg / primary / on-primary / `oklch(0.9 0.02 75)` / fg / border / ring | dark echoes of the above (#151313 base, #282726 accent, #393836 border) |

At runtime a loaded theme overwrites the whole alias block with **raw hex/8-digit hex values from
theme JSON**, not oklch — `body { background-color: hsl(var(--background)) }` in the static sheet
is a legacy quirk; the generator emits plain colors and `:root.desktop-runtime body` forces
`background: var(--background)` for the desktop shell.

**Runtime-only generated tokens** (not in any static file; produced by `CSSVariableGenerator`
per active theme, (src: lib/theme/cssGenerator.ts)):

| Group | Tokens |
|---|---|
| Primary | `--primary-base`, `--primary-hover` (default darken 10%), `--primary-active` (darken 20%), `--primary-foreground`, `--primary-muted` (base at 50% alpha), `--primary-emphasis` (lighten 10%) |
| Surface | `--surface-background`, `--surface-foreground`, `--surface-muted` (must be 90-alpha hex), `--surface-muted-foreground`, `--surface-elevated` (90-alpha hex), `--surface-elevated-foreground`, `--surface-overlay`, `--surface-subtle` |
| Interactive | `--interactive-border`, `--interactive-border-hover`, `--interactive-border-focus`, `--interactive-selection`, `--interactive-selection-foreground`, `--interactive-focus`, `--interactive-focus-ring`, `--interactive-cursor`, `--interactive-hover`, `--interactive-active` |
| Status | `--status-{error,warning,success,info}` + `--status-X-foreground`, `--status-X-background`, `--status-X-border` for each |
| PR | `--pr-open, --pr-draft, --pr-blocked, --pr-merged, --pr-closed` (defaults: success / muted-foreground / warning / #8957e5 dark `#8250df` light / error) |
| Syntax base | `--syntax-background, --syntax-foreground, --syntax-comment, --syntax-keyword, --syntax-string, --syntax-number, --syntax-function, --syntax-variable, --syntax-type, --syntax-operator` |
| Syntax tokens | one `--syntax-<kebab>` per token key (see theme format section E.6); missing token keys get computed fallbacks from base colors (darken/lighten/opacity heuristics in cssGenerator), and any provided key wins |
| Markdown | `--markdown-heading1..4`, `--markdown-link`, `--markdown-link-hover`, `--markdown-inline-code`, `--markdown-inline-code-bg`, `--markdown-blockquote`, `--markdown-blockquote-border`, `--markdown-list-marker`, `--markdown-bold`, `--markdown-italic`, `--markdown-strikethrough`, `--markdown-hr` |
| Chat | `--chat-background, --chat-user-message, --chat-user-message-bg, --chat-assistant-message, --chat-assistant-message-bg, --chat-timestamp, --chat-divider, --chat-typing` |
| Tools | `--tools-background, --tools-border, --tools-header-hover, --tools-icon, --tools-title, --tools-description, --tools-edit-added, --tools-edit-added-bg, --tools-edit-removed, --tools-edit-removed-bg, --tools-edit-modified, --tools-edit-modified-bg, --tools-edit-line-number` |
| Charts/loading | `--chart-N` (from `colors.charts.series`, if present), `--loading-spinner`, `--loading-spinner-track` |
| Sidebar overlay | `--sidebar-base`, `--sidebar-base-rgb`, `--sidebar-accent-base`, `--sidebar-accent-base-rgb`, `--sidebar-border-rgb`, `--sidebar-overlay-strong` (alpha 0.15 dark / 0.5 light), `--sidebar-overlay-soft` (0.1 / 0.3) |
| Typography | all of section B.3 variables |
| Theme config | `--font-sans`, `--font-family-sans`, `--font-mono`, `--font-family-mono`, `--font-heading`, `--transition-fast`, `--transition-normal`, `--transition-slow` |

### B.2 Tailwind `@theme inline` mapping (src: styles/design-system.css:362-532)

- Radius scale: `--radius-none: 0; --radius-sm: 0.25rem; --radius-md: 0.4375rem; --radius-lg: 0.5625rem;
  --radius-xl: 0.75rem; --radius-full: 9999px;` (4/7/9/12 px).
- Scale colors: every alias above registered as `--color-<name>` so `bg-background`,
  `text-muted-foreground`, `bg-interactive-hover`, `bg-interactive-selection`, `text-status-success`,
  `border-border`, etc. exist as Tailwind utilities.
- Spacing utilities are **overridden** to scale with `--padding-scale`:
  `--spacing-N = calc(<base>rem * var(--padding-scale, 1))` for N in
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 96
  (base value = N×0.25rem; the `5..96` integers map to `N*0.25rem` in the usual Tailwind way,
  `--spacing-14` = 3.5rem, etc.).
- Semantic spacing aliases: `--space-1/2/3/4/6/8` → the corresponding `--spacing-*` (4/8/12/16/24/32 px).
- Z scale: `--z-base: 0; --z-raised: 10; --z-overlay: 40; --z-modal: 50`.
- Motion: `--transition-fast: 150ms ease-in-out` (overridden per theme by `config.transitions.fast`).
- Fonts (`--font-sans`, `--font-mono`, `--font-heading`) default to:
  - sans: `"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
  - mono: `ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace`
  - heading: `var(--font-sans)`
- Markdown CSS variables pair with the spacing defaults: e.g. `--markdown-paragraph-spacing: 0.65rem`,
  heading margins (`0.75rem/0.35rem` primary, `0.6rem/0.3rem` secondary), `--markdown-blockquote-spacing: 0.6rem`,
  `--markdown-blockquote-padding: 0.75rem`, `--markdown-divider-spacing: 0.85rem`, `--markdown-table-spacing: 0.9rem`.

### B.3 Semantic typography (src: lib/typography.ts)

Base sizes (`SEMANTIC_TYPOGRAPHY`, one value per element family; the variable is `--text-<kebab-of-key>`):

| Key | CSS variable | Web/desktop/mobile | VS Code webview |
|---|---|---|---|
| `markdown` | `--text-markdown` | `0.875rem` | `0.8438rem` |
| `code` | `--text-code` | `0.75rem` | `0.8125rem` |
| `uiHeader` | `--text-ui-header` | `0.875rem` | `0.8438rem` |
| `uiLabel` | `--text-ui-label` | `0.8125rem` | `0.7813rem` |
| `meta` | `--text-meta` | `0.8125rem` | `0.7813rem` |
| `micro` | `--text-micro` | `0.8125rem` | `0.75rem` |
| `settingsPageTitle` | `--text-settings-page-title` | `1.0625rem` | `1rem` |

Line-height / letter-spacing / weight variables (emitted alongside by cssGenerator and
typographyWatcher; consumed via the `typography` object exported for inline styles):

- Headings h1–h6: `--hN-line-height` (h1..h2: 1.25rem; h3..h6: 1.5rem), `--hN-letter-spacing`
  (-0.025, -0.02, -0.015, -0.01, 0, 0.01 em respectively). The same values are duplicated as
  `--markdown-hN-line-height/letter-spacing`.
- UI: `--ui-button-line-height: 1.375rem`, `--ui-button-letter-spacing: 0.02em`, weight 500;
  small button line-height 1.25rem; large 1.5rem; label 1rem / 0.03em / 500; caption 1rem / 0.025em / 400;
  badge 1rem / 0.025em / 500; tooltip 1rem / 0.025em / 400; input 1.375rem / 0.02em / 400;
  helper text 1rem / 0.025em / 400.
- Markdown: body 1.5rem / 0 / 400; body-small 1.375rem; body-large 1.625rem; blockquote 1.5rem;
  list 1.375rem; link 1.5rem; code `round(1.35em, 1px)` (snapped to whole px so streamed,
  growing code never accumulates fractional line-height error); code-block 1rem.
- Code: inline 1rem; block `round(1.4rem, 1px)`; line numbers 1.25rem.
- `--ui-regular-font-weight: 400` is a global dial; some runtimes weight UI text differently through it.

`applyTypography()` in useUIStore scales the user "interface font size" setting (50–200, default
100) by setting `document.documentElement.style.fontSize = (fontSize/100)*100%` and clearing/setting
the `--text-*` variables (all authored in rem, so they inherit the root scale). The user setting
therefore scales the *entire* rem-derived UI, not just text (src: stores/useUIStore.ts:2128-2149).

### B.4 Fonts: options + loading (src: lib/fontOptions.ts, lib/fontLoader.ts, styles/fonts.ts)

Two enums of selectable fonts, each with a Tailwind font stack and a lazy-load source.

**UI font options (`uiFont` setting, default `system`)**

| id | label | stack (leading faces) | weights loaded |
|---|---|---|---|
| `inter` | Inter | `"Inter", "SF Pro Text", -apple-system, ...` | 400, 500, 600 |
| `fixel` | Fixel Text | `"Fixel Text", ...` | 400/500/600 (direct jsdelivr webfonts URLs) |
| `geist-sans` | Geist Sans | `"Geist Sans", ...` | 400, 500, 600 |
| `atkinson-hyperlegible` | Atkinson Hyperlegible | accessibility-focused | 400, 700 |
| `source-sans-3` | Source Sans 3 | `"Source Sans 3", ...` | 400, 500, 600 |
| `roboto` | Roboto | `"Roboto", ...` | 400, 500, 600 |
| `noto-sans` | Noto Sans | `Noto Sans` | 400, 500, 600 |
| `dm-sans` | DM Sans | `DM Sans` | 400, 500, 600 |
| `manrope` | Manrope | `Manrope` | 400, 500, 600 |
| `system` | System | `"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` | none |

**Mono font options (`monoFont` setting, default `system-mono`)**: `jetbrains-mono`, `fira-code`,
`geist-mono`, `commit-mono`, `source-code-pro`, `cascadia-code`, `roboto-mono`, `iosevka`
(each fontsource `@fontsource/*` package, weights 400/500/600, resolving to
`https://cdn.jsdelivr.net/npm/<pkg>/files/<prefix>-latin-<weight>-normal.woff2`) and `system-mono`
(stack `ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace`).

Loading mechanics (`fontLoader.ts`): `loadUiFont(option)` / `loadMonoFont(option)` build a
`FontFace` per weight (`display: 'swap'`), add it to `document.fonts`, and dedupe with a
`family:weight` Set + in-flight promise map. Failures are logged and the face removed. `system` /
`system-mono` have no source and resolve immediately. Store setters `setUiFont` / `setMonoFont`
apply the stack (`--font-sans` / `--font-mono`) and trigger the load (src: stores/useUIStore.ts setters).

### B.5 Motion conventions

- Token durations: `--transition-fast` (150ms), `--transition-normal` (250ms), `--transition-slow`
  (350ms, `ms ease` per theme format). Theme JSON may override all three via `config.transitions`.
- Base CSS motion: `tw-animate-css` provides `animate-in/out`, `fade-*`, `slide-*`, `zoom-*`
  utilities used by popover/dialog/menu enter-exit classes (`data-[starting-style]` /
  `data-[ending-style]` attributes on Base UI components are paired with opacity/scale transitions,
  e.g. SettingsWindow's `duration-150 ease-out` + `scale-[0.98]` overlay/popup).
- `prefers-reduced-motion` is honored throughout with `motion-reduce:transition-none` predicates in
  component classes.
- Theme switching suppresses transitions: a `.oc-theme-switching` class is added to `<html>` for two
  animation frames then removed, so color-theme flips don't animate every transition glued to
  `var(--*)` colors (src: contexts/ThemeSystemContext.tsx:67-85).
- Chat render preview in Settings animates with rAF ticks at ~420ms (pure cosmetic; not required).

---

## C. Primitive component inventory (src: packages/ui/src/components/ui/)

Every entry: what it wraps, its Variants/states, and when to use it. All read from full source
except where noted; sizes are Tailwind dimensions as authored.

### C.1 `button.tsx` — `Button`

cva-based. Base class: `rounded-[10px]`, squircle corner-shape fallback (50px where supported),
`typography-ui-label`, 500 weight, lowercase-ish tracking 0.01em, transition 150ms ease-out,
focus ring `ring-ring/50` 3px, disabled opacity-50.

| Variant | Look |
|---|---|
| `default` | Primary tint: pale primary fill (`color-mix(primary 10%, background)` in light / `transparent 16%` dark), primary text, primary 12%/20% border, hover/active steps up (16/22% light, 22/30% dark) |
| `destructive` | Same tint recipe with `--status-error` (7/9→11/16% light; 9/14→14/20% dark) |
| `info` | Same with `--status-info` (4/8→7/10% light) |
| `neutral` | `bg-interactive-hover`, border 60%, hover `bg-interactive-active` |
| `outline` | `bg-[var(--surface-elevated)]`, border-border/60, hover `bg-interactive-hover` |
| `chip` | Flat toggle chip: transparent bg, border-border/60; selected state via `aria-pressed` picks the primary tint recipe |
| `secondary` | `bg-interactive-hover` → hover `bg-interactive-active`, no border |
| `ghost` | Text-only; hover `bg-interactive-hover` |
| `link` | primary-colored, underline on hover |

Sizes: `default` h-9 px-3.5; `sm` h-8 px-2.5 (rounded 9px/50px); `xs` h-6 px-2 (micro type, 7px);
`lg` h-10 px-4 (12px); `icon` size-9. `asChild` renders the child via the Slot wrapper; default
button `type` is `"button"` (form submits are always explicit).

Use: default = primary actions; secondary = settings row action buttons (Edit); ghost = icon-only
menu/reset buttons; chip = segmented one-of-many toggles; destructive = destructive confirm;
outline = settings header action buttons (Reset all).

### C.2 `input.tsx` — `Input`; `textarea.tsx` — `Textarea`

Simple tokenized fields: `bg-input`-ish surface, `border` token, focus ring, `typography-ui`
 sizing. Used for text entry (PWA name, ssh URLs, notification templates, search). The Settings
search box is a custom inline input inside a bordered container (not `Input`).

### C.3 `number-input.tsx` — `NumberInput`

Controlled numeric stepper with `min/max/step`, keypad/typing input; `deferExternalValueWhileFocused`
keeps an external value from overwriting the field while the user types. Used by every numeric
Settings control (font sizes, spacing, input-history limit, goal budget, inputBarOffset).

### C.4 `select.tsx` — `Select` family (Base UISelect)

`SelectRoot/Trigger/Value/Content/Item` with `SETTINGS_SELECT_TRIGGER_CLASS` variants. History:
emits `SelectRootChangeEventDetails`. Used for theme pickers, locale, time format, terminal shell,
default model/variant/agent, small-model override, voice settings. Supports `disableGlobalShortcuts`
(suspends the shortcut registry while open — see I.5).

### C.5 `dialog.tsx` (Base UI Dialog), plus `SettingsWindow.tsx` (G.1), `HelpDialog`, `AboutDialog`,
`UpdateDialog`, `OpenCodeStatusDialog`, `ToolOutputDialog` (cross-ref 05). Shared popup pattern:
Portal → Backdrop (oc-glass-backdrop + black/25 in light, black/40 dark) → centered Popup with
`bg-background`, rounded-xl, transitions on start/end styles. `data-[nested-dialog-open]` dims the
parent window (brightness-0.55, dark 0.4).

### C.6 `dropdown-menu.tsx` (Base UI Menu) + `context-menu.tsx` (Base UI ContextMenu)
Styled menus; `dropdown-menu.styles.ts` holds shared class content. Menus opt into
`disableGlobalShortcuts` to suspend app shortcuts while open and translate exact `Ctrl+N/P` into
menu navigation even during IME (src: lib/shortcuts/DOCUMENTATION.md §Dispatching).

### C.7 `tooltip.tsx` — `Tooltip` (Base UI); styled `oc-glass-tooltip` surface; used around nav
buttons and settings hint icons. `SettingsInfoHint` is the settings-specific "i" hint popover.

### C.8 `switch.tsx`, `checkbox.tsx`, `radio.tsx` (Base UI) — tokenized toggles. Settings uses
`SettingsCheckboxRow`/`SettingsRadioOption` wrappers rather than raw primitives.

### C.9 Toasts: `toast.ts` wraps sonner re-exports. `success`/`info` toasts automatically get an
"OK" action; `error`/`warning` get a "Copy" action that copies message+description text to the
clipboard. `sonner.tsx` mounts the `Toaster` theme-coupled to app theme. Use for transient
feedback (copied, saved, errors with copy affordance).

### C.10 `card.tsx`, `text.tsx`, `skeleton.tsx`, `badge`-like uses, `collapsible.tsx` (Base UI
Collapsible), `slot.tsx` (composition Slot), `command.tsx` (cmdk primitives styling), `CommandPalette.tsx`
(mod+k-based palette; cross-ref 01), `JsonTreeView.tsx`/`JsonTreeViewer.tsx` (formatted JSON tool
output views), `CodeMirrorEditor.tsx` (editor host; cross-ref 06).

### C.11 Scrolling system: `ScrollShadow.tsx` + `useScrollShadow.ts` (top/bottom shadow fade),
`ScrollableOverlay.tsx` (scroll container with overflow overlay used by Settings panes),
`OverlayScrollbar.tsx` (styled overlay scrollbars honoring `--oc-scrollbar-thumb*` and the
`alwaysShowScrollbars` device setting), `MobileOverlayPanel.tsx` (mobile slide-over).

### C.12 Misc: `ErrorBoundary.tsx` (wraps every Settings page and major view; renders fallback and
keeps the rest of settings alive), `ConfigUpdateOverlay.tsx` (harness config-write progress overlay
driven by `lib/configUpdate.ts` listener state), `ContextUsageDisplay.tsx`, `ProviderLogo.tsx` +
`providerLogoFallback.ts` (provider logo `<img>` with letter fallback), `OpenChamberLogo.tsx`,
`FireworksAnimation.tsx`, `MemoryDebugPanel.tsx`, sortable session tabs wrapper
(`sortable-tabs-strip.tsx`, cross-ref to dnd-kit usage), `HelpDialog.tsx` (shortcut help sheet,
reads shortcut schema metadata).

### C.13 Glass surfaces (src: styles/design-system.css @layer components)

- `.oc-glass-popover` / `.oc-glass-tooltip` / `.oc-glass-panel` / `.oc-glass-composer`: translucent
  surface classes. Formula: `background-color: color-mix(in srgb, var(--oc-glass-color) <opacity>,
  transparent)` + `backdrop-filter: blur(var(--oc-glass-blur)) saturate(var(--oc-glass-saturation))`.
  Tints per class: popover/tooltip `--surface-elevated` at popover/tooltip opacity; panel `--surface-muted`
  at panel opacity; composer `--surface-subtle` at popover opacity.
- `.oc-glass-floating`: multi-layer inset/outer shadow stack (authored lists for light and `dark`).
- `.oc-glass-backdrop`: 4px blur for dialog backdrops.
- Fallbacks: `@supports not (backdrop-filter: blur(1px))` → opaque `--oc-glass-color`;
  `@media (prefers-reduced-transparency: reduce)` → opaque as well.

### C.14 Agent color classes (src: App-side agentColors + design-system.css)

`AGENT_COLOR_PALETTE` in `lib/agentColors.ts`: slot 0 is `agent-success` (used for `undefined`,
missing, or the literal agent name `build`); every other name maps by hashing the string
(`(hash << 5) - hash`, 32-bit wrap) onto slots 1..7: `agent-keyword, agent-type, agent-function,
agent-number, agent-info, agent-warning, agent-variable`. CSS classes (design-system.css) map each
class name to `--agent-color` + `--agent-color-bg` from the corresponding token
(`--status-success`, `--syntax-keyword`, `--syntax-type`, `--syntax-function`, `--syntax-number`,
`--status-info`, `--status-warning`, `--syntax-variable`). Consumers: `.agent-badge` (10%/20% tinted
bg+border, hover 15/30%), `.agent-dot`, `.agent-list-item` hover/active tints. Deterministic per
agent name session-to-session; the hashing is part of the visual contract (same name = same color).

---

## D. Icon system

### D.1 App icon sprite (src: components/icon/*, scripts/generate-icon-sprite.mjs)

- Architecture: one runtime-injected hidden `<svg id="openchamber-icon-sprite">` holding
  `<symbol id="oc-<name>" viewBox="0 0 24 24">` entries. `Icon` renders
  `<svg class="remixicon ..." viewBox="0 0 24 24" aria-hidden><use href="#oc-<name>"/></svg>`.
  The sprite is injected on first `Icon` render (synchronously in render, before any `<use>`
  resolves). If a late-registered icon is missing from the injected snapshot, `ensureSpriteSymbol`
  appends just that symbol (HMR/regeneration path). `Icon` is `React.memo` and holds no props
  except `name` + passthrough svg props/className; **there is no size prop — size only via
  Tailwind classes (h-4 w-4, size-5, h-6 w-6)**.
- `sprite.ts` is generated (do not hand-edit): `bun run icons:sprite` → `scripts/generate-icon-sprite.mjs`.
- Name derivation: `RiArrowDownSLine` → `arrow-down-s` (strip `Ri`, drop trailing `Line`,
  camel→kebab, digits preserved: `RiChat4Line` → `chat-4`). When both Line and Fill variants exist
  under one kebab name, the Line variant wins (`github` → RiGithubLine). `IconName` type in
  `icons.ts` is generated from the sprite keys, so `<Icon name="...">` is compile-time checked.
- Scanner (the script's behavior, required for parity): scans all `packages/ui/src/**/*.{ts,tsx}`
  for (a) `Ri*` identifiers, (b) `name="kebab"` on `<Icon>`, (c) `icon: 'kebab'` / `Icon='kebab'`
  object keys and JSX props, (d) string literals returned from `function ...: IconName` bodies,
  (e) keys inside `Record<...,IconName>` literals, (f) literal/branch literals assigned to variables
  named `*IconName`. Warns on unknown names instead of failing.
- Custom glyphs registered in the script, 24x24 viewbox, `currentColor` (fill or stroke) so they
  inherit theme color and remix sizing: `openchamber` (product mark), `command-code` (Command Code
  mark), `linear` (Linear logo silhouette), `cloudflare` (Cloudflare silhouette). Names are used
  like any kebab name (`<Icon name="openchamber">`).
- Regeneration flow: add usage → run `bun run icons:sprite` → sprite.ts and icons.ts regenerate →
  commit. Unknown name at build = warning; unknown name at runtime = empty `<use>` (no crash).

### D.2 Ad-hoc icon components (src: components/icons/)

Standalone full-SVG components outside the sprite: `McpIcon` (MCP mark; used as the MCP settings
nav icon), `StopIcon`, `FusionIcon`, `DiffIcon`, `ArrowsMerge`, `FileTypeIcon` (see D.3). Use for
multi-color or composite marks that cannot ride `currentColor`.

### D.3 File-type icons (src: lib/fileTypeIcons.ts, lib/fileTypeIconIds.ts, assets/icons/file-types/, scripts/generate-file-type-sprite.mjs)

- Source assets: individual SVG files in `packages/ui/src/assets/icons/file-types/*.svg`
  (VS Code-style product/color icons; names like `typescript.svg`, `typescript_light.svg`, ...).
- Generation: `bun run scripts/generate-file-type-sprite.mjs` reads every `.svg` except the output,
  strips the XML declaration, extracts viewBox (default `0 0 24 24`), rewrites inner `id`/`href`/
  `url(#...)` references by prefixing with `<iconId>__` to avoid collisions, and writes a single
  `sprite.svg` of `<symbol>` entries plus `lib/fileTypeIconIds.ts` exporting the full id set
  (`FILE_TYPE_ICON_IDS`). Symbols default color and `_light` variants: for every base icon without
  an explicit `<id>_light` file, a light variant symbol is synthesized as `<use href="#<baseId>"/>`.
- Mounting: importing `fileTypeIcons.ts` injects the sprite content into a hidden
  `<div id="oc-file-type-icon-sprite-root">` appended to `<body>` on module load (or on
  DOMContentLoaded).
- Resolution (`getFileTypeIconHref(filePath, {extension, themeVariant}) → "#<id>"`, default
  themeVariant `dark`):
  1. **Whole-file-name map** (lowercased): `dockerfile→docker`, `makefile→makefile`,
     `gnumakefile→makefile`, `cmakelists.txt→cmake`, `package-lock.json→npm`, `yarn.lock→yarn`,
     `pnpm-lock.yaml→pnpm`, `bun.lock→bun`, `bun.lockb→bun`, `tsconfig.json→tsconfig`,
     `jsconfig.json→jsconfig`, `.gitignore/.gitattributes/.gitmodules→git`, `.editorconfig→editorconfig`,
     `.npmrc→npm`, `.yarnrc→yarn`, `.prettierrc→prettier`, `.eslintrc→eslint`, `.babelrc→babel`;
     any basename starting `.env` → `settings`.
  2. **Language map** (via the shared extension→language helper, then): javascript→javascript,
     jsx→react, typescript→typescript, tsx→react_ts, html→html, handlebars→handlebars, twig→twig,
     liquid→liquid, css→css, scss/sass→sass, less→less, stylus→stylus, json→json, yaml→yaml,
     toml→toml, xml→xml, ini/properties→settings, bash→console, powershell→powershell,
     batch→console, python→python, ruby/erb→ruby, php→php, java→java, kotlin→kotlin, scala→scala,
     groovy→groovy, c→c, cpp→cpp, objectivec→objective-c, csharp→csharp, fsharp→fsharp, go→go,
     rust→rust, swift→swift, dart→dart, lua→lua, perl→perl, r→r, julia→julia, haskell→haskell,
     elixir→elixir, erlang→erlang, clojure→clojure, lisp→lisp, scheme→scheme, ocaml→ocaml,
     reason→reason, nim→nim, zig→zig, v→vlang, crystal→crystal, d→d, sql→database, graphql→graphql,
     solidity→solidity, nasm→assembly, nix→nix, hcl→terraform, puppet→puppet, latex→tex,
     bibtex→bibliography, markdown→markdown, asciidoc→asciidoc, text→document, vim→vim,
     makefile→makefile, cmake→cmake, diff→diff, prisma→prisma, protobuf→proto, thrift→document,
     wasm→webassembly, glsl/hlsl/cg→shader, apacheconf→settings, nginx→nginx.
  3. **Extension map**: yml→yaml, mdx→mdx, md→markdown, lock→lock, env→settings, zip/tgz/gz/rar/7z→zip,
     png/jpg/jpeg/gif/webp/avif/bmp→image, svg→svg, ico→favicon, mp3/wav/flac/ogg→audio,
     mp4/mov/avi/mkv/webm→video, pdf→pdf, doc/docx→word, ppt/pptx→powerpoint.
  4. Extension, if present directly in `FILE_TYPE_ICON_IDS`, is used as the icon id.
  5. Fallback `document` (light variant `document_light`).
- Variant selection: light theme requests `<base>_light` when it exists (id set check), else base;
  dark theme uses base. Consumers render `<svg><use href="#<id>"/></svg>` (per FileTypeIcon.tsx and
  tool-card wrappers; show/hide controlled by the `showToolFileIcons` setting — see F registry).

---

## E. Theme system pipeline

### E.1 Active-theme model (src: contexts/ThemeSystemContext.tsx)

- `Theme` type (src: types/theme.ts): `metadata {id, name, description, author?, version, variant:
  'light'|'dark', tags[]}`; `colors { primary, surface, interactive, status, pr?, syntax,
  header?, sidebar?, chat?, markdown?, tools?, forms?, buttons?, modal?, popover?, commandPalette?,
  fileAttachment?, sessions?, modelSelector?, permissions?, loading?, scrollbar?, badges?, toast?,
  emptyState?, table?, charts?, a11y?, shadows?, animation? }`; `config? {fonts, spacing, transitions}`.
  Only the bolded groups are consumed by the generator; the rest are optional, forward-compatible
  decorations most built-ins fill with `Record<string,string>` shapes.
- The user picks **a mode** (`themeMode`: `system` | `light` | `dark`) plus **two theme ids**
  (`lightThemeId`, `darkThemeId`). Effective `currentTheme = vscodeTheme? (VS Code only) : theme of
  (mode=='light' ? lightThemeId : mode=='dark' ? darkThemeId : systemPrefersDark ? darkThemeId : lightThemeId)`.
- Defaults: `DEFAULT_LIGHT_THEME_ID = 'openchamber-light'`, `DEFAULT_DARK_THEME_ID = 'openchamber-dark'`;
  legacy ids `app-light`/`app-dark` alias to `flexoki-light`/`flexoki-dark` (src: themes/index.ts).
  Mode default is `system` unless stored/embedded says otherwise. On `system`, `prefers-color-scheme`
  is live-listened (unless the webview is theme-synced from a parent, E.5).
- Each theme JSON is wrapped by `withPrColors(theme)` which fills `colors.pr` when absent:
  open=success, draft=mutedForeground, blocked=warning, closed=error, merged=first non-empty of
  syntax tokens `className, enum, variableGlobal` else `base.keyword`, else `#8957e5` (dark) /
  `#8250df` (light) (src: themes/prColors.ts).

### E.2 Built-in theme list (src: lib/theme/themes/)

38 built-ins, order matters only for fallback display: `openchamber-light|dark` (brand defaults),
`flexoki-light|dark`, then presets in this registration order: `fields-of-the-shire-*`, `aura-*`,
`ayu-*`, `carbonfox-*`, `catppuccin-*`, `dracula-*`, `gruvbox-*`, `jetbrains-*`, `kanagawa-*`,
`monokai-*`, `nightowl-*`, `nord-*`, `onedarkpro-*`, `solarized-*`, `tokyonight-*`, `vesper-*`,
`mono-plus-*`, `mono-*`, `vitesse-dark-dark` (sic: file id vitesse-dark), `vitesse-light-light`.
All are JSON modules imported statically; every preset passes through `withPrColors`.
`getThemeById(id)` resolves with the alias map; `getDefaultTheme(prefersDark)` returns the
matching-variant default, else the first theme of that variant, else flexoki-light.

### E.3 Preference persistence and scoping

- **Per-runtime scoped localStorage entry** (src: contexts/theme-storage.ts): key
  `openchamber.theme.v2:<encodeURIComponent(runtimeKey)>` holding `{themeMode, lightThemeId,
  darkThemeId}` (validated on read; malformed = null = keep current/seed). Retention is unbounded
  (~150 B/entry). `runtimeKey` identifies which server instance this window talks to (from
  `lib/runtime-switch`), so windows pointed at different instances never share theme state.
  Transient runtime keys (initial connection) never read/write this key.
- Legacy global keys are a one-time seed only if the scoped key is missing: `themeMode`,
  `useSystemTheme`, `selectedThemeId`, `selectedThemeVariant`, `lightThemeId`, `darkThemeId`.
  They must keep being written (see E.4) because splash shells and the Android status bar read them.
- Server-side profile fields: `themeId`, `useSystemTheme`, `themeVariant` (derived), `lightThemeId`,
  `darkThemeId` are registry settings (`profile`, `perSurface: true` — see F) synced via settings;
  a **bootstrap-grade** settings sync (first load per runtime) adopts the server's theme into local
  preferences; mid-session save echoes must not (flag `adoptTheme` differentiate).
- Cross-window same-origin adoption: a `storage` event on the scoped key re-resolves and applies the
  stored prefs of the same runtime (identity check prevents loops) (src: theme-storage.ts
  `resolveThemePreferencesFromStorageEvent`).
- Write intent flag: only user-reached handlers (`setTheme`, `setThemeMode`, `setSystemPreference`,
  set light/dark) raise `themeWriteIntentRef`; the persist effect PUTs the theme fields
  (`{themeId, themeVariant, useSystemTheme, lightThemeId, darkThemeId}`) only under intent. Mounts,
  endpoint switches, OS flips, and settings syncs never write (guards the classic flip-flop bug).
- Splash cosmetics: the window also mirrors `themeMode/lightThemeId/darkThemeId/useSystemTheme/
  selectedThemeId/selectedThemeVariant/splashBgLight/splashFgLight/splashBgDark/splashFgDark`
  into localStorage for pre-React splash shells (packages/web/index.html, mobile.html,
  mini-chat.html) and desktop `setDesktopWindowTheme` IPC ships the same four colors to the shell.
- VS Code webview: theme comes from the extension host observer
  (`window.__OPENCHAMBER_VSCODE_THEME__` seed + `openchamber:vscode-theme` events; adaptive payload
  built by `lib/theme/vscode/adapter.ts` which maps the host's current color theme into a full
  Theme object, tinting from VS Code token colors). VS Code hides all theme pickers and pins
  tighter typography (B.3).

### E.4 Application mechanics (per theme change)

1. `CSSVariableGenerator.apply(theme)` regenerates and swaps the single theme style element.
2. `html.classList` swapped to the theme's variant only (`light`/`dark`), `data-theme` set.
3. `oc-theme-switching` class suppresses transitions for two rAFs (B.5).
4. Unless the window is an embedded iframe receiving parent theme sync
   (`receivesParentThemeSync`), publish the full theme object as an embedded bootstrap (for iframes
   spawned later) and write the splash/localStorage mirror (E.3).
5. `updateBrowserChrome`: `<body>` background = `surface.background`; `<meta name="theme-color">`
   (plain + media-matched variant both updated).
6. `vscode-runtime` class toggled on/off per detection.
7. On endpoint change (`subscribeRuntimeEndpointChanged`): reload custom themes from the new
   instance, adopt its scoped storage prefs, refine from its server settings sync.

### E.5 Embedded/iframe theme sync

A webview iframe (chat embeds) opened with theme URL search params (`themeMode`, `lightThemeId`,
`darkThemeId`) treats the parent as the theme authority: it does not persist, does not listen to
`prefers-color-scheme` or `storage`, and instead exposes
`window.__openchamberApplyThemeSync(payload)` plus an `openchamber:theme-sync-request` postMessage
handshake. Parent sends `{type:'openchamber:theme-sync', payload:{themeMode, lightThemeId,
darkThemeId, currentTheme}}` (same-origin postMessage only). The iframe adopts the *full theme
JSON* (`currentTheme`) as an override theme so an iframe can render a theme its own build doesn't
ship. (src: contexts/theme-embedded-bootstrap.ts, theme-sync-payload.ts, ThemeSystemContext.tsx)

### E.6 Custom themes (src: docs/CUSTOM_THEMES.md, contexts/ThemeSystemContext.tsx)

- Storage: JSON files in `~/.config/openchamber/themes/` (the OpenChamber config directory's
  `themes/` subdirectory). Loaded by the **server** via GET `/api/config/themes` →
  `{themes: Theme[]}`; UI filters each through `isValidTheme` (see below). No app restart;
  **Settings → Appearance → Reload themes** refetches (button with 500ms minimum spinner).
- Validation (`isValidTheme`, src: contexts/theme-validation.ts): requires non-empty strings at
  `metadata.id`, `metadata.name`, `metadata.variant`; `colors.primary.base`,
  `colors.primary.foreground`; `colors.surface.{background,foreground,muted,mutedForeground,
  elevated,elevatedForeground,subtle}`; `colors.interactive.{border,selection,selectionForeground,
  focusRing,hover}`; all 16 `colors.status.*` fields (error/warning/success/info × value/
  foreground/background/border); all 10 `colors.syntax.base.*`; and `colors.syntax.highlights.
  {diffAdded,diffRemoved,lineNumber}`. `variant` must be exactly `light` or `dark`. Server also
  enforces: file size ≤ 512KB, non-duplicate id (duplicates skipped w/ console warning), missing
  required fields = skip.
- Surface alpha requirement: `colors.surface.muted` and `colors.surface.elevated` use 8-digit hex
  ending `90` (90/255 alpha).
- **The exact theme file format** (transcribed from docs/CUSTOM_THEMES.md; this is the interchange
  contract). Top level: `{metadata, colors, config}`. `colors.primary` may include base (required),
  hover/active/foreground/muted/emphasis (optional; defaults derived by the generator:
  hover=darken10, active=darken20, foreground=#fff, muted=50% alpha, emphasis=lighten10).
  `colors.surface` (required): background, foreground, muted, mutedForeground, elevated,
  elevatedForeground, overlay, subtle. `colors.interactive` (required): border, borderHover,
  borderFocus, selection, selectionForeground, focus, focusRing, cursor, hover, active.
  `colors.status` (required): {error,warning,success,info}×{value, foreground, background, border}
  naming convention: `error`, `errorForeground`, `errorBackground`, `errorBorder`, etc.
  `colors.pr` (optional): open, draft, blocked, merged, closed.
  `colors.syntax.base` (required): background, foreground, comment, keyword, string, number,
  function, variable, type, operator. `colors.syntax.tokens` (optional, free record of
  camelCase→hex; generator maps each to `--syntax-<kebab>`): known keys include commentDoc,
  stringEscape, stringInterpolation, stringRegex, keywordControl, keywordOperator, keywordImport,
  keywordReturn, functionCall, functionBuiltin, method, methodCall, variableBuiltin,
  variableProperty, variableReadonly, parameter, typePrimitive, typeInterface, className, enum,
  boolean, null, constant, punctuation, delimiter, bracket, tag, tagAttribute, tagAttributeValue,
  tagBracket, decorator, annotation, namespace, module. `colors.syntax.languages` (optional
  record of language→record of color overrides). `colors.syntax.highlights` (required by
  validation diff-wise): diffAdded, diffAddedBackground, diffRemoved, diffRemovedBackground,
  diffModified, diffModifiedBackground, lineNumber, lineNumberActive.
  `colors.markdown` (optional): heading1, heading2, heading3, heading4, link, linkHover, inlineCode,
  inlineCodeBackground, blockquote, blockquoteBorder, listMarker (+bold, italic, strikethrough, hr
  consumed by generator even though the sample omits them), plus optional `chat.background` may
  back inline code bg. `colors.chat` (optional): userMessage, userMessageBackground,
  assistantMessage, assistantMessageBackground, timestamp, divider, typing, background.
  `colors.tools` (optional): background, border, headerHover, icon, title, description, and
  `edit {added, addedBackground, removed, removedBackground, modified, modifiedBackground,
  lineNumber}` (+ optional `bash`/`lsp` decorative). `colors.loading` (optional): spinner,
  spinnerTrack. `colors.charts.series` (optional array of hex → `--chart-N`).
  `config.fonts {sans, mono, heading}`; `config.transitions {fast: "150ms ease", normal:
  "250ms ease", slow: "350ms ease"}`; `config.spacing {xs..xl}` (declared but only documented in
  type; not consumed by the generator).
  Example metadata from the sample: id `my-custom-theme`, name `My Custom Theme`, description,
  version `1.0.0`, variant `dark`, tags array. Sample radius block in `config` (none/sm/md/lg/xl/full
  string values) exists in docs but the generator only emits fonts+transitions today — treat radius
  overrides as forward-compatible input, not part of the rendered token set.
- Import UX: Settings → Appearance shows theme dropdowns per variant + "Reload themes" action +
  hint text pointing at `~/.config/openchamber/themes/`. There is NO in-app upload; file drop is
  the integration path (cross-ref 09 says desktop shares this page in-window).
- Development HMR: Vite pipes `openchamber:theme-hmr` CustomEvents carrying theme JSON so built-in
  JSON edits apply live without reload (validated before adoption).

### E.7 themes port script (src: scripts/port-opencode-theme.ts; root package.json script
`themes:port:opencode`)

Offline maintainer tool: converts OpenCode desktop/TUI themes (or existing OpenChamber files) into
complete OpenChamber theme JSONs ready to register in `presets.ts`. Usage:
`--list` (enumerate known sources), `<ids...> [--force]`, `--out-dir <dir>`, `path/to/theme.json
--stdout`. Fills the full schema (solid surfaces, interactive, syntax, tokens) from a small palette
of seeds (`neutral, primary, success, warning, error, info, interactive, diffAdd, diffDelete`) or a
desktop palette. A cleanroom does not need this unless it imports upstream themes; port the
concept: name→seed mapping, explicit full-schema coverage, no half-mapped tokens.

### E.8 Downstream theme consumers (couplings)

- **Shiki / CodeMirror** (cross-ref 06): `lib/shiki/appThemeRegistry.ts` converts the active Theme
  into a VS Code TextMate theme (`textMateThemeFromAppTheme.ts`), caches up to 40 resolved themes
  keyed by `JSON.stringify(theme)` content signature, gives the object a stable `toString` of the
  id, and registers it with `@pierre/diffs` (`registerCustomTheme`), invalidating on content
  change under the same id. `bg`/`fg` come from `editor.background/foreground` with 8-digit alphas
  stripped. If both registered app themes change, syntax themes follow automatically — no user
  setting couples editor highlighting to the theme (editor *font size* and keymap are separate
  settings).
- **Terminal** (cross-ref 07): `lib/terminalTheme.ts` `convertThemeToXterm(theme)` maps:
  background=`surface.background`; foreground=`syntax.base.foreground`; cursor=`interactive.cursor`;
  cursorAccent=`surface.background`; selectionBackground=`interactive.selection`; selection inactive
  = selection + '50'; ANSI 16: black=`surface.muted`, red=`status.error`, green=`status.success`,
  yellow=`status.warning`, blue=`syntax.base.function`, magenta=`syntax.base.keyword`,
  cyan=`syntax.base.type`, white=`syntax.base.foreground`, brightBlack=`syntax.base.comment`,
  brightRed/Green/Yellow = status trio again, brightBlue/Magenta/Cyan = function/keyword/type
  again, brightWhite=`surface.elevatedForeground`. `toGhosttyTheme` re-parses to RGB channels
  (fallback white-on-black per channel on malformed theme colors) for the ghostty wasm renderer.
- **Diff viewer** (@pierre/diffs): DiffWorkerProvider registers both flagged default themes at
  startup and the active pair; cross-ref 05 covers diff rendering.
- **Markdown** (cross-ref 05): uses `--markdown-*` tokens + `getDefaultTheme` for shiki worker theming.
- **Splash**: desktop main process stores `{bgLight,fgLight,bgDark,fgDark}` via window-theme IPC
  (cross-ref 09) for native splash painting; web splash shells read localStorage splash keys.

---

## F. Settings system architecture (src: packages/ui/src/lib/settings/*, lib/persistence.ts)

### F.1 Concept

One registry table (`SETTINGS_REGISTRY`, src: lib/settings/registry.ts) names every setting: its
key, `scope`, boundary parser, optional store binding (`ui`), and flag markers. Everything else
derives from it: the `DesktopSettings` type, the client sanitizer, the offline mirror, the store
apply step, the store-subscribing auto-saves, and — via the generated JSON snapshot
(`settings-registry.json`) — the server's and the VS Code bridge's key gates. **A key that is not
in the registry does not persist.**

### F.2 Scopes and markers

- `scope`: `instance` (fact about the machine the server runs on; never synced to *other* clients,
  never edited by other windows), `profile` (the person's preference; synced to every client of the
  instance), `device` (state of this install/surface; never crosses the wire).
- `perSurface: true` — profile field stored per surface kind. The fixed owner-chosen set: theme
  ids/mode (`themeId, useSystemTheme, lightThemeId, darkThemeId`), chat-layout switches
  (`streamingAutoFollowEnabled, stickyUserHeader, promptNavigatorEnabled, wideChatLayoutEnabled`),
  and typography sizes (`fontSize, terminalFontSize, editorFontSize, padding, cornerRadius`).
  Writes carry `?surface=<kind>` as a **query parameter** (`surface.ts`: `vscode`, `desktop`,
  `mobile` for the Capacitor app AND hosted mobile shell, else `web`); the server stores values
  under `fields[key].surfaces[<kind>]` (kind value never written to the base). A query param, not a
  header, keeps the request CORS-simple for the cross-origin desktop shell and phone and works
  against older instances. Reads resolve kind → base → absent ("missing is not default").
- `adopt: 'bootstrap-only'` — workspace pointers (`lastDirectory`, `activeProjectId`) only applied
  from a bootstrap-grade sync, never from a mid-session echo (one window must not hijack another's
  live navigation).
- `derived: true` — `themeVariant` only; computed by the writer from mode+system, sent but not
  user-settable.
- `secret: true` — accepted on write, never returned: `desktopUiPassword`,
  `managedRemoteTunnelToken`, `managedRemoteTunnelPresetTokens`.
- `computed: true` — server-emitted for this build/process, never persisted, never accepted on
  write: `hasDesktopUiPassword`, `desktopLanAccessActive`, `desktopLanAccessBlockedReason`,
  `agentMemoryFeatureAvailable`.
- `surfaces: [...]` — the field exists only on those surfaces (desktop-only window controls,
  web-only PWA fields, mobile-only keyboard mode, etc.).

### F.3 Persistence engine (src: lib/persistence.ts)

- **Two files on the instance** (server-owned machinery, cross-ref 02): `settings.json` (instance
  facts + legacy keys + a mirrored copy of profile base values for rollback) and `preferences.json`
  beside it holding every profile key as `{value, updatedAt}` (`version: 1`). The server and the
  VS Code host seed `preferences.json` once from `settings.json`, keep the mirror copy in
  `settings.json` on every write (pre-split builds read only that file; current builds prefer
  `preferences.json`), and never touch an unparseable `preferences.json`. Clients see one merged
  document; they never address the files. Server modules reading a profile key off disk use
  `readMergedSettingsSync`.
- **GET** `/api/config/settings?surface=<kind>` (or the runtime settings API when one is
  registered — the VS Code bridge injects one): parsed by `parseSettingsDocument` → unknown keys
  dropped, invalid values dropped **as if absent** (never replaced by defaults). Cached 2000 ms
  (`SETTINGS_CACHE_TTL`) with in-flight dedup to absorb the startup burst.
- **PUT** debounced 200 ms (`SETTINGS_DEBOUNCE_MS`). `updateDesktopSettings(changes)`:
  1. drop non-writable keys (`computed`, `device` scope);
  2. drop keys whose value equals the last-known server value (`_serverKnownSettings`) — this makes
     store-adopted values echo-free;
  3. merge into the pending buffer (a toggle back to the server's value inside the window cancels
     that key's pending write);
  4. flush at timer expiry, or immediately at lifecycle boundaries: `pagehide`, `beforeunload`,
     `visibilitychange→hidden`, document `freeze`, Capacitor `appStateChange(inactive)`, and
     runtime-endpoint-Will-Change — with `fetch(..., {keepalive:true})` so the write survives
     teardown (payloads are small; `sendBeacon` cannot carry the auth header, so it is not used).
- Save-state indicator: `getSettingsSaveState` (`idle|saving|error`) with listeners + a
  `openchamber:settings-save-state` CustomEvent; `error` auto-resets after 6 s. Success renders
  nothing (quiet indicator). Pages persisting through their own APIs report via
  `reportSettingsSaveState`.
- Mutations-in-flight reconciliation (`SettingsMutationTracker`): while a GET/PUT runs, local
  changes are recorded with revisions; responses are overlaid with any pending buffer and reconciled
  with mutations newer than the operation, so a racing fetch cannot briefly revert edits.
- `openchamber:settings-synced` CustomEvent carries `{settings, bootstrap, adoptTheme}` on every
  apply; theme (E.3) and workspace-pointers adopt only when their grade flag is true.
- **Browser mirror**: after every sync, `MIRRORED_KEYS` (all server-owned keys minus secret/computed
  and all device keys) are written to `openchamber.settingsMirror.v2:<runtimeKey>`; an index key
  caps the mirror at the 5 most recent runtimes (older mirrors evicted). Device keys
  (`device` scope) present in an old server document are applied **once** per runtime as a seed
  (`openchamber.deviceSeeded.v1:<runtimeKey>` timestamp marker in localStorage) and ignored after.
- Extra localStorage mirrors the server document seeds (all keyed, removed when absent):
  `lastDirectory`, `homeDirectory` (+ `window.__OPENCHAMBER_HOME__`), `projects`,
  `activeProjectId`, `pinnedDirectories`, `oc.sessions.projectCollapse` (from
  `projects[].sidebarCollapsed`), `gitmojiEnabled`, `directoryTreeShowHidden`,
  `filesViewShowGitignored`, `openInAppId`, `openchamber.pwaName`, mobile keyboard mode,
  `opencode-update-toast-dismissed-version`, `dictationEnabled`, `sttProvider` (only for
  `local|openai-compatible`), `sttServerUrl`, `sttModel`, `sttLocalModel`, `sttLanguage`, plus the
  theme mirror above.
- Zustand persist hydration ordering: store-apply waits for `useUIStore` (persist name `ui-store`,
  **version 21**) and `useSessionDisplayStore` hydration before writing, so hydration can't
  overwrite just-applied server values.
- Auto-save watchers (store → server, no UI involvement):
  - `appearanceAutoSave.ts`: on any `useUIStore` change, diffs the registry's `AUTO_SAVE_KEYS`
    (every registry key bound with `autoSave: true`) and PUTs the diff. While
    `isApplyingServerSettings()` is true the change is adoption → adopters become the new baseline,
    not a write.
  - `modelPrefsAutoSave.ts`: six model-preference keys (`favoriteModels`, `hiddenModels`,
    `collapsedModelProviders`, `recentModels`, `recentAgents`, `recentEfforts`) are
    `autoSave: false` in the registry and have their own subscriber with a **1200 ms** debounce,
    structural equality checks, first-change skip, and runtime-key pinning (runtime switch drops
    the pending write and the baseline).
- Config-store keys (`messageStreamTransport`, stt fields, `dictationEnabled`) bind through
  `configField` with `autoSave: false` because the config store's own setters call
  `updateDesktopSettings` themselves.
- `loadDesktopSettings()` = cached fetch for pages that need a field no store carries; **null means
  load failure, never an empty document**.

### F.4 Registry snapshot generation and gates

- `registry-snapshot.ts` renders `{version: 1, fields: Record<key, {scope, perSurface?, surfaces?,
  adopt?, derived?, secret?, computed?, local?, owner?}>}` and writes BOTH checked-in copies:
  `packages/web/server/lib/opencode/settings-registry.json` and
  `packages/vscode/src/settings-registry.json`. Command: `bun run settings-registry:generate`
  (root package.json). `registry.test.ts` fails when a checked-in copy is stale — the test is the
  regenerate gate.
- `LOCAL_DEVICE_KEYS` (device fields that only ever lived in useUIStore's persisted slice; snapshot
  emits `{scope:'device', local:true}`): `theme, isSidebarOpen, sidebarWidth,
  contextPanelByDirectory, contextRailOrder, contextRailHiddenSurfaces, contextEditorTreeVisible,
  contextEditorTreeWidth, notesPanelHeight, workStatusExpandedSections, workStatusScrollTop,
  isSessionSwitcherOpen, sidebarSection, settingsPage, settingsHasOpenedOnce,
  settingsProjectsSelectedId, settingsRemoteInstancesSelectedId, isSessionCreateDialogOpen,
  autoDeleteLastRunAt, messageLimit, walkthroughTocWidth, linearIssueListStatus,
  linearIssueListAssignee, linearIssueListTeamIdByRuntime, linearIssueListPriority,
  showTerminalQuickKeysOnDesktop, dockBadgeEnabled, alwaysShowScrollbars, agentMemoryViewedAt,
  projectContextSidebarWidth`.
- `DESKTOP_SHELL_KEYS` (instance facts the Electron main writes straight into `settings.json` via
  `mutateSettingsRoot`; snapshot emits `{scope:'instance', owner:'desktop-shell',
  surfaces:['desktop']}`; clients never read or send them): `desktopSplashColors, desktopHosts,
  desktopDefaultHostId, desktopInstallId, desktopLocalPort, desktopSshInstances, desktopWindowState`.
- **VS Code gate** (cross-ref 10): `packages/vscode/src/settings-registry-gate.ts` consumes the
  snapshot (`filterPersistableSettingsChanges`, `withoutSecretSettings`); keys the registry does
  not list, or that are `computed`, `local`, or `owner: desktop-shell`, never reach the shared
  settings files. The server applies the same snapshot logic server-side. This is why the
  regeneration step is mandatory after every registry edit.
- **HARNESS PORT**: several keys are facts about or writes into the agent harness (the OpenCode
  replacement): providers/models config is edited on Settings → Providers (not via this registry —
  it is the harness config API; cross-ref 02); registry keys that *describe* harness behavior:
  `defaultModel, defaultVariant, defaultAgent, smallModelUseDefault, smallModelOverride,
  walkthroughModelOverride, defaultGitIdentityId, opencodeBinary, permissionAutoAccept,
  autoCreateWorktree, globalBehaviorPrompt, responseStyle*, optimizeSystemPrompt, gitmojiEnabled,
  openCodeUpdateToastDismissedVersion`. A rebuilt harness must accept these as server settings
  documents, not as part of the UI state layer (see the defaults page G.5 for which surface writes
  them).

### F.5 Registry inventory (complete, ordered as authored; parse constraint notes inline)

Legend after each key: `[scope; flags; binding]`. Types: `bool` boolean; `str` non-empty string;
`strT` trimmed string; `int` integer; `num` finite number; `set` list/dedup; `oneof` enumeration.

**Theme (profile, perSurface except themeVariant-derived)**
- `themeId` [profile, perSurface, str] — legacy single-theme id (kept in sync with the mode pair)
- `useSystemTheme` [profile, perSurface, bool] — mode==system
- `themeVariant` [profile, derived, oneof light/dark] — derived; never user-set
- `lightThemeId`, `darkThemeId` [profile, perSurface, str]

**Workspace & instance facts** — `lastDirectory` [instance, bootstrap-only, str],
`homeDirectory` [instance, str], `opencodeBinary` [instance, strT], `projects`
[instance, ProjectEntry[]], `activeProjectId` [instance, bootstrap-only, str],
`securityScopedBookmarks` [instance, desktop-only, str set], `pinnedDirectories` [instance, set],
`desktopLanAccessEnabled` [instance, desktop, bool], `desktopKeepAwakeEnabled` [instance, desktop,
bool], `desktopMinimizeToTrayEnabled` [instance, desktop, bool],
`desktopMacMenuBarEnabled` [instance, desktop, bool], `desktopUiPassword` [instance, desktop,
secret, strT (empty string clears)], `hasDesktopUiPassword` [instance, desktop, computed, bool],
`desktopLanAccessActive` [instance, desktop, computed, bool],
`desktopLanAccessBlockedReason` [instance, desktop, computed, strT], `githubClientId`
[instance, str (non-empty trimmed)], `githubScopes` [instance, str],
`skillCatalogs` [instance, SkillCatalogConfig[]], `defaultGitIdentityId` [instance, strT],
`permissionAutoAccept` [instance, `{sessions: Record<string,bool>, revision: int>=0}`],
`agentControlToolEnabled` [instance, bool, uiStore], `agentWebToolEnabled` [instance, bool, uiStore],
`agentMemoryToolEnabled` [instance, bool, uiStore], `agentMemoryFeatureAvailable` [instance,
computed, bool, uiStore readOnly], `openCodeUpdateToastDismissedVersion` [instance, strT ≤128],
`autoDeleteEnabled` [instance, bool, uiStore], `autoDeleteAfterDays` [instance, int 1..365, uiStore],
`sessionRetentionOnlyArchived` [instance, bool, uiStore], `sessionRetentionAction` [instance,
oneof archive/delete, uiStore], `terminalShell` [instance, TerminalShell oneof (validated],
uiStore], `terminalLoginShells` [instance, array of TerminalShell, uiStore], `openInAppId`
[instance, str].

**Dictation/STT** — `sttProvider` [instance, oneof ('local'|'openai-compatible' validated), configField],
`sttServerUrl` [instance, strT ≤2048, configField], `sttModel` [instance, strT ≤256, configField],
`sttLocalModel` [instance, strT ≤256, configField], `sttLanguage` [profile, strT ≤64, configField],
`dictationEnabled` [profile, bool, configField].

**Tunnels (instance)** — `tunnelProvider` [instance, str lowered], `tunnelMode` [instance, oneof
quick/managed-remote/managed-local], `tunnelBootstrapTtlMs` [instance, num?],
`tunnelSessionTtlMs` [instance, num], `managedLocalTunnelConfigPath` [instance, strT? path],
`managedRemoteTunnelHostname` [instance, strT], `managedRemoteTunnelToken` [instance, secret,
strT?], `hasManagedRemoteTunnelToken` [instance, computed, bool],
`managedRemoteTunnelPresets` [instance, preset list], `managedRemoteTunnelSelectedPresetId`
[instance, str (trimmed non-empty)], `managedRemoteTunnelPresetTokens` [instance, secret,
presets-with-tokens record].

**Sidebar display (profile → SessionDisplayStore)** — `sidebarProjectDisplayMode` [oneof all/single],
`sidebarSessionGroupingMode` [oneof by-worktree/flat], `sidebarProjectSortOrder` [oneof
manual/a-z/z-a/date-added/recent], `sidebarShowRecentSection` [bool].

**Work status** — `workStatusPanelEnabled` [bool], `workStatusHiddenSections` [string[] (unknown ids
dropped), ui write pairs it with] + `workStatusHiddenSectionsExplicit` [bool, companion marker;
both applied in one store write].

**Chat & rendering (profile)** — `showReasoningTraces` bool; `streamingAutoFollowEnabled` bool
[perSurface]; `collapsibleThinkingBlocks` bool; `showTextJustificationActivity` bool (no store
binding); `chatRenderMode` oneof sorted/live; `activityRenderMode` oneof collapsed/summary;
`mermaidRenderingMode` oneof svg/ascii; `userMessageRenderingMode` oneof markdown/plain;
`collapsibleUserMessages` bool; `stickyUserHeader` bool [perSurface]; `promptNavigatorEnabled` bool
[perSurface]; `wideChatLayoutEnabled` bool [perSurface]; `showSplitAssistantMessageActions` bool;
`showToolFileIcons` bool; `codeBlockLineWrap` bool; `showTurnChangedFiles` bool;
`showExpandedBashTools` bool; `showExpandedEditTools` bool; `toolJsonViewMode` oneof
summary/formatted/raw; `timeFormatPreference` oneof auto/12h/24h; `weekStartPreference` oneof
auto/sunday/monday; `messageStreamTransport` oneof auto/ws/sse [configField];
`diffLayoutPreference` oneof dynamic/inline/side-by-side; `diffWrapLines` bool;
`gitChangesViewMode` oneof flat/tree; `gitmojiEnabled` bool (no store; mirrored to localStorage);
`defaultFileViewerPreview` bool (no store; config mirror); `directoryShowHidden` bool (module
helper with persist:false binding); `filesViewShowGitignored` bool (same);
`fileEditorKeymap` oneof default/vim; `autoSaveEnabled` bool (skill auto-save toggle);
`autoCreateWorktree` bool (no store); `sessionTabsEnabled` bool [surfaces: web/desktop/vscode];
`showOpenCodeRestartConfirm` bool; `allowPromptingSubagentSessions` bool.

**Composer (profile)** — `inputSpellcheckEnabled` bool; `enterToSend` bool +
`enterToSendConfigured` bool (pair: unset = platform default); `persistChatDraft` bool;
`largeTextPasteBehavior` oneof ask/attach/inline; `followUpBehavior` oneof steer/queue
[lives in messageQueueStore, autoSave:false]; `queueModeEnabled` [legacy bool, absorbed by
followUpBehavior at parse]; `inputHistoryScope` oneof global/session [inputHistoryStore,
autoSave:false]; `inputHistoryLimit` int 1..100 [inputHistoryStore, autoSave:false];
`draftStarters` DraftStarterRef[] [profile, ui write re-inserts built-in starters unless their
"added" markers say they were offered]; `draftStartersVisible` bool;
`draftStartersCraftGoalAdded` + `draftStartersScheduleTaskAdded` [profile, bool markers, no store].

**Typography & chrome (profile)** — `fontSize` num [perSurface] (percent 50..200; **default 100**);
`terminalFontSize` num [perSurface] (px 9..52; **default 14**; store version-21 migration maps old
13 → 14); `editorFontSize` num [perSurface] (px 9..32; **default 13**); `uiFont` oneof UI_FONT_OPTIONS
[default `system`]; `monoFont` oneof CODE_FONT_OPTIONS [default `system-mono`]; `padding` num
[perSurface] (percent 50..200, multiplies `--padding-scale`; **default 100**); `cornerRadius` num
[perSurface] (store default 18); `shortcutOverrides` Record<actionId, combo string>.

**Models & agents (profile)** — `defaultModel` str, `defaultVariant` str, `defaultAgent` str,
`smallModelUseDefault` bool (**default true**), `smallModelOverride` str,
`walkthroughModelOverride` str, `zenModel` strT; six autoSave:false prefs (see F.3):
`favoriteModels` ModelRef[] ≤64, `hiddenModels` ModelRef[] ≤1024, `collapsedModelProviders`
string set, `recentModels` ModelRef[] ≤16, `recentAgents` string set, `recentEfforts`
Record<fingerprint-less key, string[]>; `providerOrder` string set.

**Sessions & summaries (profile)** — `sessionRecapEnabled` bool; `sessionSuggestionEnabled` bool;
`sessionGoalEnabled` bool; `sessionGoalDefaultBudgetEnabled` bool; `sessionGoalDefaultBudget`
int ≥1000 (client clamps 1000..100000000, step 50000); `summarizeLastMessage` bool;
`summaryThreshold` int ≥0; `summaryLength` int ≥10; `maxLastMessageLength` int ≥10;
`showDeletionDialog` bool.

**Notifications (profile)** — `nativeNotificationsEnabled` bool; `notificationMode` oneof
always/hidden-only; `notifyOnSubtasks` bool; `notifyOnCompletion` bool; `notifyOnError` bool;
`notifyOnQuestion` bool; `notificationTemplates` {completion,error,question,subtask}×{titleKey,
messageKey} (i18n-key references, not raw strings); `showOpenCodeUpdateNotifications` bool;
`reportUsage` bool (telemetry consent).

**Usage page (profile; page self-reads/writes via loadDesktopSettings)** — `usageDisplayMode`
oneof usage/remaining; `usageDropdownProviders` string list; `usageSelectedModels`,
`usageCollapsedFamilies`, `usageExpandedFamilies` Record<provider, string[]>; `usageModelGroups`.

**Behavior prompts (profile)** — `globalBehaviorPrompt` text ≤1 048 576 chars;
`responseStyleEnabled` bool; `responseStylePreset` oneof
concise/detailed/mentor/pushback/noFiller/matchEnergy/warmPeer/custom;
`responseStyleCustomInstructions` text ≤50 000; `optimizeSystemPrompt` bool.

**PWA (instance)** — `pwaAppName` [surfaces web; trimmed ≤64 chars]; `pwaOrientation` [web, oneof
system/portrait/landscape]. Server serves the manifest from these.

**Device (never synced)** — `mobileKeyboardMode` [surfaces mobile, oneof native/resize-content,
uiStore; falls back 'resize-content']; `desktopWindowControlsPosition` [surfaces desktop, oneof
left/right]; `desktopWindowControlsStyle` [surfaces desktop, oneof classic/traffic-lights];
`inputBarOffset` num px 0..100 step 5 [surfaces mobile+web].

Complete registry keys count ≈ 160; the snapshot JSON is the authoritative artifact — a cleanroom
must implement the same "single table + generated snapshot + stale-check test" flow, not
copy-paste this prose.

### F.6 Adding a setting (re-implementation procedure)

1. One registry entry (scope, parser, ui binding via existing setters).
2. Regenerate both snapshot copies; staleness test must fail otherwise.
3. If the server validates beyond the registry, add to its sanitizer + drift test sample.
4. Add the UI control + a search index entry.
Type, sanitizer, mirror, apply step, and auto-save all derive; there is no second list.
(src: lib/settings/DOCUMENTATION.md §Adding a setting)

---

## G. Settings UI

### G.1 Windows and placement (src: components/views/SettingsView.tsx, SettingsWindow.tsx)

- Desktop/web (non-mobile): `SettingsWindow` — centered Base UI Dialog, backdrop
  `oc-glass-backdrop bg-black/25 (dark: /40)`, popup `w-[90vw] max-w-[1200px] h-[85vh]
  max-h-[900px] rounded-xl bg-background`, 150ms fade+scale(0.98) start/end, dims
  (brightness 0.55/0.4 dark) while a nested dialog is open, and refuses to close while a
  dropdown/select popover is open. `aria-describedby` sr-only description.
- VS Code: renders SettingsView in a webview pane (no window), nav bg = page background;
  VS Code hides: theme section, tunnel page, remote-instances, git, magic-prompts, shortcuts,
  voice, projects (registry page), and the prompt-navigator shortcut.
- Mobile: a stage machine `nav` → `page-sidebar` (split pages) → `page-content` with a back
  ladder; hardware/browser back integrated via HTML5 history (`__openchamberSettingsDetail`
  history state) for split pages + an Android back-handler registration hook. The shortcuts page
  is hidden on mobile. Deep-linking: opening Settings with a stored `settingsPage` slug (persisted
  in ui-store `settingsPage`, `LOCAL_DEVICE_KEYS`) auto-prompts the mobile stage once.
- Desktop window: the Electron app may alternatively host settings via its own window using the
  same component (cross-ref 09).

### G.2 Page tree (src: lib/settings/metadata.ts + SettingsView)

Groups in `pageOrder` (order + group headers). `kind: split` pages have an entity sidebar.

| Group | Slug | Title | kind | Hidden when |
|---|---|---|---|---|
| general | `general` | General (OpenChamber) | single | — |
| general | `appearance` | Appearance | single | — |
| general | `chat` | Chat | single | — |
| general | `notifications` | Notifications | single | — |
| general | `sessions` | Sessions | single | — |
| general | `shortcuts` | Shortcuts | single | VS Code, mobile |
| general | `voice` | Voice | single | VS Code |
| general | `integrations` | Integrations | single | VS Code |
| general | `usage` | Usage | split | — |
| general | `about` | About | single | non-mobile web only (mobile web about) |
| projects | `projects` | Projects (Workspace) | split | VS Code |
| projects | `remote-instances` | Remote Instances | single | VS Code |
| projects | `tunnel` | External Tunnel | single | VS Code |
| projects | `git` | Git | single | VS Code |
| opencode | `providers` | Providers | split | — |
| opencode | `agents` | Agents | split | — |
| opencode | `behavior` | Behavior | single | — |
| opencode | `commands` | Commands | split | — |
| opencode | `mcp` | MCP | split | — |
| opencode | `plugins` | Plugins | split | — |
| content | `magic-prompts` | Magic Prompts | split | VS Code |
| content | `snippets` | Snippets | split | — |
| content | `skills.installed` | Skills | split | — |
| content | `skills.catalog` | Skills Catalog | single | — |

Special: internal-only `home` slug (mobile entry list; resolves to `general` on desktop). Legacy
sidebar-section slugs (`sessions, agents, commands, mcp, skills, providers, usage, git-identities`)
map to settings slugs via `resolveSettingsSlug`. Nav icons: general `settings-3`, projects `folders`,
remote-instances `computer`, appearance `palette`, chat `chat-ai-3`, magic-prompts `ai-generate-2`,
snippets `chat-thread`, notifications `notification-3`, shortcuts `command`, sessions `chat-history`,
providers `cloud`, agents `ai-agent`, behavior `brain`, commands `slash-commands-2`, mcp `McpIcon`
(custom), plugins `plug-2`, skills `book-open` / `book`, git `git-branch`, integrations `plug`,
usage `bar-chart-2`, voice `mic`, tunnel `home-office` (with a "Beta" chip), about `information`.

The "opencode" group (providers, agents, behavior, commands, mcp, plugins) edits the **agent
harness's** configuration — HARNESS PORT (cross-ref 02): those pages talk to harness config APIs,
not to the OpenChamber settings registry. The same applies to skill catalogs on the content group.

Non-registry pages (split pages) live in `components/sections/*` with Sidebar+Page pairs
(`AgentsSidebar/AgentsPage`, `providers/*`, `usage/*`, `projects/*`, `remote-instances/*`,
`mcp/*`, `plugins/*` (index exports PluginsSidebar+PluginsPage), `skills/*`, `commands/*`,
`magic-prompts/*`, `snippets/*`, `behavior/BehaviorPage`, `git-identities/GitPage`,
`integrations/IntegrationsPage`). Stores are lazily loaded on page activation
(`useAgentsStore.loadAgents`, `loadCommands`, `loadMcpConfigs({directory})`, `loadPlugins`,
`loadSkills`+`loadCatalog`, `loadSnippets`), keyed by the settings directory selector (follows the
active project until the user picks another).

### G.3 OpenChamber-owned pages (src: components/sections/openchamber/OpenChamberPage.tsx)

`OpenChamberPage section=general|visual|chat|shortcuts|sessions|git|notifications|voice|tunnel`
composes:

- general = `DesktopNetworkSettings` (desktop local only) + `PasskeySettings` (plain web only,
  not desktop/VS Code/Capacitor) + `AppLinkSecuritySettings` + `OpenCodeCliSettings`
  (non-VS Code) + `OpenChamberToolsSettings` (non-VS Code) + `OpenChamberVisualSettings` with a
  narrow visibility list [fileEditorKeymap, (+sessionTabs, terminalQuickKeys, terminalShell,
  terminalLoginShell when not VS Code), autoSaveEnabled, messageTransport, reportUsage]
- visual(=appearance page) = `OpenChamberVisualSettings` [theme (+windowControlsPosition,
  pwaInstallName, pwaOrientation, mobileKeyboardMode, timeFormat, +weekStart, fontSize,
  terminalFontSize, editorFontSize, spacing, scrollbars, inputBarOffset)]
- chat = `OpenChamberVisualSettings` [sessionGoal, sessionAssist, chatRenderMode,
  activityRenderMode, userMessageRendering, mermaidRendering, reasoning, showToolFileIcons,
  showTurnChangedFiles, expandedTools, collapsibleUserMessages, stickyUserHeader,
  (+promptNavigatorEnabled), wideChatLayout, codeBlockLineWrap, splitAssistantMessageActions,
  subagentReadOnlyBanner, diffLayout, inputHistoryScope, inputHistoryLimit, dotfiles,
  fileViewerPreview, followUpBehavior, persistDraft, inputSpellcheck, largeTextPaste, enterToSend]
- sessions = `DefaultsSettings` + `SessionRetentionSettings`
- shortcuts = `KeyboardShortcutsSettings`
- git = `GitSettings`; notifications = `NotificationSettings`; voice = `VoiceSettings`;
  tunnel = `TunnelSettings`.
- Mobile legacy mode (no section prop) stacks visual+defaults+desktop-network+cli+tools+
  retention+applink+passkey+about.

### G.4 Appearance page control inventory

All in one `OpenChamberVisualSettings` render; table lists `settingsItem` anchor, control, key(s).

| settingsItem | Control | Writes |
|---|---|---|
| (theme mode) | radio row: Follow system / Light / Dark | ThemeSystemContext setThemeMode → server theme fields |
| `appearance.light-theme` | Select of light themes (name sans " Light" suffix) | lightThemeId |
| `appearance.dark-theme` | Select of dark themes | darkThemeId |
| (reload) | link-button "Reload themes" (≥500 ms spinner) + info hint | GET /api/config/themes |
| `appearance.dock-badge` | checkbox (macOS desktop only) | uiStore dockBadgeEnabled (device/local) |
| `appearance.scrollbars` | checkbox "Always show scrollbars" | uiStore alwaysShowScrollbars (device/local) |
| deskoptic window controls | chip group position left/right + style classic/traffic-lights (frameless Electron only) | `desktopWindowControlsPosition`, `desktopWindowControlsStyle` (device scope, explicit PUT) |
| `appearance.language` | Select locale (12) | i18n setLocale → openchamber.i18n.v1 |
| `appearance.time-format` | Select auto/24h/12h | timeFormatPreference |
| `appearance.week-start` | Select auto/monday/sunday | weekStartPreference |
| `appearance.pwa-install-name` | Input ≤64 + reset | pwaAppName (instance) + `__OPENCHAMBER_SET_PWA_INSTALL_NAME__` bridge; default "OpenChamber - AI Coding Assistant"; commits on blur/Enter |
| `appearance.pwa-orientation` | Select + reset | pwaOrientation |
| `appearance.mobile-keyboard-mode` | Select native/resize-content + reset | mobileKeyboardMode (device) |
| `appearance.interface-font-size` | Select UI font + reset | uiFont |
| (code font) | Select mono font + reset | monoFont |
| `appearance.terminal-font-size` | NumberInput 9..52 step1 px, default 14, reset→13(reset sets 13; store default is 14) | terminalFontSize |
| `appearance.editor-font-size` | NumberInput 9..32 px default 13 | editorFontSize |
| (interface font size) | NumberInput 50..200 step5 % default 100 | fontSize |
| `appearance.spacing-density` | NumberInput 50..200 % default 100 | padding |
| `appearance.input-bar-offset` | NumberInput 0..100 px step5 (mobile) | inputBarOffset |
| `appearance.file-editor-keymap` | radio default/vim | fileEditorKeymap |
| `appearance.auto-save-enabled` | checkbox | autoSaveEnabled |
| `appearance.terminal-shell` | Select auto + detected shells (list from harness API; falls back to storing unknown selection) | terminalShell |
| `appearance.terminal-login-shell` | checkbox per selected shell (only if shell supports login) | terminalLoginShells array membership |
| `appearance.terminal-quick-keys` | checkbox (desktop) | showTerminalQuickKeysOnDesktop |
| `appearance.session-tabs` | checkbox group (web/desktop/vscode, not mobile) | sessionTabsEnabled |
| `appearance.usage-reports` | checkbox (general page) | reportUsage |

Chat page adds (same component, chat section list): radio `chat.render-mode` (sorted/live with
animated preview cards), `chat.activity-default` (radio collapsed/summary), chip `chat.message-transport`
(auto/ws/sse with dynamic description), radio userMessageRendering (markdown/plain), mermaid
(svg/ascii), diffLayout (dynamic/inline/side-by-side), followUpBehavior (steer/queue),
radio+number `chat.input-history-scope` / `chat.input-history-limit` (1..100, default 40, unit
"messages"), checkbox stacks: expandedTools (bash/edit) rows, `chat.session-assistance`
(draftStartersVisible, +sessionAssist recap/suggestion rows, +subagentReadOnlyBanner "allow
prompting subagent sessions"), session-goal section (enable + "default budget" checkbox +
NumberInput 1000..100000000 step 50000, integer, shown only when enabled+on, only non-VS Code),
`chat.reasoning` (traces checkbox; collapsible-thinking nested checkbox only when traces on),
`chat.streaming` (auto-follow), `chat.message-appearance` (collapsibleUserMessages, stickyUserHeader,
promptNavigator, wideChatLayout, splitAssistantMessageActions, codeBlockLineWrap),
`chat.tools-and-files` (tool file icons, turn changed files, dotfiles (non-VS Code),
fileViewerPreview), `chat.composer` (persistDraft, spellcheck (desktop/web only), largeTextPaste
radio ask/attach/inline, enterToSend radio Enter vs Cmd/Ctrl+Enter with "configured" marker pair).

### G.5 Sessions page (src: DefaultsSettings.tsx + SessionRetentionSettings.tsx)

Loads via `loadDesktopSettings()` (page-owned, no stores): default model picker
(provider/model, writes `defaultModel` + clears `defaultVariant`; only pushes into the live chat
when the chat has no manual selection), default variant select (`defaultVariant`, sentinel
`__default__`), default agent (`defaultAgent`, same manual-selection guard), small-model section
(`smallModelUseDefault` checkbox default true; when false, `smallModelOverride` picker restricted
to providers verified by GET `/api/small-model` authenticatedProviders, fail-closed),
walkthrough model override (`walkthroughModelOverride`, only structured-output-capable models —
`modelsMetadata.structured_output !== false` shown, missing capability counts as capable), open
files preview checkbox (`defaultFileViewerPreview` + `openchamber:file-viewer-preview-mode-changed`
CustomEvent), show deletion dialog checkbox (`showDeletionDialog`). Retention: autoDelete enabled +
after-days NumberInput 1..365 + archived-scope checkbox + action archive/delete
(`autoDelete*`, `sessionRetentionOnlyArchived`, `sessionRetentionAction`) — all instance scope.
**HARNESS PORT**: default model/variant/agent, small model, walkthrough override, and behavior
prompts shape what the harness runs per session (cross-ref 02 models).

### G.6 Search (src: lib/settings/search.ts, SettingsView.tsx)

- Static index `SETTINGS_SEARCH_ITEMS`: each item has a stable `id` (the `settingsItem` anchor of a
  control), its page slug, an i18n title (+optional description), and `keywords` (English hints:
  e.g. "theme, color, light mode"). Availability functions mirror the render guards (VS Code
  exclusions, isMac dock badge, mobile-excluded...). ~90 entries (file is 1141 lines).
- Results page-grouped, keyboard navigable (ArrowUp/Down cycles, Enter opens, Escape clears).
  Opening a result: sets `pendingSearchItemId` → navigates to the page → rAF-waits for the DOM →
  `querySelector([data-settings-item="<CSS-escaped id>"])` → scrollIntoView center + temporary
  `data-settings-search-highlight="true"` removed after 1600 ms. Special result ids trigger
  creation flows (e.g. `agents.create`, `commands.create`, `mcp.create`, `snippets.create`,
  `skills.create` pre-seed a draft with a unique name; `providers.connect` selects the add-provider
  row; `plugins.create` dispatches a delayed open event).
- The search extension types for platform quirks: `isDesktopLocalOrigin`, `isMac`, `isWindows`,
  `isLinux`, `isWindowsArm64` gate availability of desktop-only controls (a 19130-style workaround
  for windows-on-arm is an example of why).

### G.7 Non-OpenChamber settings pages (structure only; each is a later doc's deep dive)

- Providers (split): harness provider config, API keys write (HARNESS PORT; cross-ref 02).
- Agents (split): agent/permission editing (harness config).
- Behavior (single): AGENTS.md/system-prompt override, global behavior prompt registry key.
- Commands (split), MCP (split), Plugins (split): harness config surfaces.
- Skills installed/catalog (split/single): skill files + external catalog.
- Projects (split), Remote Instances (single, cross-ref 08/09), Git (single: identities,
  gitmoji toggle), Integrations (single: GitHub App + Linear OAuth), Usage (split),
  Tunnel (single), Magic Prompts (split), Snippets (split), Notifications and Voice as above.
- About (mobile web only): version, updates, changelog.

### G.8 Notifications, Voice, Tunnel, General-page sections (transcribed at verified fidelity)

**Notifications page** (`NotificationSettings.tsx`, ~640 lines; structure verified + registry docs):

- Four templates exist by default for events `completion`, `error`, `question`, `subtask`, each
  with `{titleKey, messageKey}` referencing i18n keys (defaults live under
  `settings.notifications.page.template.defaults.*`), so templates are translation-referencing,
  not raw localized strings. Registry key `notificationTemplates`.
- Platform gating branch for the master toggle: desktop shell → main-process notifications (no
  browser permission); native Capacitor app (`window.Capacitor.isNativePlatform()` or `capacitor:`
  protocol — treated as a native runtime with its own Local-Notifications permission, never gated
  on the Web `Notification.permission`); plain browser → Web Notification permission +
  service-worker `PushManager` subscription state (`pushSupported = serviceWorker in navigator &&
  PushManager in window && Notification in window`) with a subscribe action and busy state;
  VS Code → none rendered.
- Controls: `nativeNotificationsEnabled` (master, permission-gated on web), `notificationMode`
  radio (always / hidden-only — notifications suppressed while the window is visible), event
  checkboxes `notifyOnSubtasks` / `notifyOnCompletion` / `notifyOnError` / `notifyOnQuestion`,
  template editors per event (title + message fields), and `showOpenCodeUpdateNotifications`.
- `reportUsage` (anonymous usage-report consent checkbox) lives on the General page, not here.

**Voice page** (`VoiceSettings.tsx`, ~1300 lines; opening verified):

- Dictation engine choice: built-in browser speech recognition ("browser voice service") or an
  OpenAI-compatible server, or fully local in-browser WASM models. Verified local model list
  (`LOCAL_STT_MODELS`, ids not localized): `parakeet-tdt-0.6b-v2-int8` (460 MB, accuracy 5/5,
  speed 5/5), `parakeet-tdt-0.6b-v3-int8` (465 MB, 5/4), `whisper-base-int8` (200 MB, 3/3),
  `whisper-tiny-int8` (115 MB, 2/4). Each row carries install state
  (`installed / downloading / downloadProgress / downloadError`).
- Related registry keys: `dictationEnabled` (profile bool), `sttProvider` (oneof validated
  'local' | 'openai-compatible', instance), `sttServerUrl` ≤2048, `sttModel` ≤256,
  `sttLocalModel` ≤256, `sttLanguage` ≤64 (profile). Wired to the dictation client
  (`lib/dictation/dictation-client.ts`, 10–30 s connection/start/finish timeouts) and a
  `useLocalTTS` hook; the preview-audio helper (`voicePreviewAudio.ts`) must be disposed on unmount.
- Cross-ref 05/08 owns the actual streaming behavior; the settings page only configures it.

**Tunnel page** (`TunnelSettings.tsx`; not source-read in this pass — carries a "Beta" nav chip
and the registry keys `tunnelProvider/tunnelMode/tunnelBootstrapTtlMs/tunnelSessionTtlMs/
managedLocalTunnelConfigPath/managedRemoteTunnelHostname/managedRemoteTunnelToken (secret +
computed `hasManagedRemoteTunnelToken`)/managedRemoteTunnelPresets/
managedRemoteTunnelSelectedPresetId/managedRemoteTunnelPresetTokens (secret)`; QR/share flow —
cross-ref 08).

**General-page sections** (roles verified from OpenChamberPage composition; per-control detail
belongs to each section file):

- `DesktopNetworkSettings` (desktop local-origin only): LAN access enable/status/blocked-reason
  (`desktopLanAccessEnabled` + computed `desktopLanAccessActive/BlockedReason`), UI password
  (secret `desktopUiPassword`, write-only, `hasDesktopUiPassword` computed flag), keep-awake,
  minimize-to-tray, macOS menu bar, plus the frameless window-controls position/style chips
  surfaced in the Appearance page when the visibility list includes them.
- `PasskeySettings` (plain web only): WebAuthn/passkey registration for server login
  (`@simplewebauthn/browser`).
- `AppLinkSecuritySettings`: out-of-app link-opening trust state (deep-link grant confirmation).
- `OpenCodeCliSettings` (non-VS Code): harness binary path (`opencodeBinary`), version/restart
  affordances (the footer restart action's pending count comes from
  `usePendingOpenCodeRestartStore` in SettingsView), `showOpenCodeRestartConfirm`.
- `OpenChamberToolsSettings` (non-VS Code): agent tool toggles (`agentControlToolEnabled`,
  `agentWebToolEnabled`, `agentMemoryToolEnabled` + computed feature availability).

### G.9 Store-default appendix (verified from stores/useUIStore.ts init/migrations)

Verified initial values a rebuild must reproduce (persist name `ui-store`, schema version 21):

| Setting | Default |
|---|---|
| `chatRenderMode` | `live` |
| `fontSize` | `100` (percent) |
| `terminalFontSize` | `14` (px; version-21 migration maps a persisted 13 to 14) |
| `editorFontSize` | `13` (px) |
| `uiFont` / `monoFont` | `system` / `system-mono` |
| `padding` | `100` (percent) |
| `cornerRadius` | `18` |
| `diffLayoutPreference` | `inline` |
| `timeFormatPreference` / `weekStartPreference` | `auto` / `auto` |
| `enterToSend` + `enterToSendConfigured` | `false` / `false` — effective selection is `configured ? enterToSend : !isMobile`; first explicit choice persists both keys (`enterToSend` plus the configured marker) |
| `largeTextPasteBehavior` | normalized at parse (ask/attach/inline; store clamps via its normalizer) |
| `alwaysShowScrollbars` | `false` (device-only; snapshot `{scope:'device', local:true}`; not in `AUTO_SAVE_KEYS`) |
| `showTerminalQuickKeysOnDesktop` | `false` |
| `messageLimit` | clamp 10..500 (device-only; named only in `LOCAL_DEVICE_KEYS`) |
| `themeMode` (theme context, not registry) | `system` |
| Input history | scope `session`, limit `40` (1..100) |
| Small model | `smallModelUseDefault: true`, overrides empty |
| Session goal budget | disabled by default; budget integer ≥1000 (UI step 50000, max 100000000) |
| Notification templates | i18n-key references for completion/error/question/subtask |

Behavior notes verified alongside: `setFontSize`/`setPadding` clamp 50..200 and both re-apply
(`applyTypography` re-maps `--text-*` from SEMANTIC_TYPOGRAPHY keys; `applyPadding` drives
`--padding-scale`); `setTerminalFontSize` rounds and clamps 9..52; `setEditorFontSize` clamps
9..32; `setTerminalLoginShells` dedupes; `setCornerRadius` stores without clamping (the UI
NumberInput clamps); value setters are plain `set()` writes — the auto-save subscribers own
persistence.

---

## H. i18n system (src: packages/ui/src/lib/i18n/)

### H.1 Locales

Supported: `en` (default), `de`, `fr`, `zh-CN`, `zh-TW`, `uk`, `es`, `pt-BR`, `ko`, `pl`, `ja`,
`tr` — 12 (`LOCALES` in runtime.ts). Language labels come from
`common.language.*` translation keys, not hard-coded names, so each locale is labeled in the
current UI language. `normalizer` accepts browser tags: `zh-hans*`→zh-CN, `zh-hant*`/`zh-TW`,
other `zh*`→zh-CN, `pt(br)`→pt-BR, `ua`→uk, prefix matching for others, else `en`.

### H.2 Files and structure

- `messages/en.ts` — the canonical dictionary; its exported `I18nKey` type is the closed key set
  (flat dotted keys like `settings.openchamber.visual.field.timeFormat`). No non-English file may
  introduce keys.
- `messages/<locale>.ts` — same flat key→string shape, mainly settings strings.
- `messages/<locale>.settings.ts` — merged/imported by the locale file (settings namespace split).
  Code organizes dictionaries as: locale file = general surface terms + re-exports settings module.
- `messages/linear-panel.i18n.ts`, `linear-issue-picker.i18n.ts`, `linear-integration.i18n.ts` —
  per-feature sparse dictionaries with their own tests (existence checks for every key per locale).
- `runtime.ts`: storage `openchamber.i18n.v1` (`{"locale":"fr"}`), initial detection = stored →
  `window.__OPENCHAMBER_HOST_LANGUAGE__` (host-injected, e.g. VS Code) → `en`. Writes on change.
- `store.ts`: zustand store `{locale, dictionary, loadingLocale, setLocale}`; English dict is
  synchronous; other locales dynamically imported (`loadDictionary`) and cached in a module Map;
  the switch applies optimistically (keeps the old dictionary visible + `loadingLocale` marker)
  then swaps on load; failure ⇢ logs + falls back to the English dict.
- `bootstrap.ts`: a small per-locale set of pre-app shell strings (connection states, loading
  lines, CLI-not-found, dev-server wait) as plain functions — used before dictionaries load.
- `context.tsx`/`react-context.ts`: `I18nProvider` supplies `{t, locale, locales, setLocale, label}`;
  `t(key, params?)` resolves dictionary[locale] → en dict → the key itself (last resort), then
  interpolates `\{param\}` placeholders with string coercion (missing params render as the raw
  `{param}` token). `useI18n.ts` is the required-context hook (throws outside provider).
- `intl.ts`: `getCurrentIntlLocale()` maps our `Locale` to a BCP-47 tag for `Intl` APIs (money,
  time). Language change therefore re-formats dates/currency app-wide.

### H.3 Conventions

- Components never hard-code English UI strings; `settingsLabelKey`-style declarations (shortcuts)
  prove Settings cannot maintain its own fallback list.
- Adding a translated string = add the key to `en.ts` and every locale in the same change
  (shortcuts module rule; dictionaries' tests elsewhere enforce full key coverage per locale).
- Interpolation is `{name}`; pluralization is not in the framework (callers handle counts via
  explicit keys).
- Bootstrap strings exist so splash/connection UI speaks the user's locale before JS dictionaries
  are installed. VS Code host language seeds the webview before any storage write.

### H.4 Platform quirks

- VS Code webviews receive `__OPENCHAMBER_HOST_LANGUAGE__`; mobile hosted shell passes its own
  storage. localStorage is keyed globally (not per-runtime) — locale follows the browser profile.
- The Settings language control shows `label(locale)` localized in itself; first paint uses stored
  locale via `readStoredLocaleForBootstrap` early in boot (pre-React).

---

## I. Shortcuts

### I.1 Complete binding table (src: lib/shortcuts/config.ts; `mod` = Cmd on macOS else Ctrl;
`alt` = Option on macOS else Alt)

Category `session`:

| Action id | Default binding | Customizable (Settings label key exists) | Notes |
|---|---|---|---|
| `add_selection_to_chat` | `mod+l` | yes `...add_selection_to_chat.label` | contextual (selection toolbar owns it; see I.4) |
| `focus_input` | `mod+i` | yes | focus composer |
| `open_timeline_dialog` | `mod+k t` | yes | |
| `new_chat` | `mod+n` | yes | |
| `switch_session_previous` | `mod+alt+arrowleft` | yes | |
| `switch_session_next` | `mod+alt+arrowright` | yes | |
| `rename_current_session` | `mod+k r` | yes | |
| `toggle_permission_auto_accept` | `mod+k a` | yes | |
| `close_session_tab` | `alt+w` | yes | |
| `open_draft_project_picker` | `mod+k p` | yes | |
| `open_draft_worktree_picker` | `mod+k g` | yes | |
| `open_session_list` | `mod+k l` | yes | |
| `new_chat_worktree` | `mod+shift+n` | yes | |
| `new_mini_chat` | `mod+alt+n` | yes | |
| `expand_input` | `mod+shift+e` | yes | |
| `toggle_dictation` | `mod+alt+v` | yes | |
| `abort_run` | `escape` | no (internal) | aborts the running agent |

Category `models`:

| Action id | Default | Customizable |
|---|---|---|
| `open_model_selector` | `mod+shift+m` | yes |
| `cycle_thinking_variant` | `mod+shift+t` | no |
| `cycle_agent` | `tab` | yes |
| `cycle_favorite_model_forward` | `ctrl+]` | yes (note: literally Ctrl, not mod) |
| `cycle_favorite_model_backward` | `ctrl+[` | yes |

Category `panels`:

| Action id | Default | Customizable | Notes |
|---|---|---|---|
| `toggle_terminal` | `mod+j` | yes | |
| `toggle_terminal_expanded` | `mod+shift+j` | yes | |
| `toggle_sidebar` | `mod+b` | yes | |
| `toggle_prompt_navigator` | `mod+k n` | yes | hidden from the page on VS Code |
| `switch_session_tab` | `mod` | yes | **prefix style**: bare held modifier + digit (header session tabs) |
| `switch_context_surface` | `mod+alt` | yes | prefix style + digit (context panel surfaces) |
| `toggle_services_menu` | `mod+k i` | yes | |

Category `navigation`: `save_file` `mod+s` (no), `find_in_file` `mod+f` (no), `open_go_to_line`
`alt+g` (yes).

Category `application`: `open_command_palette` `mod+p` (yes), `open_settings` `mod+comma` (yes),
`open_help` `mod+k h` (yes), `cycle_theme` `mod+k c` (yes).

Leader layout modes: single chords for everyday actions; `mod+k` leader for open/go actions (t, r,
a, p, g, l, n, i, h, c); held-modifier digit prefixes for tab/context switching. Palette-only
commands (context surfaces on non-desktop, harness status dialog, memory debug) live **outside**
the schema and invoke their owning modules directly. internal `switch_tab_*` bindings remain for
the mobile handlers; desktop resolves digit prefix through `switch_context_surface` before normal
dispatch and falls through on mobile.

### I.2 Engine modules (src: lib/shortcuts/*; public import surface `@/lib/shortcuts`)

- `config.ts` — declaration only: grouped `SHORTCUT_SCHEMA` entries `{id, defaultBinding,
  customizable|{customizable, settingsLabelKey}, prefixStyle?}`; concatenation of 5 groups.
- `schema.ts` — derives `ShortcutActionId`/category types, lookups, effective-binding resolution.
- `bindings.ts` — chord parsing/normalization/display/risk checks/conflicts. Grammar: one chord or
  two space-separated chords (`mod+k p`, max 2). Canonical tokens: `mod`, `alt`, modifiers
  normalized from accepted aliases (`command`, `cmd`, `meta`, `option` to mod/alt equivalents),
  plain keys lowercased (`arrowleft`, `comma`...). Display uses macOS glyphs `⌘⌥⌃⇧` on macOS,
  `Ctrl/Alt/Shift` names elsewhere (also tooltip/aria text). `UNASSIGNED_SHORTCUT` is the sentinel
  for "cleared". Conflict rule: a single chord conflicts with any sequence sharing its first chord;
  sibling sequences are fine.
- `registry.ts` — active handler per action (first registration wins until unregistration);
  `suspend()`/idempotent cleanup with nesting (suspends ALL app handlers).
- `dispatcher.ts` — resolves bindings at dispatch; holds the active sequence prefix for 3000 ms
  (`SEQUENCE_TIMEOUT_MS`); prefix cleared on window blur; Escape consumed only when it cancels a
  prefix; while a prefix is armed only the exact second key dispatches (capture phase) and stays
  eligible during IME composition; mismatch clears the prefix and restores composition.
- `hooks/useKeybind.ts` — `useKeybind(actionId, handler)` / `useKeybinds(bindings)` tied to
  component lifetime with a current-handler ref; rejects undeclared ids (including mixed/misspelled
  objects); install one dispatcher keydown listener per window (main app + Mini Chat windows share
  contracts).
- Runtime `useKeyboardShortcuts`-style router wires one listener: window-bubble for normal
  chords; capture for armed-prefix second keys; editable-target policy: custom prefixes without
  Cmd/Ctrl and `AltGraph` combos yield to text entry in inputs/textareas/selects/contenteditable;
  both digit prefixes work from editables when Cmd/Ctrl held; both yield during IME composition.

### I.3 Settings page + recorder

- Page groups by category (session, models, panels, navigation, application), row = label (i18n),
  `<kbd>` display (prefix rows append a translated "+ digit" suffix), Edit button opens
  `ShortcutRecordingDialog`, per-row Reset shows only if overridden; first section has a
  "Reset all" header action. Before record, customize-only: VS Code hides
  `toggle_prompt_navigator` (its row registry excludes it).
- Recorder contract (src: ShortcutRecordingDialog + DOCUMENTATION): records up to 2 chords, max 3
  simultaneous physical keys per chord; after the first chord waits up to **3000 ms** for the
  second; conflict and browser-risk feedback appear only after the second chord, the timeout, or
  Confirm; recording stays local until Confirm (only its Confirm/Cancel buttons apply/discard);
  Enter and Escape are recordable. An exact customizable conflict is allowed to **replace** the
  previous assignment (the other action gets `UNASSIGNED_SHORTCUT`); prefix conflicts are blocked
  unless the single-chord action explicitly allows sequence fallback (contextual prefixes remain
  saveable with a warning). Internal (non-customizable) bindings are authoritative: persisted
  overrides cannot change/unassign them, and recorder conflicts with them cannot be replaced.
  It checks the **complete schema**, not only customizable actions.
- Persistence: `shortcutOverrides` registry key (profile scope) `Record<actionId, combo>`; page
  saves via `updateDesktopSettings({shortcutOverrides})` and store setters; effective combos
  resolve override → default.

### I.4 Contextual ownership

- The visible text-selection toolbar publishes its `add_selection_to_chat` + dismiss handlers,
  suspends the shared registry, owns a dedicated scoped dispatcher, ignores IME composition, lets a
  non-IME Escape pass to the global route only after IME, handles the configured (possibly
  two-chord) binding, and clears on hide/unmount. Main app route additionally gates on toolbar
  ownership. Opening/closing/replacing a toolbar invalidates pending prefixes.
- `[data-btw-composer="true"]` (Mini Chat composer) owns Escape and suppresses main session
  abort-priming, model/effort, expansion, and dictation registrations while active.
- Terminal capture/Escape-abort priming/shifted reverse-agent chord remain input-boundary
  exceptions that call into the registered handlers rather than duplicating behavior.
- `DropdownMenu`/`Select` `disableGlobalShortcuts` suspends app shortcuts while open (controlled
  and uncontrolled), translating `Ctrl+N/Ctrl+P` to menu navigation even when the event reports
  IME composition; window-capture handles IME Escape before Base UI's document dismiss listener.

### I.5 hardwareKeyboard + IME helpers (platform, src: lib/hardwareKeyboard.ts, lib/ime.ts)

Not shortcut registry internals but the keyboard-adjacent helpers:

- `hardwareKeyboard.ts`: "is a hardware keyboard attached?" for mobile layout. Priority: native
  stamp `window.__OPENCHAMBER_HARDWARE_KEYBOARD__` (iOS shell at document start, live updates via
  `oc:hardware-keyboard` CustomEvents {attached:boolean}) → inference: a `keyboardWillShow` event
  fed via `observeNativeKeyboardHeight(px)` where `0 < h < 120px` (SOFTWARE_KEYBOARD_MIN_HEIGHT_PX)
  means only the iOS shortcut strip → `observeEditorFocus()` starts a 600 ms probe
  (KEYBOARD_EVENT_GRACE_MS) and silence concludes hardware-attached (a real keyboard event cancels
  it; probe skipped when `oc-keyboard-open` class is present). Reflects state as
  `oc-hardware-keyboard` on `<html>`, exposes `useHardwareKeyboard()` via useSyncExternalStore;
  `resetHardwareKeyboardDetection` on bridge teardown (only downgrades when no native answer
  exists). Memory-only.
- `ime.ts`: `isIMECompositionEvent(e)` = `native.isComposing || native.keyCode === 229`
  (keyCode kept as the WebKit fallback).
- `mobileKeyboardMode.ts` (B/F cross): device surface setting; when `resize-content` (default) the
  viewport meta gains `interactive-widget=resizes-content` (base meta:
  `width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover`);
  stored under `openchamber.mobileKeyboardMode` (`native` stored, default removed).

### I.6 Scrollbars preference

`alwaysShowScrollbars` (LOCAL_DEVICE_KEYS, uiStore, default false, autoSave NOT sent to server):
overlay scrollbars hide unless needed; true forces persistent overlay thumb visibility via
`OverlayScrollbar`/CSS (uses `--oc-scrollbar-thumb(-hover)`). `.dark` shares the single authored
oklch values; themes can restyle with their own scrollbar tokens (theme type has an optional
`scrollbar.record` decoration — informational).

---

## J. Formatting conventions

### J.1 Time (src: lib/timeFormat.ts)

- `userTimeFormatPreference` (`auto|12h|24h`; default `auto`) → `hour12`: 12h→true, 24h→false,
  auto→undefined (locale default). Formatting always via `Intl` with
  `getCurrentIntlLocale()`; minute always 2-digit; `formatTimeForPreference(ts, preference,
  {precision:'minute'|'second', hour:'numeric'|'2-digit', fallback})` returns `fallback`/`''` for
  invalid dates. `formatDateTimeForPreference` merges caller options preserving caller-supplied
  hour12 when no `hour` given.
- Timezone handling: everything renders in the viewer's local timezone via `Intl`; no tz picker.
  `canonicalizeTimezone` (lib/timezones.ts) maps legacy IANA ids to modern ones when persisting or
  displaying zone names: Europe/Kiev→Kyiv, Asia/Calcutta→Kolkata, Asia/Saigon→Ho_Chi_Minh,
  Asia/Rangoon→Yangon, Asia/Katmandu→Kathmandu, America/Godthab→Nuuk, Atlantic/Faeroe→Faroe,
  Pacific/Enderbury→Kanton.

### J.2 Money (src: lib/money.ts)

Single formatter `formatMoney(value:number)`: currency **USD** fixed (not localized to the
user's country), locale from `getCurrentIntlLocale()`, 2 fraction digits; `< 0.01` uses 4 digits;
non-positive/non-finite → `0` formatted (e.g. `$0.00`). Used by usage/billing surfaces.

---

## K. Invariants and edge cases

1. **Missing is not default.** Omitted server fields never reset client state; defaults live in
   store initial state. A parse failure = field absent.
2. **A key not in the registry does not persist** anywhere (client mirrors, server files, VS Code
   bridge, desktop shell writes).
3. **One scope per key; surface-scoped values follow the client's kind param** — no headers
   (CORS-simple), never wrong-surface contamination.
4. **Adoption vs intent.** Writes happen only under user intent (theme intent ref; auto-saves skip
   while `isApplyingServerSettings()`). Echo suppression via `_serverKnownSettings` makes a "set
   back to server value" free.
5. **Debounce=200 ms for general settings; 1200 ms for model prefs; lifecycle flush with keepalive**
   on pagehide/beforeunload/hidden/freeze/appStateChange/endpoint-switch — a crashed window loses at
   most the in-flight request.
6. **Schema versioning**: registry snapshot `version: 1`; ui-store persist `version: 21` with a
   migration chain (e.g. terminalFontSize 13→14 at <21). A rebuild needs its own migrations and
   must regenerate the snapshot whenever the registry table changes, with a staleness test.
7. **Theme system**: exactly one style element id `opencode-theme-variables`; both variants'
   variables are written at once; the `dark` class and `data-theme` always match the variant;
   transitions suppressed for two frames on switch. Custom themes are validated twice (server read
   filter + `isValidTheme`); 512 KB size cap; duplicate ids skipped with first-wins merge order:
   vscodeTheme > embedded synced > embedded bootstrap > custom > dev-HMR > built-ins.
8. **Per-device vs per-server**: theme is per-server (runtimeKey scoped) + per-surface-kind;
   locale is browser-global; scrollbars/dock badge/inputBarOffset/mobileKeyboardMode/window
   controls are device; PWA name/orientation are instance (the static server assets consume them).
9. **Confirm patterns**: destructive confirmations (session deletion) gate via `showDeletionDialog`;
   settings recorder requires explicit Confirm; no global "Save" exists — everything is
   auto-save on change (indicator shows saving/error only).
10. **Icons**: any string may be passed to Icon; build-time scanner warns unknown; runtime missing
    symbol renders empty but appends late sprites automatically. Type-safe unions are regenerated
    with the sprite.

---

## L. Build checklist (implement in this order)

1. CSS entry: Tailwind v4 + `tw-animate-css`; design-system.css tokens (B.1–B.2); `@theme inline`
   mapping; glass classes; reduced-motion/transparency fallbacks.
2. Typography module + watcher (`--text-*` from SEMANTIC_TYPOGRAPHY; VS Code variant switch).
3. Tailwind `cn()`; Base UI wrappers (C.1–C.12); toast wrapper; SettingsSection primitives with
   `settingsItem` DOM anchor convention.
4. Icon sprite generation (D.1) + file-type sprite (D.3) + `Icon` injection.
5. Theme: Theme type + validator + generator; ThemeSystemContext (mode/light+dark pair, per-runtime
   storage, sync events, embedded sync, browser chrome, transition suppression); settings registry
   theme keys with per-surface writes.
6. Settings: registry table + parsers + snapshot generator + server/vscode gates + debounced PUT +
   mirror + seeds + auto-saves (appearance + model-prefs) + save-state indicator.
7. Settings UI: window + mobile stage machine + nav/search + page tree + OpenChamber sections.
8. i18n: locale list, en dictionary type, dynamic locale loader, provider, bootstrap strings,
   storage, host-language seed.
9. Shortcuts: schema, bindings/normalization/conflicts, registry + suspend, dispatcher (3000 ms
   prefix, capture-phase second key, IME rules), hooks, Settings recorder, usage registrations
   (palette, settings `mod+comma`, theme cycle, abort, etc.).
10. Formatting helpers (time/money/tz canonicalization), hardware keyboard + mobile viewport
    keyboard mode.
11. Tests mirroring the repo's: registry staleness, snapshot gate, i18n key coverage per locale,
    bindings/conflicts/recorder, theme validation + generator output, persistence debounce/flush.

## M. Gaps / low-confidence items to re-verify

- Exact preset theme JSON contents (38 files) were not transcribed — copy by id list (E.2); the
  sample custom-theme JSON in E.6 is the full field contract.
- VS Code theme adapter's exact mapping table (`lib/theme/vscode/adapter.ts` ~400 lines) summarized
  only: host theme → tints; verify token-color rules individually when portability to a foreign
  host matters (it maps through the generic Theme shape, so once the adapter exists the rest is
  reusable).
- `components/ui/index.ts` re-export list not enumerated; treat each file individually.
- Settings search item list (~90 entries) not fully transcribed; the pattern + availability context
  is complete; re-derive per control as controls are built.
- Sonner toaster mounting options (position/offsets) in `sonner.tsx` not transcribed (cosmetic).
- Desktop settings *window* (Electron-native, cross-ref 09) interplay beyond SettingsWindow reuse
  was not read here; validate with 09.
- `styles/fonts.ts` contents (any static @font-face preloads) were not read; the runtime loader is
  the authoritative path described in B.4.
- Capacitor StatusBar/splash color follow-up (`styles/mobile.css` details) skimmed only.



