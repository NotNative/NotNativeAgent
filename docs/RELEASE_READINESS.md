# Release readiness

NotNativeAgent uses automated and human validation to decide whether a build is ready to
share. Run `npm run release:check` from the repository root and retain its output with the
candidate.

## Automated gates

The release check covers:

- the complete automated test suite and JavaScript syntax checks;
- source-size and implementation-safety bounds;
- Apache-2.0 license metadata, `NOTICE`, the SPDX SBOM, and third-party notices;
- dependency consistency and the pinned optional SearXNG image checksum;
- secret scanning and required release-file presence;
- canonical version agreement across runtime, package, SBOM, and platform evidence;
- native-platform conformance evidence; and
- a deterministic release manifest that detects missing, added, or changed files.

Git metadata, dependency caches, runtime scratch data, and the complete gitignored
`docs/planning/` tree—including `docs/planning/resolved/`—are excluded from candidate
digests and release manifests. Installers also omit the planning tree from the installed
documentation payload.

## Platform validation

The platform workflow runs install, launch, upgrade, reinstall, and uninstall coverage on
Windows, macOS, and Linux. It also exercises terminal behavior, clipboard handling,
narrow-width rendering, suspend/resume, and long-running operation. A release requires
evidence produced by the exact candidate version; relabeling an older report does not
satisfy the gate.

The retained environment record is
[`conformance/windows-linux-2026-08-01.json`](conformance/windows-linux-2026-08-01.json).
Native macOS and Linux conformance must be run and recorded before a public release.

The dependency-bootstrap path must be tested without a compatible system Node.js runtime.
Installers must retrieve an official Node.js 24 LTS archive, verify its checksum, and keep
the runtime inside the per-user installation. Reinstall testing plants stale application
content and persistent-data sentinels to prove that the application payload is replaced
without deleting sessions, configuration, managed runtimes, or user data.

## Reliability and provider validation

The forced-termination procedure in
[`FORCED_TERMINATION.md`](FORCED_TERMINATION.md) interrupts execution at synchronized
journal boundaries and verifies durable-prefix recovery without replaying provider or tool
work. Retain a complete report for every supported native platform and candidate version.

Run the neutrality harness documented in
[`PROVIDER_CONFORMANCE.md`](PROVIDER_CONFORMANCE.md) against at least two independently
implemented OpenAI-compatible providers. In-process fixtures are regression coverage, not
a substitute for live interoperability testing.

Representative constrained-hardware performance measurements should accompany a public
candidate. Use the methodology in [`PERFORMANCE.md`](PERFORMANCE.md); quick-mode results
are only harness smoke tests.

## Human release review

Before public distribution, reviewers should confirm:

1. security-sensitive boundaries and diagnostic redaction;
2. accessibility and terminal behavior on supported platforms;
3. visual quality and interaction consistency;
4. installer and uninstaller behavior with real user data preserved;
5. dependency licenses and notices; and
6. documentation accuracy for the exact candidate.

A private development snapshot may be shared before every public-release gate is complete
when it is clearly identified as unfinished. Apache-2.0 warranty and liability terms still
apply.
