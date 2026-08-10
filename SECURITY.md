# Security policy

NotNativeAgent treats models, repository content, retrieved data, MCP servers, and tool
output as untrusted. Tool execution always crosses the mandatory reviewer and private
ledger; interactive approval is scoped to one immutable request and is not proof that an
operation is harmless.

Operating-system elevation is available only to the local interactive root Console. Each
request seals one executable, argv, working directory, reason, expected effect, and deadline;
it then requires both semantic approval and a new local human confirmation before invoking
Windows UAC or `sudo`. Elevation grants cannot be remembered, credentials never enter model
context, and no reusable privileged shell or service is created. Hosted, headless, Telegram,
and sub-agent surfaces do not receive the elevation tool.

Report suspected vulnerabilities privately to the distribution channel from which this
copy was obtained. Include the version, platform, stable failure codes, and a minimal
reproduction. Do not include live credentials, private prompts, or diagnostic bundles
unless a secure channel has been agreed explicitly.

There is no automatic update checker. Operators must obtain updates from an authoritative
distribution, verify published hashes, review release notes and integrity metadata, and replace
the installation through their normal package-management process.
