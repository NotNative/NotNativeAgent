# Live provider conformance

NNA includes a vendor-neutral live-server harness for the `PROV-012` release gate. It
runs the same bounded model-enumeration, streaming-text, and structured tool-call cases
through NNA's generic OpenAI-compatible adapter. It does not use vendor SDKs or shims.
Provider-facing tool definitions use the broadly implemented JSON Schema subset needed
for grammar generation. Stricter execution bounds remain mandatory in NNA's local
validators when a compatible server cannot compile the equivalent schema annotation.
In-band SSE error envelopes are converted to stable local provider failures without
retaining or displaying provider-controlled error text.

Create a private JSON input containing two to eight provider entries. The
`implementation` and `implementation_version` fields are operator attestations: the
harness requires different implementation names but cannot independently prove their
lineage.

```json
{
  "schema_version": 1,
  "providers": [
    {
      "id": "first",
      "implementation": "implementation-one",
      "implementation_version": "1.0",
      "endpoint": "http://127.0.0.1:1234/v1",
      "model": "model-one",
      "tool_call_mode": "single",
      "trust_zone": "loopback"
    },
    {
      "id": "second",
      "implementation": "implementation-two",
      "implementation_version": "2.0",
      "endpoint": "http://127.0.0.1:11434/v1",
      "model": "model-two",
      "tool_call_mode": "batch",
      "trust_zone": "loopback"
    }
  ]
}
```

`tool_call_mode` defaults to `single`. Use `batch` only when the provider rejects
`parallel_tool_calls: false`; the adapter then omits that wire field. NNA still validates,
reviews, and settles every returned tool call.

When a server requires authentication, use a Secret Broker `credential` binding in normal
operation. The advanced `credential_env` compatibility field contains an environment-variable
name, never a secret. Run:

```text
npm run provider:conformance -- --config PRIVATE_INPUT.json --output RETAINED_REPORT.json
```

The report includes the product version, declared implementation identities, endpoint
origins, model names, timings, event counts, byte counts, and stable failure codes. It
does not retain prompts, responses, reasoning, tool arguments, credentials, or provider
error bodies. A passing report is technical evidence, not proof that the two operator-
declared implementations are independent; release reviewers must verify that claim and
retain the input/report outside the distributed product tree.

Trusted loopback and private-network entries use NNA's deadline-owned local HTTP transport.
It does not impose a client-library body-idle cutoff on buffered reasoning, but it retains the
adapter byte ceiling and immediate cancellation. Successful content-free health probes renew
the inherited trusted-local no-byte lease without fabricating model output or overriding an
explicit operator deadline. Failed probes leave the lease unchanged.
