# M08 Decision — Keep Row-Level Security on Chunks

Status: accepted in the Docker testbed

Recorded: 2026-09-04

## Decision

Keep PostgreSQL row-level security enabled and forced on the chunk parent and every silo partition. Continue to require `SiloScope` and per-transaction `app.silo_ids` as defense in depth.

## Evidence

The integration benchmark created eight realistic silo partitions and 8,500 `halfvec(1024)` chunks. The target partition contained 5,000 chunks. After ten warmups, the test alternated 160 RLS-on/off HNSW samples to reduce ordering bias. Each sample averages ten PostgreSQL-reported `EXPLAIN ANALYZE` execution times, excluding client/network and transaction setup time.

- RLS-on p95: 0.2018 ms
- RLS-off p95: 0.1970 ms
- Relative p95 overhead: 2.44%
- Required maximum overhead: 15%
- Target silo partition retained in the JSON query plan: yes
- HNSW index retained in the JSON query plan: yes
- Approximate-versus-exact Recall@10: 0.90

The measured overhead is below the threshold and the plan retains both required isolation/performance properties. The diagnostic and its decision are also written to `noderag.retrieval_diagnostic` by the executable test.

## Revisit conditions

Reopen this decision if a PostgreSQL/pgvector upgrade, partition strategy change, embedding dimension/model change, representative corpus growth, or DSM measurement produces either p95 overhead above 15% or a plan that loses target-partition/HNSW use. The fallback is metadata RLS plus mandatory application scope and per-silo partition isolation; it may not be selected without a new recorded measurement.

This is a testbed decision, not a DSM performance claim. The final DSM certification repeats representative search measurements with the immutable release candidate.
