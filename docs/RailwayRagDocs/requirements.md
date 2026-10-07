# POC Requirements

## Goal

Validate the RAG database, file-ingestion data model, processing state machine, provider configuration, and API contracts before Bubble workflows are connected.

## Initial Scope

- Supabase Postgres with pgvector for tenant-scoped document retrieval.
- Supabase Storage private buckets for original files, page renders, extracted assets, table exports, and parser debug payloads.
- Tenant/project silos for isolating datasets during upload and retrieval.
- Railway-hosted web/API service for upload records, status inspection, provider access settings, model task assignments, ask calls, generated output files, and extraction calls.
- Railway-hosted worker for queued ingestion/reprocessing jobs.
- GitHub migrations and safe seed data as the reproducible source of truth.

## Deferred Until Later Phases

- Bubble API Connector integration.
- Managed OCR calls.
- Broader provider ingestion beyond the current Ollama image POC path.
- Production auth/tenant membership enforcement.
- Additional embedding providers, provider-backed answer generation, and full model tool-calling loops.
- Full document binary upload UI. Implemented for standard Supabase Storage uploads in the POC portal; resumable large-file uploads remain future work.
