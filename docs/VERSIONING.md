# Versioning policy

The canonical NotNativeAgent release identifier is stored in the root `VERSION` file and
uses:

```text
YYYYMMDD-<iteration>
```

The date is the local release date and the positive iteration starts at `1` each day.
For example, the second release iteration on August 1, 2026 is `20260801-2`.

Advance the version before beginning a release iteration:

```sh
npm run version:bump
```

The command increments the iteration when the existing version uses today's date, or
starts at `1` for a new date. Reproducible release automation can provide explicit values:

```sh
node scripts/bump-version.js --date 20260801 --iteration 2
```

The command synchronizes `VERSION`, the runtime constant, package metadata, and SBOM.
It deliberately does not rewrite conformance evidence or release hashes. Consequently,
release gates fail until Windows/Linux testing has been rerun, the conformance record has
been updated to the new identifier, and `RELEASE_MANIFEST.sha256` has been resealed.

`RELEASE_VERSIONS.json` records a deterministic content digest when a version is first
sealed. Release tooling refuses to reseal changed content under an existing identifier.
Therefore, any later code, installer, test, metadata, or documentation update requires a
new iteration before `--write-hashes` can succeed. The version ledger and release manifest
are excluded from the content digest itself to avoid circular hashing.

The npm-compatible `package.json.version` mechanically maps `YYYYMMDD-N` to
`YYYYMMDD.0.N`. `package.json.nna_version`, CLI output, health output, installer metadata,
MCP client metadata, SBOM, and conformance evidence all use the canonical hyphenated
identifier.
