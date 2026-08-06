# Secret broker

## Decision

NNA owns a standalone secret broker because NNA must remain useful without NNO. NNO is a policy issuer and management client of that broker; it does not own the underlying secret store.

The local Console manages only the `nna.local` realm. NNO-managed realms use `nno:<deployment-id>` and are not enumerable or usable through the local Console. Realm separation is enforced by the broker API and by independently derived encryption keys.

## Storage and disclosure boundary

Secret fields are encrypted independently with AES-256-GCM. The authenticated metadata binds each ciphertext to its realm, record, field name, key version, and vault format. The portable file key is a compatibility fallback, not equivalent to an operating-system credential vault.

Normal reads return metadata only: identifier, label, kind, field names, state, and timestamps. Plaintext is available only inside `SecretBroker.withSecret(...)`, which requires a trusted consumer, destination, purpose, and reviewer decision identifier. It is never returned by a model-facing tool or management response.

While a trusted consumer is using a secret, exact values and their common encoded representations are registered with the central redactor. Lifecycle audit events contain identifiers and decisions, never secret values.

## Console behavior

`/secrets` is a keyboard-driven, write-only manager for local secrets. Operators can create, rotate, revoke, enable, and delete records. Existing values are never displayed. Secret management is restricted to the Main conversation.

## NNO integration boundary

NNO's browser must call its authenticated backend. The backend may then call NNA's authenticated broker management API using a signed NNO identity assertion. NNA must validate the issuer, audience, deployment realm, subject, tenant/workspace scope, roles, permissions, expiry, and request binding before every operation.

Management endpoints may accept new values but must never return stored values. Runtime secret use remains a separate trusted-consumer flow so the model, browser, NNO module code, hooks, transcripts, and support bundles do not receive plaintext.

## Failure behavior

- Invalid vault structure or authenticated-decryption failure is fail-closed.
- Revoked or missing records cannot be used.
- Cross-realm access appears unavailable through supported interfaces.
- Reviewer bypass modes do not bypass the disclosure boundary.
- Audit and redaction failures must not cause a secret value to be logged as diagnostic context.
