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

That replacement (`52a8286207126940f6bf0501ae881f8dc7fbd33c`, workflow
`33940757425`, artifact SHA-256
`c8431e0c161be386346a8036bf9a8b878f26d56eb21275c46eab41fd1cb48b21`) passed all five
authoritative jobs and the exact-SPK lifecycle. Its new soak collected 4 clean samples from
`2026-09-05T03:09:44.260Z` through `2026-09-05T03:13:04.684Z` before setup review found another
release-input defect: the browser had no Ollama Cloud API-key field, and a full `/api/chat` address
would be expanded to `/api/chat/api/chat`. That run is also aborted and non-certifying.

The API-key replacement candidate (`9e7936d25b8d11d40abc991eed93891dd7516404`, workflow
`33941658595`, artifact SHA-256
`848b0ebb930d24d7f08cf5c3b4d1bcb67bbce864af1ee707df7563284a38f3f3`) passed all five jobs and
the exact-SPK lifecycle. Its soak collected 3 clean samples from `2026-09-05T03:27:34.755Z`
through `2026-09-05T03:29:54.492Z`. Live administration review then found that knowledge spaces,
system settings, storage, and vision were effectively read-only JSON/list views, the requested
vision parallel-call count had no form control, administration sections lacked explanations,
evaluation cards were white-on-white in dark mode, and Ingest did not explain whether a connected
folder was an input source or managed storage. That run is also aborted and non-certifying; its
preserved evidence SHA-256 is
`2dcbe82ac69316cf0436fcbe58ace660e843efc326f2c7fe86d11212cb9c50f2`.

The administration correction at commit `e6237729c83eef349ef437358f6e43eb576e63e8`
(workflow `33943115114`, artifact SHA-256
`8ba5b120ed0227cebcfbbfacc20db9291afa85c4ebe26edcf8c71c892570af67`) passed all five jobs and
the exact-SPK lifecycle. Its soak collected 8 clean samples from `2026-09-05T04:00:35.606Z`
through `2026-09-05T04:07:57.895Z`. Live provider setup then exposed a source-checkout dependency
on `packages/server/fixtures/formats/images/table.png`; the administrator also requested a site
icon and selectable light, dark, green, blue, and red schemes. That run is aborted and
non-certifying. Its preserved evidence is
`docker-testbed/artifacts/m14/m14-soak-aborted-e623772-vision-fixture-theme-controls.json` with
SHA-256 `2d708b666f97f1829d531e0954e44595d5b58facdd30442ffb401e365844961c`.

The current correction adds API-backed knowledge-space creation/editing, explained system-setting
forms, storage probe/create/edit controls with path/purpose locking after recovery references,
complete vision provider controls including encrypted-key replacement and 1–16 parallel calls,
dark-theme evaluation contrast, and explicit input-folder versus managed-storage guidance. The
latest follow-up replaces the runtime fixture read with a deterministic server-embedded activation
PNG, adds the NodeRag `N` favicon, and adds five per-user browser color schemes. The complete local
quality gate, 92 unit tests, 51 PostgreSQL integration tests, and all 9 browser journeys pass.
Authoritative CI evidence, a new exact artifact, and a fresh 86,400-second soak remain required.

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
