# Security Policy

NodeRag is currently private and pre-release. Report suspected vulnerabilities
through the repository's private GitHub security reporting channel; do not open
a public issue containing exploit details, credentials, document contents, or
NAS configuration.

Never commit production documents, database dumps, vectors, model files,
passwords, API tokens, session data, or generated package runtime state. Local
development secrets belong only under ignored paths. HTTP authorization,
cookies, request bodies, database URLs, and password material are redacted from
structured logs by default.

The WSL/Docker testbed is not a security certification for DSM. Package
identity, filesystem ACLs, runtime ABI, lifecycle, port exposure, backup,
recovery, and service impact remain release-blocking live checks.
