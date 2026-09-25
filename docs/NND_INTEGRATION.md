# Local NND integration

`nna nnd serve` starts NNA's authenticated loopback service for a local
NotNativeDesktop process. NND owns the child process and reads one JSON
readiness line from stdout. The line contains protocol `1.0`, the loopback
endpoint, an instance ID, and an ephemeral bearer token. Diagnostics use
stderr. NND must keep the token in its server process.

NNA loads its configured manifest and constructs the governed session engine
before it emits readiness. Missing or invalid configuration fails startup.
Requests need both the bearer token and a fresh `X-NNA-Principal` envelope;
the route layer checks the permissions and workspace grants.

`nna integration serve` remains the NNO-owned entry point. It still requires
an installed NNO activation. The NND command has a separate NNA-owned local
activation and does not change NNO's installation contract.
