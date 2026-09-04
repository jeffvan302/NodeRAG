# Synology package workspace

Milestone 10 adds the production candidate builder in `scripts/build-m10-spk.sh`. The candidate embeds the pinned DSM x64 PostgreSQL 17.11/pgvector 0.8.6 runtime, Linux x64 ONNX runtime, application bundles, UI, migrations, notices, DSM metadata, wizards, and lifecycle controls. It requires no package-manager or dependency download during install/start.

The legacy thin builder remains solely as an earlier-milestone regression fixture. Release work must use `pnpm package:candidate` followed by `pnpm package:candidate:verify`; live DSM certification waits until the immutable M14 candidate.

`noderag/` is the thin Milestone 2 package definition. The deterministic Linux
builder creates a DSM `.spk` archive, inspects it, and exercises its lifecycle
inside a non-root container. This is package-format and lifecycle-simulation
evidence only.

`vendor/spksrc` is pinned as a Git submodule. The thin recipe records the future
spksrc integration point; the complete PostgreSQL/pgvector production package
is deliberately built in Milestone 10 after application behavior stabilizes.

Generated archives and extracted work directories live in ignored
`spk/artifacts/` and `spk/work/` paths.
