# Troubleshooting and Known Limitations — 1.0.0-rc.1

## Safe diagnosis order

1. Record candidate version and SPK SHA-256, DSM/testbed environment, time, and request ID.
2. Check `/health`, `/ready`, administrator health, jobs, storage, model/build, gateway, backup, and
   restore status before restarting.
3. Collect Package Center lifecycle output and the bounded component logs. Redact credentials,
   document content, raw queries, cookies, API keys, and filesystem paths before sharing.
4. Preserve failed staging, partial downloads, retained relocation roots, backup volumes, old
   clusters, and upgrade markers until their owning runbook identifies a safe cleanup.
5. Reproduce with synthetic fixtures in the exact candidate testbed. If a code/package input must
   change, issue a new release candidate and repeat affected gates.

## Common symptoms

| Symptom                                     | Safe action                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Readiness unavailable or migration mismatch | Stop mutations; verify packaged manifest and logs. Never edit a shipped migration.                  |
| PostgreSQL socket missing                   | Preserve PGDATA/WAL and lifecycle logs; do not enable TCP as a workaround.                          |
| Model digest/ABI failure                    | Disable ingestion, verify the frozen model and Node runtime, and repeat on DSM before release.      |
| Watched source offline                      | Leave indexed data retained, restore the share, crawl again, and review missing items.              |
| Job repeatedly retries                      | Inspect bounded error class/checkpoint; pause or cancel through the API rather than changing rows.  |
| Gateway bind conflict                       | Select an unused 5300–5319 port and reconcile; do not disable authentication.                       |
| Backup not verified                         | Treat it as failed; preserve all volumes and select adequate external space.                        |
| Restore target not blank                    | Use a separate blank target. Never force overwrite.                                                 |
| Rebuild verification fails                  | Keep the active build and staging evidence; correct the cause and start a new proposal.             |
| Resource growth or DSM slowdown             | Pause background work, collect RSS/swap/temperature/disk latency, and revisit measured concurrency. |

## Known limitations

- Release candidate and final v1 target only x86_64 DSM 7.2+; ARM/aarch64 is excluded.
- Supported documents are TXT, Markdown, PDF, DOCX, and XLSX. PPTX, HTML, EML, CSV, XLS,
  standalone images, exact LibreOffice rendering, and finer document ACLs are excluded.
- Embeddings are local only. Ollama is used solely for optional vision.
- No DSM SSO, public package repository, auto-update, Redis, remote embedding provider, or
  cross-encoder reranker is included.
- Docker proves Linux/package behavior but not Package Center, DSM ACL/ABI/storage/reboot, Hyper
  Backup, thermal, or file-sharing behavior. The final DSM checklist remains mandatory.
