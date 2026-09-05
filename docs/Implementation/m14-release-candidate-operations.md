# Milestone 14 Release-Candidate Operations

## Immutable inputs

`platform/release-candidate.v1.json` declares the candidate, runtime, artifact name, certification
boundary, and freeze inputs. `platform/release-freeze.v1.json` records deterministic SHA-256 values
and a path/digest aggregate. Run `pnpm release:freeze:verify` in every clean build. Any frozen input
change requires regeneration, complete regression, a fresh SPK, a new soak, and a new RC number if
the prior candidate was distributed.

The PostgreSQL runtime archive is integrity-checked against its generated SHA-256 sidecar and its
inner per-file `SHA256SUMS` manifest. The release proof records the SHA-256 of the exact SPK uploaded
by the authoritative M14 CI run. Do not use a runtime-archive checksum produced on a different host
as a release gate: native Linux and WSL/QEMU cross-compilation are separate build environments even
when their sources and toolchains are pinned. The release invariant is two identical SPK builds in
the authoritative pinned CI environment followed by checksum verification of the uploaded artifact.

## Build and quick qualification

From clean Linux/WSL with Docker:

```text
pnpm install --frozen-lockfile
pnpm ci:quality
pnpm test:integration
pnpm test:e2e
pnpm evaluation:m12
bash docker-testbed/scripts/verify-m13.sh --docker
NODERAG_M10_REUSE_RUNTIME=1 pnpm package:candidate
pnpm package:candidate:verify
```

Build twice and require identical SPK hashes. The package verifier inspects metadata, scripts,
runtime, migrations, OpenAPI, SBOM, notices, release manifests, native dependencies, and then runs
the clean non-root lifecycle with the production bundle.

## Genuine soak

Validate the harness with a fixed 90-second, non-certifying profile:

```text
bash docker-testbed/scripts/m14-soak.sh validate
```

The `validate` action sets its duration inside the WSL script, so it does not depend on Windows
environment-variable forwarding. Its proof always carries `validationMode=true` and
`minimumDurationSatisfied=false`; it cannot close M14.

Start the candidate only after quick qualification and an exact commit has passed CI:

```text
bash docker-testbed/scripts/m14-soak.sh start
bash docker-testbed/scripts/m14-soak.sh status
bash docker-testbed/scripts/m14-soak.sh logs
```

The `start` action defaults to 86,400 seconds. The runner refuses a shorter certification run unless
the explicit development-only override is supplied from within WSL. Never use override output as
release evidence.

The exact SPK runs as UID/GID 1000 with a read-only container root, no Linux capabilities,
`no-new-privileges`, fresh package data, and the bundled private PostgreSQL runtime. Evidence is
written under ignored `docker-testbed/artifacts/m14/`.

If live qualification exposes any release-blocking defect outside the soak workload, stop the soak
and retain its evidence as an aborted, non-certifying run. Even a healthy partial run cannot be
continued across a source fix. Regenerate the freeze, pass the authoritative workflow, download and
verify its exact replacement artifact, discard the prior disposable soak volume, and start a fresh
86,400-second run.

Fail immediately on health degradation, cross-silo results, locator mismatch, terminal job failure,
stale lease, backup failure, source schedule failure, search/MCP/gateway drift, process restart
failure, unobserved log rotation, memory above 1.5 GiB per service, or package state above 2 GiB in
the bounded synthetic workload.

## Release closure

1. Import the passing soak evidence into `m14-proof.json` without raw secrets or documents.
2. Confirm the repository contains no generated runtime, model, backup, vector, private corpus,
   secret, or Railway reference file.
3. Commit and push the final candidate state, then require every M14 GitHub job to pass on that
   exact commit.
4. Build/download the exact CI artifact, compare its checksum with the proof, and repeat fresh
   package health identity.
5. Create annotated tag `v1.0.0-rc.1` and a private prerelease with SPK, checksum, SBOM, notices,
   release notes, M14 proof, and final DSM checklist.
6. Do not create `v1.0.0`. Continue with the live DSM checklist using the unchanged SPK.
