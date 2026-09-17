# NOTES 03 — Server surface (partial; P4 staged from docs/planning/03)

## A. P4 staging (routes land in layers as chat/panel need them)

- **P4-1 (this slice)** — `GET /api/fs/list`, `/api/fs/search` (NND extension —
  OpenChamber searches client-side over list; our mention picker wants a
  bounded server walk; delta registered in §D), `GET /api/fs/git-dirs`,
  `GET /api/git/check`, `GET /api/git/status?mode=light` (§5.13 #7/#12
  shapes verbatim: non-repo ⇒ `{ isGitRepository:false, … }` payload, never a
  500; `?directory` REQUIRED; 400 `{error:'directory parameter is required'}`).
  Workspace containment per §5.14 mode-1: target must resolve INSIDE the
  `directory` scope (symlink escape ⇒ 403 `'Access denied'`; `EACCES/EPERM` ⇒
  403 + `reason:'os-permission'`; ENOENT ⇒ 404 + `reason:'not-found'`).
  Mount BEFORE the `/api/*` harness proxy (Hono registration order); the proxy
  keeps everything else.
- **P4-2** — projects/config/settings utilities (§5.6/§5.15) + fs write
  family (upload/write/delete/rename with atomic tmp+rename) as the review
  surfaces (doc 06) start consuming them; git read family (diff/log/branches).
- **P4-3** — the full git write family + integrations + session-folders +
  message-queue + auth/session surface (§5.2; pairs with doc 08 P11).

## B. Contract fidelity notes (doc 03)

- `/api/fs/list`: response stays in the CALLER's path space (requested path
  echoed; entries carry paths in that same space; symlink transparency).
  `respectGitignore='true'` default kept for the picker; our search walks the
  same ignore rules via the `git-dirs` skip list + `.git` boundary.
- `/api/git/status`: `?directory&mode=light` — light mode trims `files` to
  paths+staged flags (the panel counts, the review surface gets the full set
  in P4-2). `merge/rebase` states surface when present.
- `/api/fs/exec` and clone routes DEFER to P4-2/P4-3 (write family).
- Env knobs respected: `NOTNATIVE_FS_*` mirrors where cheap (upload cap etc.
  land with the write family).

## C. Integration notes for existing NND code

- `app.ts` order: `/auth/*`, `/api/notnative/*`, then **fs+git (P4-1)**, then
  `/api/*` proxy catch-all, then static SPA fallback. Smoke tests must keep
  passing: `/api/session` still proxies.
- Composer mention picker: `pickerItems(mention)` now sources a debounced
  `/api/fs/search` over the session directory (relative paths; registry
  membership rules per doc 05 §B.3 stay).
- Work-status panel: `Project` section adds `Changes` row from git status
  (`{n} file(s) changed` + branch); suppressed while git is unavailable
  (non-repo payload = no row, never an error banner — §E.9 "git status
  unavailable" row).

## D. Deltas vs doc 03 (registered)

- `/api/fs/search` is an NND addition (bounded walk, depth 3, 100 dirs, skip
  list from §5.14 git-dirs family) — OpenChamber's picker filters
  client-side; ours goes server-side to keep the payload bounded for remote
  clients (ADR 0020 remote-first posture). Signature: `?directory&query&limit`.
- `mode=light` for git status is verbatim OpenChamber; full files detail
  arrives with the review surfaces.
