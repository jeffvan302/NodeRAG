# M14 Immutable Testbed Release-Candidate Checklist

## Current disposition

The otherwise-green candidate at commit `851e1ebec2fa714916e177038ae466ed69b038ee`
(GitHub Actions run `33934085268`, artifact SHA-256
`1199458284be797469a1c2ae82d8a104fc49856e3e076a2892cf1c3b93b99595`) was invalidated during
live first-run testing. Setup step 6 sent 20 calibration samples through a framed protocol limited
to 16 items, which produced an internal error. The recovery-code screen also made the boundaries
of the complete one-time code unclear.

The client now splits embedding and token-count work into protocol-safe frames and has a real
20-item framed-process regression test. The setup UI now exposes the entire recovery code in a
selectable read-only field with explicit start/end markers, a `Copy full recovery code` control,
and clipboard confirmation. Local quality, 90 unit tests, 51 PostgreSQL integration tests, and 6
browser tests pass.

The invalidated soak ran from `2026-09-05T01:17:54.952Z` through
`2026-09-05T02:51:22.076Z`, collecting 93 clean runtime samples, but it is non-certifying because
the candidate was defective. None of the release-closure boxes below may be checked from that run.
A replacement commit must pass the authoritative workflow, its exact downloaded artifact must pass
qualification, and a fresh 86,400-second soak must complete before release closure.

- [ ] Candidate version is `1.0.0-rc.1`; SPK version is `1.0.0-1` with beta marker.
- [ ] Node 22 remains supported; official source/date/EOL are recorded.
- [ ] Lockfile, migrations/head, OpenAPI, routes, settings defaults, parser revisions, model,
      package metadata/runtime recipe, SBOM, notices, and release notes are frozen and verified.
- [ ] Clean Linux checkout installs with `--frozen-lockfile` and no untracked input.
- [ ] Type, lint, format, boundaries, unit/property, build/smoke, licenses, SBOM, secrets, and repo
      hygiene pass.
- [ ] Complete PostgreSQL/pgvector integration, UI E2E, M12 evaluation, M13 recovery, and 16→17
      rollback suites pass.
- [ ] Production SPK builds twice with identical SHA-256.
- [ ] Archive, metadata, native modules, private socket, bundled `pg_dump`, and release manifests pass.
- [ ] Fresh non-root exact-SPK lifecycle completes first-run setup without shell intervention.
- [ ] Five formats, Unicode, images/scan fallback, REST, MCP, gateway, UI, audit, capabilities,
      missing source, reindex, purge, rebuild, backup, restore rehearsal, restart, and upgrade pass.
- [ ] Exact-SPK soak runs at least 86,400 seconds with no fail condition.
- [ ] Scheduled crawl, background ingest/search, Ollama interruption/recovery, locator verification,
      verified backup, log rotation, competing I/O, and resource bounds are evidenced.
- [ ] Git inspection excludes secrets, documents, models, backups, vectors, generated runtime, and
      `docs/RailwayRagDocs/`.
- [ ] SPK, checksum, SBOM, notices, manifests, proof, and all release guides exist.
- [ ] Final candidate commit is pushed and its complete GitHub M14 workflow is green.
- [ ] Annotated `v1.0.0-rc.1` tag points to the recorded candidate closure commit.
- [ ] Private prerelease assets match the proof/checksum.
- [ ] Tagged candidate starts fresh and reports the recorded health version.
- [ ] `m14-proof.json` says `gate=passed`, `certification=testbed-complete`,
      `releaseAuthorized=false`, and `dsmCertificationRequired=true`.
- [ ] No `v1.0.0` tag or DSM certification claim exists.
