# Milestone 11 Rebuild Operations

This runbook is the operator contract for changing chunk rules, model revisions, or embedding dimensions without exposing partial data. All calls use the authenticated public administration API. Keep the returned proposal, build, activation, verification, and cleanup identifiers in the change record.

## Safety model

1. Search reads only the build marked `active` for each silo. Detached staging tables are never searched.
2. A proposal is only an estimate. Work begins only after a second, explicit confirmation request.
3. The build freezes its profile and model manifest; change the desired input by creating a new proposal, never by editing a build.
4. Same-model profile changes may activate one verified silo at a time. Model revision and dimension changes must include every active silo.
5. Activation retains the previous table or parent. Cleanup is a later destructive decision and permanently removes that rollback data.
6. Do not authorize cleanup until post-activation search, scope, locator, and application checks pass.
7. Every tokenizer and embedding call is bound to the build's immutable model-manifest digest and dimension. A runtime that cannot serve that exact identity must fail closed; never bypass an `EMBEDDER_MODEL_UNAVAILABLE` or `EMBEDDER_MODEL_DIMENSION_MISMATCH` result.
8. Search and activation coordinate through shared/exclusive cutover locks. Existing searches finish against one complete active model; activation then commits atomically, and later searches resolve the new complete model.
9. Resolve each silo's previous activation before activating another build for that silo. Either roll it back or explicitly authorize and finish cleanup; NodeRag rejects overlapping unresolved rollback chains.

## 1. Inspect current state

Call `GET /v1/admin/builds`. The response includes builds with per-silo progress, pending/recent proposals, activation history, and cleanup state. Record the current active build and model for every target silo.

Before continuing, confirm:

- no unrelated rebuild or cleanup is active;
- the desired model manifest already exists and has the expected digest/dimension;
- the installed embedder artifacts can serve that exact manifest and dimension;
- every intended silo is listed;
- storage has room for the proposal's temporary bytes plus reserve;
- ordinary search returns a known control query.

## 2. Create and review a proposal

Send `POST /v1/admin/builds` with an idempotency key. A minimal same-model request is:

```json
{
  "reason": "Change chunk profile after approved evaluation",
  "siloIds": [1, 2],
  "targetChars": 2000,
  "overlapChars": 300,
  "embeddingCharactersPerSecond": 2500
}
```

For a model revision or dimension change, also provide `modelManifestId`. Review `sourceCharacters`, `expectedChunks`, `estimatedEmbeddingSeconds`, `estimatedVisionReuse`, `temporaryBytes`, `requiredFreeBytes`, `availableBytes`, `fits`, and `expiresAt`. Stop if `fits` is false, the silo set is wrong, or the estimate is no longer acceptable.

## 3. Confirm and monitor

Send `POST /v1/admin/build-proposals/{proposalId}/confirm` with `{ "confirm": true }` and a new idempotency key. Record the returned `buildId` and `activationKind`.

The confirmation creates detached tables and low-priority document jobs. Monitor `GET /v1/admin/builds` and `GET /v1/jobs`. Per-silo `completedDocuments`, `totalDocuments`, `checkpointDocuments`, state, and last error are the durable progress indicators.

- Pause with `PATCH /v1/admin/builds/{buildId}` and `{ "action": "pause" }`.
- Resume with the same route and `{ "action": "resume" }`.
- Cancel with `{ "action": "cancel" }`. Completed checkpoints remain.
- After a process/database restart, resume the same build; completed document checkpoints prevent repeat work.

Only for an abandoned cancelled/failed build, discard checkpoints with `DELETE /v1/admin/builds/{buildId}/checkpoints` and the exact phrase `DISCARD BUILD {buildId} CHECKPOINTS`. This action is destructive and audited.

## 4. Verify each staged silo

After document work completes, send `POST /v1/admin/builds/{buildId}/verify` with `{ "siloId": 1 }` once for every staged silo. Verification builds indexes under the HNSW resource gate and records:

- staged row count and document coverage;
- locator boundary consistency;
- expected embedding dimension;
- null, NaN, and infinite vector count;
- presence of HNSW, GIN, and document-order indexes;
- sampled exact-versus-HNSW recall, which must be at least 0.95.

Do not activate a failed silo. Its table remains detached. Correct the cause and create/retry an appropriate build; never mark verification passed manually.

## 5. Activate atomically

Keep representative search traffic running, then call `POST /v1/admin/builds/{buildId}/activate` with the exact verified silo list.

```json
{ "siloIds": [1, 2] }
```

For a model revision or dimension change, the request must list every active silo. The transaction either changes all requested partitions/model metadata or none. Record the returned `activationId`, then verify known keyword, vector, and hybrid queries plus cross-silo scope behavior.

## 6. Roll back if acceptance fails

Before cleanup, call `POST /v1/admin/build-activations/{activationId}/rollback` with `{ "confirm": true }`. The prior partition(s), typed parent, and active model metadata are restored transactionally. Re-run the control searches and record the rollback result.

After accepting the rollback, use the cleanup authorization flow below with the rolled-back activation ID to remove the rejected new tables. NodeRag records the cleanup disposition and selects the failed staging tables or failed typed parent; it never targets the restored active tables.

## 7. Authorize and run cleanup

Only after the new build passes the full operational observation window—or after a rollback has been accepted—call `POST /v1/admin/build-activations/{activationId}/cleanup-authorizations` with:

```json
{ "confirmation": "CLEANUP BUILD 42" }
```

Use the activated build ID in the phrase. This ends rollback availability. Run the returned cleanup with `POST /v1/admin/build-cleanups/{cleanupId}/run` and `{ "confirm": true }`. A failed/interrupted cleanup may be submitted again: database DDL and checkpoint state are transactional. Confirm `completed` in `GET /v1/admin/builds` and retain the audit records for both authorization and completion.

## Failure rules

- Capacity failure: add approved storage or reduce scope; do not bypass the reserve.
- Interrupted job: resume the same build and verify checkpoint progress.
- Verification failure: leave staging detached; do not activate.
- Partial model selection: rejected by design; include all active silos.
- Mixed active models: search rejects the request instead of comparing incompatible scores.
- Activation error: the transaction rolls back; verify the previous build remains active.
- Cleanup uncertainty: inspect cleanup and activation state, then retry the same cleanup ID; never drop tables manually.

## Testbed and DSM boundary

The Docker/PostgreSQL rehearsal proves application, model-identity routing, transaction, checkpoint, and contract behavior with the deterministic model-aware runtime. It does not certify the release ONNX artifacts. Final DSM certification repeats the exact release-candidate rebuild with the installed model artifacts while Package Center services, ordinary file sharing, monitoring, and representative NAS I/O are active. It must also cover interruption by service restart and NAS reboot before `v1.0.0` can be authorized.
