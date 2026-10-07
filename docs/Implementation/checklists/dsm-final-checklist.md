# Final DSM Certification Checklist

**Status:** Ready for live Synology acceptance; not yet DSM-certified

## Exact candidate identity

- Release candidate: `v1.0.0-rc.1`
- Package: `noderag-1.0.0-46-x86_64.spk`
- Package version: `1.0.0-46`
- Candidate source commit: `13d4b5b8b367865e273d914a89a27fb64d4e9798`
- Required SHA-256: `bd5c430181fe9042bf57a77c7b4b431d106fd79fe954cd5afab22271df738011`
- Minimum DSM: `7.2-64570`
- Architecture: `x86_64`
- Network scope: trusted LAN only; remote/WAN access is excluded from version 1

Use only this exact prerelease SPK. Verify its SHA-256 before installation and again after any file
transfer. A mismatched checksum, source change, or package rebuild creates a different candidate
and invalidates the acceptance run.

Record evidence in `dsm-final-proof.json`; do not copy Docker results into live fields.
Version 1 certifies trusted-LAN use only; remote/WAN access and public TLS are out of scope.

## Before starting

- [ ] Confirm the SPK SHA-256 exactly matches the required value above.
- [ ] Record the NAS model, DSM build, test start time, installed Node.js version, and whether this
      is an upgrade or clean installation in `dsm-final-proof.json`.
- [ ] Use synthetic documents and dedicated provider credentials. Never record setup keys, API
      keys, OAuth tokens, backup passphrases, cookies, or private document contents in evidence.
- [ ] Open the application from the trusted LAN at `http://<NAS-IP>/noderag/` after Package Center
      reports NodeRag running.

## Acceptance checks

- [ ] NAS model, DSM build, x86_64 CPU/features, cores, RAM, volumes, filesystems, encryption, ACLs,
      free space, and ports recorded.
- [ ] Synology `Node.js_v22` availability/support and `onnxruntime-node` loading proven on DSM.
- [ ] Pinned 1,024-element embedding correctness plus q8/q4/fp16 throughput, p50/p95, RSS, CPU,
      swap, temperature, and DSM responsiveness recorded.
- [ ] Cross-built PostgreSQL 17.11/pgvector 0.8.6 initdb, private socket, halfvec insert/search,
      restart, and package-user shutdown pass.
- [ ] Argon2id is calibrated on the NAS and any settings migration is recorded.
- [ ] Package identity, run-as-package, resource/data-share, firewall, port, UI, log, and lifecycle
      behavior pass.
- [ ] Approved `/volumeN` ext4/btrfs/encrypted paths pass ACL, fsync, capacity, relocation, and
      rollback checks.
- [ ] Package Center install and shell-free setup pass with every format, vision, all searches,
      REST, MCP, gateways, UI, permissions, audit, missing source, reindex, purge, and rebuild.
- [ ] Service/package/NAS restarts during normal work and durable operations recover correctly.
- [ ] Same-major upgrade, failed-start recovery, backup, blank restore, rollback, retained uninstall,
      destructive uninstall, and reinstall pass.
- [ ] Versioned M12 quality/performance baseline is repeated through the installed SPK.
- [ ] Minimum 1-hour live DSM soak passes alongside ordinary administration and file sharing.
- [ ] No test weakens or failure is waived. Any product defect produces a new RC and affected retest.
- [ ] Final proof is complete, evidence-only closure is green, and only then is `v1.0.0` tagged and
      the private certified release created.
