# M6 implementation checkpoint

M5 closed in `337ba40`, following deployed candidate `2b0a436`. M6 implements
the fixture-driven downstream report boundary only. Staged v1 remains
authoritative; rollout defaults to `disabled`; no real Phase 2 provider request,
normal v2 claim, Task Dataset publication, or generated-file publication is
introduced.

## Ordered work

- [x] Build an immutable Phase 3 `ReportDataSnapshot` from a frozen base
      generation plus staged replacements and removals. Canonical identities,
      temporal periods, conflicts, cardinality, ordering, totals, and source
      projection are deterministic and digest-bound.
- [x] Prove replacement and removal do not double-count and that changing only
      the report period reuses the exact Phase 2 terminal digests and dataset-view
      digest without requesting extraction again.
- [x] Preserve optional empty sections while converting missing required
      cardinality and required conflicts into structured gaps. A snapshot with a
      required gap is non-publishable and cannot enter the render receipt path.
- [x] Make the Phase 4 boundary accept only a verified snapshot. Direct scalar,
      aggregate, collection, source-register, and bounded narrative bindings are
      compiled without source Markdown or live Task Dataset access.
- [x] Render the retained Town Manager fixture through the deterministic DOCX
      engine with exact source/contract/presentation identities. Word comments are
      removed, images and section layout remain present, and unresolved required
      bindings fail closed.
- [x] Normalize DOCX ZIP timestamps. A deliberately changed wall clock now
      produces the same logical-package digest and identical downloadable bytes.
- [x] Persist synthetic snapshot and render receipts through service-role-only
      RPCs. Exact retries reuse the original rows; changed retries are rejected;
      render receipts never publish a generated file.
- [x] Pass the disposable PostgreSQL `--m6-report-renderer` proof, including
      backup/restore and database-process restart verification. It records two
      snapshots, rejects required-gap rendering, emits three bounded transition
      events, and makes zero provider calls.
- [x] Pass repository tests, typecheck, build, docs validation, Phase 9 contract
      validation, PostgreSQL acceptance, and PostgREST acceptance. The release
      package contains 136 pinned core migrations, 170 application tables, 268
      functions, and 438 owned objects.
- [x] Commit, push, deploy to staging, verify the active database head/checksum
      and service health, confirm rollout remains `disabled` at activation epoch
      zero with claims/publication false, and record the machine-readable M6 proof.
      Candidate `f387b9e` passed GitHub tests and the staging migration workflow;
      all five deployed services, public health, and embedding smoke are healthy.

## Development validation commands

The focused M6 database proof includes the M5 deferred graph as its synthetic
producer and then exercises persisted Phase 3/4 receipts:

```text
pnpm test:railway-postgres -- --m6-report-renderer
```

The report materializer and renderer are also covered by the normal rag-core,
DOCX-engine, and web test suites. M6 is not closed until the staging deployment
and live inactive-control verification are recorded.
