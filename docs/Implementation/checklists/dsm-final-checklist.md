# Final DSM Certification Checklist

Use only the exact `v1.0.0-rc.1` prerelease SPK and verify its recorded SHA-256 before install.
Record evidence in `dsm-final-proof.json`; do not copy Docker results into live fields.
Version 1 certifies trusted-LAN use only; remote/WAN access and public TLS are out of scope.

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
