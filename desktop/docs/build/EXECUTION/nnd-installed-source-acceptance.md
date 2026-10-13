# Disposable installed source acceptance

This Windows-only acceptance runs the real `install.ps1` against a fresh NND
target and a private, source-composed installed NNA fixture. It does not use a
mock native service or modify the operator's NNA registration. It tests the
source installer, not the immutable prebuilt activation or upgrade path.

From the NNA repository (`desktop/` since the 20261012-2 fold), with Node 24+ and pnpm:

```powershell
cd desktop
node scripts/installed-source-acceptance.mjs ..
```

The NNA source root is now the enclosing repository itself (`..` from `desktop/`); a
positional argument still overrides it for external fixtures.

The harness creates `~/nnd-installed-acceptance-fixtures/installed-accept-<random>`, outside the NND source
checkout and shared project volume, with a private Windows
ACL, copies the NNA source payload there, and writes a descriptor selecting its
own NNA data root. It passes explicit NNA and NND roots plus `-ShortcutRoot` to
the real installer. The override requires a marked, absolute, non-reparse
disposable directory; both Desktop and Start Menu shortcut files stay inside
that fixture. Temporary, package-manager, and Electron profile paths also
point into the fixture.

After installer verification, the harness obtains a fresh native UI ticket
without logging it. An isolated Electron Chromium browser partition loads the
installed service origin and submits the actual Native code form. A second
partition must remain unauthenticated. A separate launch of the installed
desktop shell must attach through its selected NNA, expose no renderer bearer,
and leave the original service generation running after it exits. The harness
then stops that service and waits for both native discovery and the service
lease to clear before deleting the exact verified fixture directory. If
process or service shutdown is uncertain, it preserves the fixture and prints
its path for diagnosis.

The browser step proves the application form in isolated Chromium, not a
separately installed Chrome or Edge profile. It does not exercise real provider
traffic; a fresh NNA installation may remain in `setup_required` state.
