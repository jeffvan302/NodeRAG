# PostgreSQL/PostgREST Portability Phase 9: Live Certification

Implemented: 2026-08-29.

Phase 9 supplies the live-certification contract, evidence format, release gate,
and safe Railway observation tooling for PostgreSQL/PostgREST portability. The
software implementation is complete; the portability claim remains pending
until the complete staging matrix has passed and received independent review.

## Delivered certification boundary

- `platform/data-plane-certification.v1.json` is the canonical 34-scenario
  matrix. It covers installation, placement, sleep/cold start, attachment,
  both transfer directions, failure recovery, schema play-forward, cleanup,
  decommissioning, and recovery-artifact retention.
- Every scenario identifies its risk and exact evidence classes. Destructive
  scenarios cannot be valid unless they include a separate explicit approval
  record.
- The shared evaluator binds a report to the exact contract checksum, rejects
  missing or additional scenarios, requires every row to pass, checks the
  required evidence classes, and requires a reviewer other than the executor.
- Evidence references are limited to redacted, immutable JSON artifacts under
  `certification/phase9/evidence/`. The strict verifier confirms each file is
  present, parses its safe envelope, verifies its SHA-256 checksum, and checks
  that its scenario, type, and timestamp match the report.
- Railway template release metadata declares Phase 9
  `pending_live_evidence` and forbids advertising portable placement. Changing
  the label to `certified` without a complete valid report fails the gate.
- Normal CI runs `pnpm phase9:check` to validate the contract and template
  declaration. The release operator runs `pnpm phase9:certify` for the strict
  all-evidence gate.
- A forward-only readiness migration advances installations that already
  applied the Phase 5 transfer-marker table but remained on the prior
  platform-version pointer. Historical migration checksums are not changed.

## Safe Railway evidence collector

The collector reads the already-linked Railway project, removes variables,
credentials, raw logs, and deployment configuration, and retains only the
project/environment identity, service state, source revision, sleep setting,
and volume observations. It refuses to overwrite an evidence file.

For the local-idle scenario it also fails unless `postgres-sql` remains online
with Railway sleep disabled while `postgrest` has Railway sleep enabled and is
actually reported as sleeping:

```powershell
pnpm phase9:collect:railway -- --scenario local_idle --output certification/phase9/evidence/local-idle-YYYY-MM-DD.json
```

The command prints the exact evidence entry, including the artifact hash, to
place in the certification report.

## Evidence already observed

On 2026-08-29 the linked **RAG Railway Staging** project reported both services
sleeping under the original Phase 7 policy. PostgreSQL was still attached to
its persistent 50 GB Railway volume. That historical sanitized artifact is
retained at
`certification/phase9/evidence/local-idle-2026-08-29.json`.

This observation proves the former Phase 7 idle behavior for revision
`900905cf59fc7823b774473db4df5e7113632efe`. It no longer satisfies the current
always-available PostgreSQL contract; the release candidate must repeat the
observation after this reliability change is deployed.

## Certification run

1. Deploy one exact candidate revision to the isolated staging Railway project
   and its staging Supabase target.
2. Configure and verify the encrypted S3 destination. A transfer scenario must
   stop before maintenance or mutation when this check fails.
3. Run each contract scenario and export redacted evidence from Railway,
   Settings, Maintenance, and the test runner. Keep backup and migration
   manifests by hash; never place a database credential, S3 credential,
   recovery key, raw dump, session, or unredacted log in the repository.
4. Record all 34 results in
   `certification/phase9/staging-report.v1.json`. A pending, blocked, or failed
   row keeps the release gate closed.
5. Run the strict gate:

   ```powershell
   pnpm phase9:certify -- --report certification/phase9/staging-report.v1.json
   ```

6. Have a second operator inspect the evidence and add the independent review.
7. Only after the strict gate passes, change the Railway template certification
   status to `certified` and `advertisePortablePlacement` to `true` in the same
   reviewed release change.

## Destructive scenarios

Populated-target replacement, source cleanup, Railway service/volume
decommissioning, and last-recovery-artifact refusal require explicit,
separately retained approval. They must run only against disposable or
specifically authorized staging data. The certification harness does not grant
that approval and does not invoke these actions itself.

Source cleanup remains separate from route activation. Source decommissioning
requires successful target verification and a recoverable S3 transfer artifact.
Step 4 verifies that artifact, checkpoints source clearing, then deletes the
source and target-safety backup sets owned by the operation. A cleanup failure
records `cleanup_pending`, resumes any incomplete S3 deletion, and does not
reverse a successful target activation. Normal active-target backups remain a
separate recovery responsibility.

## Current release status

The Phase 9 implementation is present and its contract is enforced. Live
certification is **not complete**: only the safe idle observation has been
captured during implementation, the full direction/failure matrix has not been
run on the Phase 9 candidate, and destructive scenarios have not been approved.
Portable placement therefore remains unadvertised and the strict release gate
correctly fails closed.
