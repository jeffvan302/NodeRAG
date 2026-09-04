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

Authorization is fail-closed. Silo `read`, `upload`, and `delete` capabilities
are independent and are narrowed—never widened—by gateway and request scope.
Row-level security covers sources, documents, pages, images, and both the
partitioned chunk parent and direct silo partitions. Zero grants means zero
silos, including for otherwise authenticated principals.

NodeRag stores password verifiers with Argon2id and never stores raw session or
API-key tokens. Provider secrets use AES-256-GCM under a package-local root key;
external responses expose only existence and a keyed fingerprint. Audit rows
store normalized query hashes rather than query text and remove credential-like
detail keys before insertion. The root key, database credentials, setup token,
session values, CSRF values, and API keys must be handled as secrets and must
never enter logs or source control.

The WSL/Docker testbed is not a security certification for DSM. Package
identity, filesystem ACLs, runtime ABI, lifecycle, port exposure, backup,
recovery, and service impact remain release-blocking live checks.
