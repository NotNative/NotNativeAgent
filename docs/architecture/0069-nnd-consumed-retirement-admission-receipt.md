# NND consumed retirement admission receipt

Status: accepted. Depends on: ADR 0064, ADR 0065, ADR 0066, ADR 0067.

ADR 0065 fixed that the terminal commit and cleared witness remain durable and
that ordinary startup keeps rejecting either file independently. It also
reserved one transition: once the live admission gate and public controller
have reconciled, ordinary startup may treat the cleared witness as an admission
receipt. This ADR is that transition, and it is deliberately narrow.

`assertNoNndInstallTransaction` now consumes a retirement evidence pair only
when all of the following hold simultaneously:

- both `activation-retirement-commit.json` and
  `activation-retirement-cleared.json` exist as regular, link-free files;
- each is byte-canonical (`JSON.stringify(value) + '\n'` equals its bytes) with
  the exact ADR 0064/0065 key sets and states
  (`terminal_committed_barred` / `barriers_cleared_admission_barred`);
- every field mirrors between the two files except `state`, which is validated
  per-file against its own canonical shape;
- the witness `terminal_sha256` equals the SHA-256 of the commit's exact bytes;
- both files bind this installation's `installation_id` and `data_id`.

Any other observation keeps the admission bar exactly as before: either file
alone, an altered byte, a foreign identity, a leftover decision or plan file,
or any activation inventory entry. Consumption never deletes or rewrites the
pair; it remains durable external evidence and a later crash observer must
still reconcile it before granting authority. No controller grant, native
admission open, credential rotation, or new process selection follows from
consumption alone.
