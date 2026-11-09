# Incident: workspace-root script execution denial

Date: 2026-11-09. Reported by the operator; investigated across one session.

## Symptom

`.\install.ps1` from the repository root answered PowerShell's execution-policy
refusal — "not digitally signed" — under a RemoteSigned policy, on a local
fixed drive, with no Mark-of-the-Web on the file. The same file executed
without objection when copied to `%TEMP%`, to `D:\ProjectRepo`, or into
selected subdirectories of the repository itself.

## What the investigation ruled out

Every mechanism inspectable without elevation produced clean results:

- No `Zone.Identifier` on the file, the directories, or any ancestor —
  verified three ways (`Get-Item -Stream`, raw `CreateFileW` on the stream,
  and `dir /r`), because a single method can miss exotic streams.
- Execution policy at every scope: MachinePolicy/UserPolicy/Process
  Undefined; CurrentUser/LocalMachine RemoteSigned.
- AppLocker effective policy empty; Smart App Control off; Controlled Folder
  Access off; no site-to-zone assignments in any registry hive.
- File owners, attributes, and (after the operator's `icacls /reset /t /c`)
  ACLs byte-identical between refusing and working directories.
- Brand-new file inodes (created by `type … >` redirection), native PowerShell
  rewrites, `Unblock-File`, and a `subst` drive alias were all still refused —
  so the block was not the file's identity, its stream, or the path string.
- A junction from a fresh parent path into the repository root was refused
  too, which localized the verdict to the directory **object**, not the name.
- Windows' own event log (PowerShell `4100`) showed genuine WinPS 5.1
  ConsoleHost deciding, with no wrapper in `Host Application`.
- A reboot did not clear it, so the verdict was persisted by whatever holds
  it, not an in-memory cache.

## What the decisive experiment showed

Mirroring the entire tree into a **newly created** directory produced a
working root: identical bytes, identical git history, scripts executed. The
refusal was bound to the original root directory object and to directories
created after a specific point in time; directories that predated it (src,
docs, test, resources, .git) and any path above the repository kept working.

The same window contained a foreign ACE on the repository root — an
untranslatable `S-1-4-*` grant plus an `Everyone` delete-tree deny, present
nowhere else on the machine — and a security filter's per-directory verdict
is the one mechanism consistent with every observation: persisted, keyed to
the directory object, invisible to all user-mode inspection, and triggered
around the time the root's security descriptor was rewritten.

## Resolution

The workspace was migrated to a freshly created directory
(`robocopy /E` to a new root, then a rename swap after the process holding a
handle in the old root — a third-party agent daemon — was stopped). Scripts
executed from the new root immediately. The old root was quarantined rather
than deleted, pending any evidence pass an operator may want to run elevated
(`fltmc instances`, ProcMon filtered on the refused path with
`Result = ACCESS DENIED`).

## Prevention

The plausible origin of the trigger — a test fixture rewriting a directory
security descriptor outside its scratch root when a runner dies mid-mutation
— is closed structurally: `test/scratch.js` now owns `assertScratchPath`,
which refuses any ACL mutation targeting a path outside the scratch root, and
`armScratchRestore`/`disarmScratchRestore`, which re-apply a captured
descriptor at process exit if a mutation is still armed. The one test that
replaces a whole DACL arms the restore before replacing and disarms in its
`finally`.

## If it recurs

- Reproduce the per-directory boundary first: one probe file in the refusing
  directory and one in a known-working directory, same bytes.
- Elevated: `fltmc instances` to enumerate attached filters on the volume;
  ProcMon filtered to the refused path with `Result = ACCESS DENIED` names
  the deciding driver on the spot.
- The migration recipe above (mirror to a fresh directory, swap names) is
  the proven repair and costs about a minute for this tree.
