# M00 — WSL/Docker Testbed Foundation Checklist

Status: awaiting proof-closure CI and milestone tag
Environment: Docker testbed
Recorded: 2026-09-04T05:37:14Z

## Repository and documentation

- [x] `docker-testbed/` owns Compose code, scripts, fixture policy, runtime paths, artifacts, and testbed planning.
- [x] Root `.gitattributes` establishes LF for Linux/DSM sources and binary handling for artifacts.
- [x] Generated secrets, runtime state, and artifacts are excluded from Git.
- [x] The staged plan defines M0–M14 as testbed milestones and final DSM certification as the v1.0.0 gate.
- [x] The original architecture and implementation planning documents use the same sequence.

## Environment and security

- [x] Windows, WSL, Docker, CPU, RAM, architecture, and disk baseline recorded.
- [x] Docker is callable from WSL; the selected transport is recorded.
- [x] PostgreSQL is exposed only on `127.0.0.1:55432`.
- [x] The database password is generated locally, never printed, ignored, and untracked.
- [x] Native Linux uses mode 0600; the current Windows-mounted checkout uses a current-user-only NTFS ACL.
- [x] No production credentials, documents, models, backups, or vectors are included.

## Database and lifecycle

- [x] PostgreSQL/pgvector image pinned to an immutable linux/amd64 digest.
- [x] Image source, license, creation time, size, PostgreSQL version, and pgvector version recorded.
- [x] Compose configuration passes validation.
- [x] PostgreSQL reaches healthy state.
- [x] `vector` extension exists.
- [x] `halfvec` insert and similarity query pass.
- [x] Stop/start preserves a unique database marker.
- [x] Normal shutdown preserves the named volume.
- [x] Reset refuses to run without explicit destructive confirmation.
- [x] Status and log commands work.

## Quality and delivery

- [x] All testbed shell scripts pass Bash syntax validation.
- [x] Local M0 validation suite passes.
- [x] Git diff and secret hygiene checks pass.
- [x] Clean-checkout GitHub Actions workflow added.
- [x] M00 implementation commit pushed to `main`.
- [x] GitHub Actions passes on the exact implementation commit.
- [x] `m00-proof.json` updated with commit and workflow evidence.

After every unchecked item above is complete, push the proof-closure commit, require its own workflow to pass, and create the annotated `m00-complete` tag. These externally verifiable delivery events are the final M00 gate; M01 is not authorized before they succeed.
