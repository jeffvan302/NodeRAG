# Third-Party Notices

This milestone establishes the notice process; release notices are generated
from the exact lockfile and manually supplemented for non-npm artifacts.

Current direct runtime components include Fastify (MIT), Pino (MIT), PostgreSQL
client `pg` (MIT), node-pg-migrate (MIT), Preact (MIT), Zod (MIT), and the
Qwen3-Embedding-0.6B model (Apache-2.0). PostgreSQL and pgvector use the
PostgreSQL License. Transitive identities and versions are locked in
`pnpm-lock.yaml`.

Before a release:

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm license:check` and retain its machine-readable evidence.
3. Review all runtime packages returned by `pnpm licenses list --prod --json`.
4. Add notices for the pinned Node runtime, PostgreSQL, pgvector, ONNX Runtime,
   Qwen model/tokenizer, UI assets, and any bundled native libraries.
5. Block packaging if a runtime license is unknown or outside
   `LICENSE-POLICY.md`.
