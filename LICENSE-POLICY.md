# Dependency and Redistribution License Policy

Runtime dependencies redistributed in the NodeRag package must have an approved
permissive license. The current allowlist is MIT, Apache-2.0, ISC, BSD-2-Clause,
BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Python-2.0, and PostgreSQL.

GPL, AGPL, SSPL, source-available, unknown, unlicensed, or custom runtime terms
block a release until reviewed and explicitly documented. Development-only
tools are reported separately and do not automatically authorize redistribution.

Run `pnpm license:check` after each dependency change. Regenerate and review
`THIRD-PARTY.md` for every release candidate, including native binaries, model
licenses, and assets that do not appear in the npm lockfile.
