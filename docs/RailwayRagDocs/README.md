# RAG Railway Documentation

This directory is the documentation source of truth for the Railway-hosted
RAG Railway platform. The production REST base URL is:

```text
https://web-production-3bf65.up.railway.app/api/v1
```

## Start Here

| Audience                | Read first                                                                                                                       | Purpose                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API client developer    | [REST API documentation](api/README.md)                                                                                          | Authentication, request conventions, endpoint commands, responses, and workflows.                                                                          |
| Bubble plugin developer | [Bubble documentation](bubble/README.md)                                                                                         | Private plugin installation, Bubble API Connector setup, and delivery guidance.                                                                            |
| Platform operator       | [Railway, Supabase, and model-provider setup](setup/railway-supabase-model-provider-setup.md)                                    | Build the three Railway services, connect Supabase, and configure Ollama/OpenAI.                                                                           |
| Platform operator       | [Optional RunPod embedding accelerator](setup/runpod-embedding-accelerator.md)                                                   | Provision a scale-to-zero GPU endpoint and understand health, callbacks, batching, security, and fallback.                                                 |
| Platform operator       | [Mistral whole-document OCR](setup/mistral-ocr.md)                                                                               | Configure whole-PDF OCR, page Markdown, confidence, usage caps, concurrency, images, retries, and conditional vision fallback.                             |
| Platform operator       | [Railway connection and service reconciliation](setup/railway-connection-and-service-reconciliation.md)                          | Connect one Railway project, review missing services, approve repairs, and hand control to maintenance.                                                    |
| Distribution maintainer | [Railway template, Supabase bootstrap, backup, and restore roadmap](setup/railway-template-supabase-bootstrap-backup-roadmap.md) | Package a repeatable installation, initialize a blank Supabase project, and provide portable recovery.                                                     |
| Distribution maintainer | [Railway deployment Phase 0 platform contract](setup/railway-deployment-phase-0-platform-contract.md)                            | Review the enforceable environment, Supabase-resource, backup-format, and secret-redaction contracts.                                                      |
| Distribution maintainer | [Railway deployment Phase 1 readiness](setup/railway-deployment-phase-1-readiness.md)                                            | Review installation metadata, schema compatibility, health reporting, worker guards, and help coverage.                                                    |
| Distribution maintainer | [Railway deployment Phase 2 maintenance and bootstrap](setup/railway-deployment-phase-2-maintenance-bootstrap.md)                | Initialize and verify a blank Supabase project from Railway, then create the first administrator.                                                          |
| Distribution maintainer | [Railway deployment Phase 3 runtime configuration](setup/railway-deployment-phase-3-runtime-configuration.md)                    | Historical environment-to-database migration notes; current runtime ownership is documented below.                                                         |
| Installation operator   | [Deployment notes](deployment.md)                                                                                                | Deploy the eight-service local-vault architecture, bootstrap its generated variables, import legacy settings, and make manual encrypted settings backups.  |
| Distribution maintainer | [Railway deployment Phase 3 second settings migration](setup/railway-deployment-phase-3-remaining-environment-settings.md)       | Read the per-setting decisions from the second migration, including the three that came back.                                                              |
| Distribution maintainer | [Railway deployment Phase 4 template packaging](setup/railway-deployment-phase-4-template-packaging.md)                          | Package the installation as a Railway template and prove it deploys and upgrades.                                                                          |
| Distribution maintainer | [Railway deployment Phase 5 portable backup](setup/railway-deployment-phase-5-portable-backup.md)                                | Take a verified portable export to your own S3 destination.                                                                                                |
| Distribution maintainer | [Railway deployment Phase 6 blank-project restore](setup/railway-deployment-phase-6-blank-project-restore.md)                    | Restore an archive into a blank installation, keeping every id and storage path.                                                                           |
| Distribution maintainer | [Railway deployment Phase 7 disaster recovery](setup/railway-deployment-phase-7-disaster-recovery.md)                            | Take a logical dump, schedule backups, and make restore a release gate.                                                                                    |
| Distribution maintainer | [Railway PostgreSQL and PostgREST portability implementation plan](setup/railway-postgres-postgrest-portability-proposal.md)     | Add the two sleeping local data-plane services, attach existing databases non-destructively, and run guarded S3-backed transfers with schema play-forward. |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 1 runtime separation](setup/railway-postgres-postgrest-portability-phase-1.md)           | Review the atomic runtime route, separate relational/object clients, endpoint identity gate, maintenance refusal, and job route snapshots.                 |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 2 schema engine](setup/railway-postgres-postgrest-portability-phase-2.md)                | Review provider tracks, Settings-owned execution envelopes/state, Maintenance capability probes, ordered play-forward, and Railway PostgREST grants.       |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 3 Railway PostgreSQL](setup/railway-postgres-postgrest-portability-phase-3.md)           | Review the private pgvector service, persistent volume, generated credentials, first-start schema provisioning, and real backup/restore lifecycle gate.    |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 4 Railway PostgREST](setup/railway-postgres-postgrest-portability-phase-4.md)            | Review the private pinned PostgREST service, supervised readiness/reload, scoped JWT role, Settings registration, and real relational/RPC gate.            |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 5 database transfer](setup/railway-postgres-postgrest-portability-phase-5.md)            | Review S3-gated encrypted transfer, immutable approval, maintenance barrier, verified restore, atomic activation, attachment, retry, and retained cleanup. |
| Distribution maintainer | [PostgreSQL/PostgREST portability Phase 8 template release](setup/railway-postgres-postgrest-portability-phase-8.md)             | Review the eight-service template, fresh local activation, six-service upgrade contract, image pins, release CI, and upgrade notes.                        |
| Release operator        | [PostgreSQL/PostgREST portability Phase 9 live certification](setup/railway-postgres-postgrest-portability-phase-9.md)          | Run the 34-scenario staging matrix, retain redacted checksum-bound evidence, and open the portable-placement release gate only after independent review.   |
| Product and UI reviewer | [Database configuration UI](setup/database-configuration-ui.md)                                                                  | Review the Database section, placement rules, four-stage transfer flow, maintenance status, cancellation, and retained-source cleanup.                     |
| Release operator        | [Update and deploy batch command](setup/update-and-deploy-batch.md)                                                              | Push, migrate Supabase, redeploy Railway, and run release tests.                                                                                           |
| Release operator        | [Production and staging tracks](setup/production-and-staging-tracks.md)                                                          | Run roadmap work on a second Railway and Supabase project without disturbing a live installation.                                                          |
| Database operator       | [Database construction](database/database-construction.md)                                                                       | Apply and verify the Supabase schema, storage buckets, functions, and seed data.                                                                           |
| Maintainer              | [System overview](system/system-overview.md)                                                                                     | Understand service boundaries, ingestion, retrieval, Ask, Extraction, and Tasks.                                                                           |
| Library operator        | [Reference libraries](library/README.md)                                                                                         | Build shared reference collections and expose them to Ask and Extraction as RAG tools.                                                                     |
| Template operator       | [Templates and Document Engine](Templates/README.md)                                                                             | Build Template Groups, prepare searchable templates, approve blueprints, and generate DOCX output.                                                         |
| Federated data operator | [Federated Data](FederatedData/README.md)                                                                                        | Give models per-silo reference datasets so a grant, project, or vendor keeps one identifier across runs. Design settled; not implemented.                  |
| Task/workflow designer  | [Task Datasets](TaskDatasets/README.md)                                                                                          | Review the proposal for Task+silo+project-private JSONB datasets that atomically reuse compiled facts and retrieve only uncovered document IDs.            |
| Product or QA reviewer  | [Requirements index](requirements/README.md)                                                                                     | Review requirements, open decisions, implementation state, and the original POC report.                                                                    |

## Documentation Sets

### API

- [Canonical public API usage guide](api-usage.md) is the route-verified source
  for every public `/api/v1` method/path combination.
- [Pure REST API command reference](api/rest-api-command-reference.md) removes
  Bubble installation material and presents the external REST contract on its
  own.
- [API contracts](api-contracts.md) records the original proof-of-concept
  contract decisions and object shapes.

Run `pnpm docs:check` whenever a public route is added or changed. The check
compares the implemented route handlers with the endpoint matrix and detailed
sections in `api-usage.md`.

### System And Operations

- [System overview](system/system-overview.md)
- [Architecture notes](architecture.md)
- [Deployment notes](deployment.md)
- [Secrets policy](secrets-policy.md)
- [Database construction](database/database-construction.md)
- [Reference libraries](library/README.md)
- [Templates and Document Engine](Templates/README.md)
- [Federated Data](FederatedData/README.md)
- [Task Datasets](TaskDatasets/README.md)
- [Railway, Supabase, and model-provider setup](setup/railway-supabase-model-provider-setup.md)
- [Optional RunPod chunking and embedding accelerator](setup/runpod-embedding-accelerator.md)
- [Mistral whole-document OCR](setup/mistral-ocr.md)
- [Railway connection and service reconciliation](setup/railway-connection-and-service-reconciliation.md)
- [Railway template, Supabase bootstrap, backup, and restore roadmap](setup/railway-template-supabase-bootstrap-backup-roadmap.md)
- [Railway deployment Phase 0 platform contract](setup/railway-deployment-phase-0-platform-contract.md)
- [Railway deployment Phase 1 installation readiness](setup/railway-deployment-phase-1-readiness.md)
- [Railway deployment Phase 2 maintenance and blank-project bootstrap](setup/railway-deployment-phase-2-maintenance-bootstrap.md)
- [Railway deployment Phase 3 runtime configuration](setup/railway-deployment-phase-3-runtime-configuration.md)
- [Railway deployment Phase 3 the second settings migration](setup/railway-deployment-phase-3-remaining-environment-settings.md)
- [Railway deployment Phase 4 template packaging](setup/railway-deployment-phase-4-template-packaging.md)
- [Railway deployment Phase 5 portable backup and verification](setup/railway-deployment-phase-5-portable-backup.md)
- [Railway deployment Phase 6 blank-project restore](setup/railway-deployment-phase-6-blank-project-restore.md)
- [Railway deployment Phase 7 disaster recovery and release automation](setup/railway-deployment-phase-7-disaster-recovery.md)
- [Railway PostgreSQL and PostgREST portability implementation plan](setup/railway-postgres-postgrest-portability-proposal.md)
- [PostgreSQL/PostgREST portability Phase 1 runtime separation](setup/railway-postgres-postgrest-portability-phase-1.md)
- [PostgreSQL/PostgREST portability Phase 2 provider-neutral schema engine](setup/railway-postgres-postgrest-portability-phase-2.md)
- [PostgreSQL/PostgREST portability Phase 3 Railway PostgreSQL](setup/railway-postgres-postgrest-portability-phase-3.md)
- [PostgreSQL/PostgREST portability Phase 4 Railway PostgREST](setup/railway-postgres-postgrest-portability-phase-4.md)
- [PostgreSQL/PostgREST portability Phase 5 database transfer](setup/railway-postgres-postgrest-portability-phase-5.md)
- [PostgreSQL/PostgREST portability Phase 8 template release](setup/railway-postgres-postgrest-portability-phase-8.md)
- [PostgreSQL/PostgREST portability Phase 9 live certification](setup/railway-postgres-postgrest-portability-phase-9.md)
- [Database configuration UI](setup/database-configuration-ui.md)
- [Update and deploy batch command](setup/update-and-deploy-batch.md)
- [Production and staging tracks](setup/production-and-staging-tracks.md)

### Requirements And Delivery

- [Requirements](requirements.md)
- [Open questions](open-questions.md)
- [Current Bubble API state](bubble-api-current-state.md)
- [Bubble API installation](bubble-api-installation.md)
- [Bubble integration delivery guide](bubble-integration-delivery-guide.md)

## Generated PDFs

The documentation builder creates three focused PDFs in `output/pdf/`:

- `RAG_Railway_Connector_Bubble_Plugin_Guide.pdf`
- `RAG_Railway_REST_API_Command_Reference.pdf`
- `RAG_Railway_Supabase_Provider_Setup_Guide.pdf`

Build them with:

```powershell
pnpm docs:pdf
```

The checked-in Markdown files remain authoritative. PDFs are distribution
artifacts for Bubble users and platform operators.
