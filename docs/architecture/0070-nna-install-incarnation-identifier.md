# NNA installation-incarnation identifier

Status: accepted. Required by guide 02 line 275 before any legacy-backend takeover can be accepted.

`installation_id` and `data_id` derive from the canonical install and data roots, so reinstalling NNA at the same roots produces the same identity and a consumer holding a pinned pair cannot tell that the installation it verified has been replaced. Every install now records a random `incarnation_id` (lowercase UUID v4) beside the identity fields:

- The installer generates it only while creating the descriptor. An in-place upgrade that rewrites the descriptor preserves the existing `incarnation_id`, so a version change keeps the same installation whole, while uninstall followed by reinstall always records a new one.
- The identity reader surfaces `incarnation_id` when the descriptor carries one and reports `null` for descriptors written before this decision; absence never fabricates an identifier. The descriptor is the only carrier: the capabilities frame keeps its six keys, because the preflight validator exact-matches them and every pin site can read the descriptor directly.

Consumers persist `incarnation_id` beside the identity pair they already pin (the desktop selection pin, the activation anchor binding) and recheck it at every attach. When both the pin and the live descriptor report an identifier and the values differ, the pinned installation was replaced after pinning; the attach is refused and the consumer must reselect. A pin predating this decision, or an installation predating it, proves nothing about replacement — those attaches run under the existing path-identity checks alone, and a consumer that needs replacement detection must repin through a fresh verification pass.

The identifier names an installation, not a secret; it may appear beside the identity in logs. It authorizes nothing by itself. The legacy Electron-owned backend process-ownership drain still requires its own decision after this identifier exists on both sides.
