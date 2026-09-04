# Synology package workspace

`noderag/` is the thin Milestone 2 package definition. The deterministic Linux
builder creates a DSM `.spk` archive, inspects it, and exercises its lifecycle
inside a non-root container. This is package-format and lifecycle-simulation
evidence only.

`vendor/spksrc` is pinned as a Git submodule. The thin recipe records the future
spksrc integration point; the complete PostgreSQL/pgvector production package
is deliberately built in Milestone 10 after application behavior stabilizes.

Generated archives and extracted work directories live in ignored
`spk/artifacts/` and `spk/work/` paths.
