# Backup And Restore Data Classification

> Status: Target architecture and implementation plan. This document records
> the intended backup boundary. It does not claim that every rule below is
> implemented by the current version.

## Purpose

A portable backup must preserve the knowledge system and the choices that give
its data meaning. It must not carry the source installation's service locations
or credentials into a different installation.

This distinction is independent from where a row is physically stored. A
setting may live in the Railway control-plane database and still belong in a
portable backup. Another row in the same database may describe the current
Supabase project and must not be restored.

The core rule is:

- **Installation structure** describes where and how this deployment runs. It
  is configured on the target and is not restored from a portable backup.
- **Portable state** describes user content, relationships, behavior, and the
  provenance needed to understand or reproduce backed-up data. It is backed up
  and restored.
- **Credential material** grants access. A normal portable backup preserves a
  requirement record but not the usable secret. The credential is recreated or
  re-entered.
- **Retained history** is evidence rather than live state. It is included only
  according to an explicit retention policy and is restored after core data.
- **Ephemeral state** represents active execution. It is neither backed up nor
  resumed.

"Not backed up" in this document means "not placed in the portable archive as
an importable value." Installation structure should still be reproducible from
the Railway template, release migrations, deployment variables, and an
operator-maintained configuration record. A backup manifest may state a
non-secret compatibility requirement, but restore must never apply a source
endpoint, project reference, bucket, or credential to the target.

## Backup Artifacts

The architecture should produce distinct artifacts instead of mixing every
kind of recovery into one archive.

| Artifact | Contains | Restore behavior |
| --- | --- | --- |
| Portable recovery archive | Content, relationships, behavioral settings, objects, chunks, embeddings, and allowed history | Imported into a compatible target installation |
| Portable library package | Selected libraries, library projects/tools, originals, canonical Markdown, and memberships; no chunks, vectors, silos, access, or bindings | Imported, then chunked and embedded under target settings |
| Release structure | Schema migrations, RPC definitions, indexes, storage declarations, and application defaults | Installed from the selected application release, not from tenant data |
| Target installation profile | Database/object locations, routing, service URLs, regions, schedules, encryption modes, and capacity/security limits | Configured and validated on the target before import |
| Credential requirement inventory | Provider/key label, purpose, owner, and whether a replacement is required | Shows blocked capabilities without containing the secret |
| Optional sealed credential escrow | Explicitly selected secrets re-encrypted to a customer-held recovery key | Separate, opt-in restore step with audit and key possession |
| Compliance history export | Installation-local audit records that must be retained after a system is retired | Read-only evidence; never imported as live target state |

The optional sealed credential escrow must never be silently added to a normal
portable archive. The archive and recovery key must be held separately.

## Mandatory Encryption Policy

Encryption is not an optional backup feature in the target architecture. Every
manual or scheduled backup must be encrypted, and original document objects
must be encrypted before they are written to their selected storage provider.

A portable library package is an export artifact, not a system backup, and may
be encrypted or explicitly exported without package encryption. Primary object
storage remains encrypted in either case. Its separate scope and security
contract is defined in
[Portable Library Export And Import](../requirements/library-portability.md).

Three credentials remain distinct:

1. **Administrator authentication** proves who is allowed to create a backup,
   enable a schedule, or change an encryption configuration.
2. **Backup recovery password** encrypts archives and is required to inspect,
   verify, or restore them.
3. **Object encryption key/password** encrypts original and derived document
   objects in primary storage.

Reusing one value for these responsibilities is prohibited. A compromise or
rotation in one area must not unlock the other two.

### Manual backups

- Creating a backup requires a backup recovery password and confirmation.
- The archive cannot be queued when the password is absent or fails the
  configured strength policy.
- The password is sent only to the maintenance process, used to derive an
  archive key with a per-archive salt, and discarded when the operation ends.
- The password, derived key, and usable key material never appear in the
  database, job row, logs, archive, sidecar manifest, or backup destination.
- The manifest stores only encryption algorithm/version, salt/nonce material,
  and a non-reversible key fingerprint needed to identify the right password.
- Verify, download inspection, and restore require the password again.

The operator must keep the recovery password outside the installation. Losing
both the installation and the only copy of the password makes the archive
intentionally unrecoverable.

### Scheduled backups

A scheduler cannot prompt when a cron fires, so enabling or changing a schedule
is a secret-provisioning operation:

1. The administrator re-authenticates and enters/confirms the backup recovery
   password while creating the schedule.
2. The password is stored only as an encrypted secret in the Railway control
   plane Vault/secret store. The `backup_schedules` row stores a secret
   reference, key version, fingerprint, and encryption-required state, never
   the password or ciphertext that the application database can decrypt alone.
3. At run time the maintenance scheduler retrieves the secret through a
   narrowly scoped identity, passes it directly to the archive encryptor, and
   clears it after the job.
4. An enabled schedule is unhealthy and must not create an unencrypted fallback
   when the secret cannot be retrieved. The run fails closed and raises an
   alert.
5. The operator retains an external copy of every recovery password/version
   needed by archives still inside retention.

Changing the schedule password creates a new key version for future archives.
Existing archives continue to require their original password. Archive
metadata identifies the required key fingerprint without revealing the value.
Disabling or deleting a schedule removes its runtime secret only after policy
confirms that doing so will not strand archives whose password has no external
copy.

### Original and derived object encryption

Original uploads must be encrypted before storage. Canonical Markdown, page
renders, extracted images, table exports, parser diagnostics, and generated
files can contain the same sensitive information and should use the same
mandatory object-encryption boundary.

The storage configuration records only non-secret properties:

- encryption mode and algorithm/version
- key reference, key version, and non-reversible fingerprint
- provider-side encryption mode or KMS identifier when available
- rotation and last-verification state

The object encryption password/root key is stored in the Railway control-plane
secret store, not beside the object rows and not in Supabase or S3 object
metadata. Each object uses a random data-encryption key and authenticated
encryption. That data key is wrapped by the configured object key, allowing key
rotation without sharing one raw encryption key across every object.

Provider-side encryption at rest should also be enabled, but it is not a
replacement for application envelope encryption. Application encryption gives
the same guarantee across the Railway document service, Supabase Storage,
Backblaze B2, and other S3-compatible providers, including providers that do not
expose customer-password encryption.

Uploads encrypt as a stream before leaving the application boundary. Downloads
decrypt only inside an authorized application/worker stream. Plaintext must not
be written to a Railway volume, temporary object, log, or backup staging file.

During portable backup, the maintenance service streams each source object
through source-object decryption and directly into archive encryption. During
restore, it streams archive decryption directly into the target's object
encryption. This makes the archive depend only on its backup recovery password
and lets the target use a new object key without ever materializing plaintext
on disk.

Object encryption protects stored files, not database chunks, embeddings, or
metadata. Every selected Postgres provider still requires encryption at rest,
encrypted transport, restricted roles, and independently managed database
credentials.

## Decision Test For Every New Value

Every new setting, table, column, JSON property, object class, and secret must
answer these questions before its migration is accepted:

1. Does it describe a service location, route, capacity, or the current
   installation? Classify it as installation structure.
2. Does it describe user content, ownership, relationships, or how backed-up
   content was produced or interpreted? Classify it as portable state.
3. Can possession of the value grant access or impersonate a user or service?
   Classify it as credential material even when it sits inside JSON.
4. Is it historical evidence with no role in current behavior? Give it an
   explicit retention and restore policy.
5. Is it a lock, lease, in-flight job, session, health sample, or temporary
   token? Classify it as ephemeral.

An unclassified value must fail backup verification. The default must not be
"include everything in this table."

## Installation Structure: Do Not Restore

### Release-defined database structure

| Value | Portable backup | How the target receives it |
| --- | --- | --- |
| Tables, columns, constraints, and foreign keys | No | Application migrations |
| SQL functions and PostgREST RPC signatures | No | Application migrations |
| RLS policies, database roles, and grants | No | Application migrations and target role setup |
| Required Postgres and pgvector versions | Requirement only | Target capability validation |
| Vector column/index definitions for supported dimensions | No | Application migrations |
| Storage bucket declarations and lifecycle defaults | No | Target storage provisioning |
| Application defaults | No | Selected release |
| Application version, migration head, and backup format | Manifest metadata only | Used for compatibility checks; never imported as live state |

### Installation-local placement and routing

| Value | Portable backup | Target action |
| --- | --- | --- |
| Operational database provider and location | No | Select Railway, Supabase, or another compatible Postgres |
| Operational database host, port, URL, project reference, region, SSL, and pool settings | No | Configure and test on target |
| RAG database provider, location, and route | No | Configure target placement |
| PostgREST endpoint, exposed schemas, JWT settings, roles, and connection pool | No | Provision against target Postgres |
| Object provider, endpoint, region, bucket, prefix, Railway volume path, and object-encryption key reference | No | Select and test target object service and provision a target object key |
| Backup provider, endpoint, bucket, prefix, region, and retention destination | No | Configure before the first target backup |
| Railway service names, internal URLs, public domains, and wake endpoints | No | Railway template/deployment configuration |
| Tenant-to-database and tenant-to-object routing records | No | Recreated by mapping restored tenant IDs to target destinations |
| Migration source/target, cutover phase, and source-retention state | No | New target-local operation records |
| Provider capability probes and current health results | No | Re-run on target |

Object references need special handling because current rows carry physical
`bucket` and `storage_path` values. The portable form should preserve logical
object ID, role, file name, MIME type, byte size, checksum, and a provider-neutral
object key. Restore maps that key into the target's selected bucket and prefix.
The source provider, endpoint, signed URL, and physical volume path are not
restored.

### Installation-local operations

| Value | Portable backup | Reason |
| --- | --- | --- |
| Backup schedules, next-run time, retention job state, encryption secret reference, and last backup ID | No | The target must opt into its own destination, password, and schedule |
| Backup, restore, migration, and maintenance job records | No | They describe operations performed by another installation |
| Maintenance mode and current installation state | No | The target controls its own barrier and readiness |
| Active worker locks, leases, attempts, heartbeats, and claimed-by fields | No | Work must not resume with stale ownership |
| API idempotency cache | No | It is short-lived request execution state |
| Session cookies, setup tokens, password-reset tokens, and temporary access tickets | No | They are installation-specific credentials |
| Queue depth, service health, latency samples, and resource metrics | No | Re-observe on the target |

Completed run summaries may be portable history, but a queued or running job is
never resumed directly. Restore either marks it interrupted or creates a new,
idempotent job after the underlying document state is verified.

## Portable Knowledge And Content State

The following data is required for a quick, complete recovery of the working
system.

| Data family | Values to preserve |
| --- | --- |
| Tenant | Stable tenant ID, name, non-secret metadata, and ownership relationships |
| Silos | IDs, names, descriptions, metadata, project relationships, and document membership |
| Projects | IDs, names, descriptions, metadata, silo relationships, and document membership |
| Libraries | Libraries, library projects, tool names/descriptions, enabled state, document membership, silo access grants, and tool bindings |
| Documents | Stable IDs, title/name, type, status provenance, metadata, project/silo/library relationships, deletion state, and timestamps needed for ordering |
| Original files | Exact uploaded bytes in the encrypted archive, logical object identity, checksum, size, MIME type, file name, and document role |
| Canonical and derived document data | Canonical Markdown, pages, text, renders, extracted images/assets, table exports, parser output, and checksums |
| Chunks | Chunk text, order, type, source offsets, source page/asset links, token count, chunk hash, and chunking version |
| Embeddings | Vector bytes, chunk/document links, provider, model, dimensions, embedding version, chunk hash, and reindex provenance |
| Generated content | Generated files, extraction results, conversation artifacts, and their object bytes and source relationships |
| User-authored workflows | Extraction templates, Tasks, Task items, model instructions, allowed tools, context-management choices, and library tool configuration |
| Task Datasets | Task+silo+optional-project groups, committed definitions, stable-document-ID coverage, source provenance, search receipts, contributions, materialized JSONB records, conflict state, and committed run usage |
| Content history | Conversations, questions, citations, run summaries, and user-visible results according to retention policy |

Database-generated indexes are rebuilt from the restored rows. They are not
backup payloads. Embedding vectors are payloads and should be restored directly
when the target supports their dimension and operator class. This provides the
fast path back to working vector search.

If the target cannot support an archived embedding dimension or model, restore
must still import originals, canonical text, chunks, and embedding provenance.
It marks vector search unavailable for the affected data and queues a deliberate
re-embedding operation. It must not silently reinterpret vectors with a
different model.

## Portable Behavioral Settings

Settings that explain how content was produced or how it should be searched
travel with that content even if the settings table physically lives in the
Railway control plane.

### RAG ingestion and search

| Value | Back up | Reason |
| --- | --- | --- |
| `chunk_max_tokens` | Yes | Defines chunk boundaries |
| `chunk_overlap_tokens` | Yes | Defines duplicated context across boundaries |
| `search_min_score` | Yes | Defines retrieval behavior |
| `neighbor_chunk_count` | Yes | Defines returned context |
| `neighbor_chunk_max_chars` | Yes | Defines returned context size |
| Embedding provider | Yes | Interprets archived vectors and future queries |
| Embedding model | Yes | Interprets archived vectors and determines query compatibility |
| Embedding dimensions | Yes | Required to select the correct column and index |
| Embedding/chunking version | Yes | Proves which configuration produced each row |

### Models and user-authored behavior

| Value family | Back up | Restore behavior |
| --- | --- | --- |
| `model_config`: scope, project, active state, embedding/answer/OCR/vision/reranker provider and model, parsing depth | Yes | Restore selection; mark unavailable when its credential or endpoint is missing |
| `model_task_configs`: task, provider, model, instructions, enabled tools, allowed tools, limits, and metadata | Yes | Restore exactly, subject to target capability validation |
| `context_management_configs`: enabled state, strategy, frequency, trigger percentage, tool-call compression, concurrency choice, and layer definitions | Yes | Restore exactly |
| Extraction templates, Tasks, Task items, prompts, schemas, output formats, retrieval choices, and versions | Yes | Restore exactly |
| Library tool names, descriptions, access grants, bindings, and polling limits | Yes | Restore with stable IDs and relationships |

Provider/model selection is portable behavior. A provider base URL, Supabase
project reference, Ollama endpoint, or API key is installation structure or
credential material and follows the separate rules below.

### Content-affecting platform runtime values

The following existing `platform_runtime_settings` values affect parsing or
the representation of backed-up content and should be included:

| Settings | Back up |
| --- | --- |
| PDF document limits | `pdfMaxPages`, `pdfVisionMaxPages` |
| PDF rendering and layout | `pdfRenderDpi`, `pdfLayoutAnomalyGapChars`, `pdfLayoutAnomalyMinGapLines` |
| Vision behavior | `pdfVisionMode`, `pdfDirectVisionOllamaOutputTokens`, `ollamaVisionModelFallback` |
| PDF image extraction | `pdfExtractImages`, `pdfMaxExtractedImages`, `pdfMaxExtractedImagesPerPage`, `pdfMinExtractedImagePixels`, `pdfMinExtractedImageSidePx`, `pdfImageObjectRenderThreshold` |
| PDF image analysis | `pdfAnalyzeExtractedImages`, `pdfMaxImageAnalyses`, `pdfMaxImageAnalysesPerPage`, `pdfMinImageAnalysisPixels` |
| DOCX image analysis | `docxAnalyzeEmbeddedImages`, `docxMaxImageAnalyses`, `docxMinImageAnalysisPixels` |
| Excel representation | `excelMaxSheets`, `excelMaxRowsPerSheet`, `excelMaxColumnsPerSheet`, `excelMaxCellChars` |

The setting revision used by each processing job or generated file is portable
provenance. The restored settings record must preserve enough revision history
or an immutable snapshot to explain an archived output. A single latest overlay
is insufficient when older outputs were produced under different choices.

### Installation runtime tuning values

The following existing `platform_runtime_settings` values describe throughput,
resource limits, network timing, or Railway worker behavior. They stay with the
target installation and are not imported from a portable backup:

| Settings | Target source |
| --- | --- |
| Worker execution | `jobHeartbeatIntervalMs`, `workerPollIntervalMs`, `workerMaxJobsPerRun`, `workerIdleSleepEnabled`, `workerIdleAfterMs` |
| Embedding throughput | `supabaseEmbeddingBatchSize`, `supabaseEmbeddingRetryCount`, `supabaseEmbeddingRetryBaseDelayMs`, `supabaseEmbeddingDelayMs`, `ollamaEmbeddingBatchSize`, `ollamaEmbeddingRetryCount`, `embeddingBatchSize`, `ollamaEmbeddingNumThreads`, `workerEmbeddingWakeRetryCount`, `workerEmbeddingWakeRetryBaseDelayMs` |
| Write/upload throughput | `pdfPageWriteBatchSize`, `pdfRenderUploadRetryCount`, `pdfChunkInsertBatchSize`, `pdfVisionConcurrency` |
| Provider/network limits | `pdfDirectVisionTimeoutMs`, `pdfDirectVisionSinglePageTimeoutMs`, `pdfDirectVisionMaxRequestBytes`, `ollamaTimeoutMs`, `ollamaEmbeddingTimeoutMs`, `openAiVisionTimeoutMs`, `openAiEmbeddingTimeoutMs`, `supabaseEmbeddingTimeoutMs` |
| API admission limit | `apiRemoteUploadMaxBytes` |

The source values may appear in a non-importable diagnostic report so an
operator can compare capacity, but target defaults and target security policy
win. A restore must never lower a target resource or admission limit merely
because the source used a different value.

## Security And Credential Classification

### Identity and authorization policy

| Value | Back up | Restore behavior |
| --- | --- | --- |
| Administrator ID, tenant, email, display name, and active/disabled intent | Yes | Restore disabled until administrator setup/reset completes |
| Administrator password hash | No | Create a new password through target setup |
| API key ID, name, prefix/preview, scopes, revocation state, and access relationships | Yes | Preserve identity and policy, but mark credential replacement required |
| API key hash and encrypted key value | No in normal portable backup | Generate a replacement and reconnect clients |
| API test-user ID, name, display name, status, and grants | Yes | Restore disabled until password and associated API key are replaced |
| API test-user password hash | No | Reset on target |
| Library/project/silo access grants and tool permissions | Yes | Restore as portable authorization policy |
| Session, setup, reset, ticket, and lease tokens | No | Regenerate when needed |

Preserving an identity row does not mean preserving an active credential. The
target needs an explicit credential state such as `replacement_required` so a
restored row cannot appear usable while authentication is impossible.

### Service and integration secrets

| Secret/value | Normal portable backup | Recovery action |
| --- | --- | --- |
| Database URL/password and Supabase service-role key | Excluded | Configure target data plane |
| PostgREST JWT/signing roots and role credentials | Excluded | Generate/configure on target |
| Railway internal/admin session secret | Excluded | Generate on target |
| API-key encryption root | Excluded | Generate on target; old API keys are replaced |
| Object-storage and backup-storage access keys | Excluded | Configure target destinations |
| Object encryption password/root key | Excluded from the portable archive | Configure a target key; source key is used only while streaming the backup |
| OpenAI, Ollama Cloud, Mistral, and other model-provider API keys | Excluded by default | Re-enter or rotate; requirement inventory shows what is missing |
| Vault secret IDs/names and provider-specific secret references | Source IDs excluded | Recreate references after the replacement secret is stored |
| Webhook signing secrets | Excluded | Re-enter or rotate before enabling webhook |
| Webhook destination URL | Preserve only as a reviewed, disabled integration definition; redact when it may contain credentials | Administrator reviews and enables |
| Manual backup recovery password | Never stored | Operator supplies it during create, verify, and restore |
| Scheduled backup recovery password | Excluded from archives; encrypted in the installation secret store | Scheduler uses it at run time; operator retains an external recovery copy |

For the fastest recovery, selected provider and webhook secrets may be placed
in the optional sealed credential escrow. They must be re-encrypted directly to
a customer-held recovery key, separately authorized, separately audited, and
never readable by the ordinary archive verifier. Database, PostgREST, Railway,
and backup-destination roots should still be supplied by the target because
they identify the new installation.

### Security evidence and metrics

| Data | Classification | Backup/restore policy |
| --- | --- | --- |
| API scopes, revocations, access grants, and disabled state | Portable security policy | Include and restore before content is exposed |
| API usage logs, webhook delivery history, model usage, and usage events | Retained history | Include only within configured retention; import after core recovery |
| Question/citation and user-visible run history | Portable content history | Include according to product retention policy |
| Supabase/database connection-change events and secret fingerprints | Installation-local security audit | Do not import as target history; optionally preserve in compliance export |
| Backup/restore/migration/maintenance audit records | Installation-local audit | Do not import as live state; optionally preserve in compliance export |
| Live health, readiness, capacity, latency, and queue metrics | Ephemeral telemetry | Do not back up; re-observe on target |
| Raw logs that may contain request bodies or provider output | Retained diagnostic history | Opt-in retention, secret scan, and redaction required |

Security controls on the target must be at least as strict as the target's
baseline. Portable access grants can narrow access, but an archive must not
weaken target-wide controls such as allowed origins, rate limits, session
policy, network exposure, or upload limits.

## Nested And Unstructured Values

Column-level rules are not enough for `jsonb`, metadata, request snapshots, or
generated diagnostic content. Each known nested property needs a path-level
classification. A verifier must also scan unknown paths and fail closed when a
secret-shaped property carries a value.

At minimum, these paths require explicit handling:

- `processing_jobs.requested_config.webhook.secret`: exclude
- `processing_jobs.requested_config.webhook.url`: redact or restore disabled
- `extraction_task_runs.webhook_url`: redact
- `extraction_task_runs.webhook_secret_ciphertext`: redact and require a new
  signing secret on the target installation
- request/response metadata properties named like authorization, password,
  token, API key, secret, cookie, signed URL, connection string, or credential:
  exclude or redact
- model/provider metadata: preserve descriptive settings, exclude credentials
- document and object metadata: preserve content provenance, exclude signed
  URLs and temporary access tokens

A secret must not become backup-eligible merely because it was placed inside a
JSON object instead of a column named `secret`.

## Restore Order For Fast Recovery

The restore path should prioritize a verified working knowledge system while
lower-priority history continues afterward.

1. **Provision target structure.** Install the selected release, migrations,
   extensions, indexes, PostgREST contract, encrypted object destination,
   target object key, and routing.
2. **Validate capabilities.** Confirm vector dimensions/index operators,
   storage capacity, database roles, and backup-format compatibility.
3. **Import identity and policy.** Restore tenant and authorization metadata;
   keep credential-dependent identities and integrations disabled.
4. **Import organization.** Restore silos, projects, libraries, library
   projects, memberships, grants, and tool bindings with stable IDs.
5. **Import behavioral settings.** Restore RAG, model, task, context, parser,
   and extraction configuration plus the revisions/snapshots that explain data.
6. **Restore objects and documents.** Stream archive decryption into target
   object encryption while restoring original bytes, canonical Markdown,
   pages, assets, document rows, and provider-neutral object mappings.
7. **Restore RAG state.** Import chunks and compatible embeddings, rebuild
   indexes, and verify representative searches.
8. **Restore outputs.** Import generated files, extraction results,
   conversations, and user-visible history.
9. **Restore retained audit history.** Import only the portable history inside
   its retention window; keep installation-local evidence separate.
10. **Resolve credentials.** Show a checklist for administrator passwords, API
    keys, provider keys, storage roots, and disabled webhooks.
11. **Verify and open.** Compare IDs, row counts, relationships, object
    checksums, chunk hashes, vector counts/dimensions, search results, and
    security state before enabling writes and integrations.

The system can expose a restricted read/search mode after steps 1-7 pass, while
large history tables continue restoring. It must not accept ingestion or enable
webhooks until the target credentials, settings, and writable object mappings
are verified.

## Verification Manifest

Every archive should prove both inclusion and exclusion.

The manifest records:

- backup format and application compatibility
- every portable table/data family and row count
- every object, logical role, byte size, and checksum
- archive encryption algorithm/version and recovery-key fingerprint
- object encryption algorithm/version and target key-verification result
- chunk count and chunking settings/version by scope
- embedding count, provider, model, dimensions, and version by scope
- behavioral setting revisions/snapshots included
- retained-history cutoff per history family
- every redacted, regenerated, excluded, or sealed field path
- a credential requirement inventory without credential values
- target capability requirements

The verifier fails when:

- an expected silo, project, library, document, relationship, object, chunk, or
  embedding is absent
- an object checksum or database relationship does not match
- a portable setting needed to interpret backed-up data is missing
- an installation endpoint, project reference, bucket credential, or usable
  secret appears in an importable payload
- an archive is unencrypted or an object declared encrypted cannot be
  authenticated and decrypted with the supplied key
- an unknown secret-shaped column or JSON path carries a value
- an excluded active job, lease, session, or maintenance state appears

## Current Implementation Compared With This Target

The current backup contract already provides a strong base:

- It exports tenants, silos, projects, libraries and their relationships,
  documents, chunks, embeddings, model/task settings, conversations, results,
  and generated records.
- It exports original documents, generated files, page renders, extracted
  assets, table exports, and parser diagnostics.
- It excludes Vault secrets, setup tokens, idempotency records, access leases,
  backup history, and restore history.
- It regenerates administrator/API-user password material, API key secret
  material, Vault references, and storage access-key IDs.
- It verifies table counts, object checksums, redacted fields, and common
  plaintext-secret shapes.

The target classification requires these implementation changes later:

1. Split `platform_runtime_settings` by field classification instead of
   exporting the whole JSON overlay as one portable value.
2. Stop importing installation-local rows such as `platform_installations`,
   `platform_migration_checksums`, `provider_access_configs`,
   `storage_access_configs`, `supabase_connection_events`, and
   `platform_maintenance_operations`. Keep compatibility facts in the manifest
   and installation audit facts in a separate evidence export.
3. Add provider-neutral object identities so physical bucket/path values can be
   remapped without changing document identity.
4. Add path-level JSON redaction. In particular,
   `processing_jobs.requested_config.webhook.secret` is currently nested in an
   exported table and must be explicitly excluded before the target contract is
   considered satisfied.
5. Treat queued/running processing records as interrupted or recreate them as
   new jobs; do not restore stale locks or resume source execution state.
6. Store immutable behavioral setting snapshots or revision history sufficient
   to explain older chunks, embeddings, and generated outputs.
7. Add an explicit credential requirement state so restored API keys, users,
   provider configurations, and webhooks cannot appear active before their
   credentials are replaced.
8. Make the archive manifest enumerate all portable, structural, secret,
   retained-history, and ephemeral values so schema changes cannot bypass
   classification.
9. Require an encryption password for manual backups. The current request
   contract permits an absent key and therefore permits an unencrypted archive.
10. Add encrypted secret provisioning for schedules. The current scheduler
    creates jobs with `encryption_enabled = false`; it must instead fail closed
    when the schedule's encrypted recovery credential is unavailable.
11. Add provider-neutral application envelope encryption for originals and
    other document-bearing objects. The current storage path relies on provider
    controls and does not yet enforce one portable customer-password boundary.

These are planning findings only. They do not change the current backup format
or runtime behavior until implemented and versioned through the backup contract.
