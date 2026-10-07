# Improving Embeddings — Implementation Plan

> Status: **Analysis and design only. No code has been changed.** Railway and Supabase
> accounts are assumed secure (see `docs/security-concerns.md`). Pricing/benchmarks reflect
> public data as of mid-2026 and must be re-validated on your own hardware and corpus.

## 1. Goals

1. Add two new embedding models to the system:
   - **`qwen3-embedding-0.6b`** (1024-dim) — the CPU-runnable tier, served on Railway.
   - **`qwen3-embedding-4b`** (2560-dim) — the **premium GPU tier**, the upsell that justifies
     adding GPU power. If it delivers a significant cosine-retrieval quality gain, it is easy
     to sell; the case rests on measured data (see §4.3 and §11).
2. Make embedding-model selection a first-class, self-describing configuration surface:
   a new **Database** section in the Configuration window (above "Access Points"), with
   **Supabase** moved into it and an **Embeddings** subsection below Supabase that explains
   dimension size, context size, and approximate run time per model.
3. Add a **"Re-embed the database"** action that queues every document for re-embedding with
   the newly selected model.

The good news that shapes this whole plan: **the system is already a multi-model,
multi-dimension embedding system.** 384-dim and 768-dim embeddings coexist today, selected
per-tenant and switched by re-embedding. This plan extends an existing pattern rather than
inventing a new one.

---

## 2. Current state (what already exists)

### 2.1 Model registry
`packages/rag-core/src/index.ts`
- `:182` `EMBEDDING_PROVIDERS = ["supabase","ollama","openai"]`
- `:185` `EMBEDDING_MODEL_OPTIONS` — the single source of truth the UI dropdown and validation
  read. Current entries:

| provider | model | dims | contextTokens | queryPrefix | documentPrefix |
|---|---|---|---|---|---|
| supabase | gte-small | 384 | 512 | "" | "" |
| ollama | nomic-embed-text | 768 | 2048 | "search_query: " | "search_document: " |
| ollama | nomic-embed-text-v2-moe | 768 | 512 | "search_query: " | "search_document: " |
| ollama | embeddinggemma | 768 | 2048 | "" | "" |
| openai | text-embedding-3-small | 384 | 8191 | "" | "" |

- `:330` `getEmbeddingModelOption(provider, model)` — lookup; `embeddings.ts:239`
  `expectedEmbeddingDimensions` throws if a configured dimension doesn't match the registry.

### 2.2 Query-time embedding (web app)
`apps/web/src/lib/embeddings.ts`
- `:44` `getEmbeddingConfig(tenantId)` — reads the tenant's active `model_config` row
  (`is_active=true`), normalizes provider/model/dimensions.
- `:72` `validateEmbeddingSelection(...)` — runs a live smoke embedding for a candidate
  provider/model/dimensions **before committing**. This is the hook a model picker uses to
  "test before save."
- `:114` `createTextEmbeddingWithConfig(...)` — dispatches on provider:
  - `supabase` → `:126` calls the Supabase `gte-small-embedding` edge function.
  - `ollama` → `:157` calls the worker `/embed` proxy, or local Ollama.
  - else (openai) → `:188` **OpenAI-compatible HTTP**: reads a per-tenant `base_url` from
    `provider_access_configs`, an API key from Vault, POSTs to `{baseUrl}/embeddings` and
    **sends `dimensions`** in the body. **This branch is the one TEI reuses.**
- `:251` `normalizeEmbeddingProvider` — currently throws on anything but
  supabase/ollama/openai. Needs a new provider (see §5.1).
- `:294` `buildEmbeddingVersion` → `"provider:model:dimensions:v1"`. Stored per row.
- `:302` `embeddingPrefix`, `:313` `formatEmbeddingInput` — apply query/document prefixes.
  Qwen3 is instruction-aware and needs these (see §5.3).

### 2.3 Ingestion-time embedding (worker)
`apps/worker/src/index.ts`
- `:1285` `processJob` — dispatches on `job_type`.
- `:3174` `completeEmbedJob` → `:3236` `embedDocumentChunks` → reads the active
  `model_config` via `:3367` `getEmbeddingConfig` (same shape as the web app), batches
  chunks through `:3665` `callEmbeddingProvider` (`:3680` with batch-halving fallback), and
  upserts rows into `document_embeddings` (`:3303`) on conflict `(chunk_id, embedding_version)`.
- `:3540` `getChunksForEmbedding` + `:3587` `getExistingEmbeddingHashes` — **chunk-skip-by-hash**:
  chunks whose `chunk_hash` already matches a stored embedding for the current
  `embedding_version` are skipped. Switching model → new `embedding_version` → every chunk
  re-embeds automatically. Switching back is a no-op.
- The worker calls providers directly over HTTP (no web-app round trip): OpenAI branch
  POSTs to `{baseUrl}/embeddings` with `dimensions`; Ollama POSTs to `/api/embed`. **TEI
  slots into the OpenAI-compatible branch by pointing `base_url` at the TEI endpoint.**

### 2.4 Storage + search (Postgres)
- `document_embeddings.embedding` is **untyped `vector`** today. Evolution:
  - `20260714000100_initial_rag_schema.sql:180` created it `vector(1536)`.
  - `20260724000200_supabase_gte_small_embeddings.sql` altered it to `vector(384)`.
  - `20260725000100_ollama_embeddings_and_rag_context.sql:22` **altered it to plain
    `vector`** (untyped) so multiple dimensions can coexist, and added per-dimension
    partial HNSW expression indexes:
    ```sql
    create index document_embeddings_vector_384_idx
    on document_embeddings using hnsw ((embedding::vector(384)) vector_cosine_ops)
    where embedding_dimensions = 384;
    create index document_embeddings_vector_768_idx
    on document_embeddings using hnsw ((embedding::vector(768)) vector_cosine_ops)
    where embedding_dimensions = 768;
    ```
  - Each row carries `embedding_dimensions`, `embedding_provider`, `embedding_model`,
    `embedding_version`, so the table knows what produced every vector.
- `match_document_embeddings` (`20260801000200_restore_dynamic_vector_search.sql`,
  current) reads `vector_dims(query_embedding)` and branches on **384 and 768**, casts
  `de.embedding::vector(N)`, filters `embedding_dimensions = N` and `embedding_version`,
  and **raises "Unsupported embedding dimension" for anything else.** This is why 1024 and
  2560 need explicit branches before that raise.

### 2.5 Jobs + re-embed precedent
- `processing_jobs.job_type` CHECK allows `ingest, reprocess, extract, embed, delete`
  (`20260714000100:200`). **`embed` already exists** — it re-embeds existing chunks **without
  re-parsing** (`completeEmbedJob`). No new job kind is needed.
- Per-document re-embed API exists: `apps/web/src/app/api/v1/documents/[documentId]/embed/route.ts`.
- **Bulk re-embed precedent exists**: `apps/maintenance/src/restore-run.ts:179-209`
  `recoverAfterRestore`, when `reembed` is true, runs:
  ```sql
  insert into processing_jobs (tenant_id, document_id, job_type, status, stage, priority)
  select tenant_id, id, 'embed', 'queued', 'registered', 200 from documents
  ```
  "one embed job per document, at low priority so ordinary work is not stuck behind a
  re-embedding of the entire library." This is the template the new "Re-embed the database"
  action clones.
- **Re-embed-on-model-change wiring already exists** — but with limits. The PUT
  `/api/rag-settings` handler calls `upsertRagSettings` (`apps/web/src/lib/rag-settings.ts:68`),
  which on an embedding-model change calls `queueEmbeddingBackfillJobs`
  (`rag-settings.ts:140`/`:322`). That helper selects up to **1000** ready documents
  (`.limit(1000)`), inserts an `embed` job per document at **priority 35+index**, and stamps
  `requested_config` with the target `embedding_version`. So `field-help.ts:277`'s "Changing
  this setting marks existing content for re-embedding…" is **already true** — it is not
  aspirational. The gaps this plan closes are: (a) the **1000-document cap** silently leaves
  larger corpora partially re-embedded; (b) the jobs are `embed`-only (no re-chunk); (c)
  **chunk-size changes do not trigger any backfill** — `upsertRagSettings` updates the chunk
  settings but does not queue jobs when only the chunk size/overlap changed (see §7.6); (d)
  there is no UI affordance to trigger a full re-embed independently of saving (§7.1).
- `upsertEmbeddingModelConfig` (`rag-settings.ts:275`) is just the `model_config` write
  helper — it does not queue jobs itself; the orchestration lives in its caller
  `upsertRagSettings`. Keep that separation: the new "Re-embed the database" action (§7) is a
  separate route, not a second side effect of save.

### 2.6 Configuration UI
`apps/web/src/app/configuration/page.tsx` (single client page, ~4110 lines). Section order
today (group labels are positional JSX inside `configList`, no array/registry):
1. **Access points** (`:1204`) — Supabase, Ollama, OpenAI providers + "database setup" row
2. **Model tasks** (`:1252`) — vision, pdf_assembly, ask, extraction
3. **Runtime** (`:1275`) — context-window management, environment variables
4. **Storage** + **Backup** (emitted by `StorageAccessPanel.tsx`)
5. *(sibling panel)* Supabase connection (`SupabaseConnectionPanel.tsx`, rendered `:1335`)
6. *(sibling panel)* Administrators

Supabase config is currently scattered across **three** surfaces: the dedicated
`SupabaseConnectionPanel` (connection root, fingerprints, rotation/promote), the Supabase
row inside "Access points" (provider modal: URL/ref/host/db/password/service key), and the
"database setup" row (`/api/setup/supabase`). Embedding settings have **no dedicated UI** —
the only embedding knobs (`supabaseEmbeddingBatchSize`, `supabaseEmbeddingRetryCount`) are
generic env-var rows in the PlatformSettingsPanel. A `section.rag` help key
(`field-help.ts:550`, "RAG retrieval…") is already defined but **unused** — a RAG/Embeddings
section is anticipated but not built.
- **Chunk size + overlap have no home on the Configuration page either.** They live in
  `rag_ingestion_settings` (`chunk_max_tokens`, `chunk_overlap_tokens`, per-tenant) and are
  surfaced on the **dashboard** (`apps/web/src/app/page.tsx:172`), not in
  `configuration/page.tsx`. The API already persists them: PUT `/api/rag-settings`
  → `upsertRagSettings` accepts `chunkMaxTokens`/`chunkOverlapTokens` and writes them
  alongside the embedding model in one call. The validation lives in `rag-core`
  (`RagSettingsSchema`): `chunkMaxTokens` 100–2000, `chunkOverlapTokens` 0–500, with a
  superRefine requiring `chunkOverlapTokens < chunkMaxTokens`. Constants:
  `RAG_CHUNK_MIN_TOKENS=100`, `RAG_CHUNK_HARD_MAX_TOKENS=2000`,
  `RAG_CHUNK_OVERLAP_HARD_MAX_TOKENS=500`; defaults `chunkMaxTokens=900`,
  `chunkOverlapTokens=120`. This plan **moves chunk size + overlap into the Database >
  Embeddings section** so all document-shaping + embedding config is in one place (§6.5).
  No schema change is needed for them — the columns already exist.

---

## 3. The two new models

| model | params | native dims | context | MTEB retrieval | CPU? | license |
|---|---|---|---|---|---|---|
| qwen3-embedding-0.6b | 0.6B | 1024 (MRL 32→1024) | 32K | ~61.8 EN / 64.7 multilingual | ✅ yes | Apache 2.0 |
| qwen3-embedding-4b | 4B | 2560 (MRL …→2560) | 32K | ~69.6 | ⚠️ GPU strongly preferred | Apache 2.0 |

For reference, the current models score ~62 (gte-small/nomic/text-embedding-3-small), and
qwen3-embedding-8b (GPU-only, ~70.9) is the ceiling we are not targeting.

### 3.1 Why 0.6b is the CPU tier
- 0.6B params → query embedding ~80–200 ms on CPU (INT4 ~50–120 ms), well within RAG
  query-time budget. Batch ~50–150 chunks/sec on CPU.
- 32K context handles long chunks generously (current models cap at 512–8191).
- Served via **Hugging Face TEI** (Text Embeddings Inference) CPU image on Railway's private
  network → kills the external embedding call that dominates retrieval today.
- Microsoft ships an INT4 CPU Olive recipe that keeps MTEB within ~5% of full precision.

### 3.2 Why 4b is the GPU upsell
- 4B on CPU is **~0.5–1.5 s per query** — slower than the external OpenAI call it would
  replace. On a GPU it is ~30–80 ms query-time and high batch throughput. **It must be
  served from a GPU host**, not the Railway CPU service.
- ~69.6 retrieval MTEB vs ~62 baseline is a **~7-point gain** — the substantive quality jump
  that makes "add a GPU" easy to sell **if it holds on your corpus** (see §11 caveat).
- Railway has **no GPU instances**, so 4b is hosted on an external GPU provider (RunPod /
  Modal / Replicate / a cloud GPU instance) running TEI or vLLM, exposed as an
  OpenAI-compatible endpoint. Because both the web app and worker already speak the
  OpenAI-compatible `/embeddings` protocol, the 4b endpoint is **just another base_url** to
  them — no client code changes, just configuration.

### 3.3 Dimension and storage implications
2560-dim vectors are ~2.5× the storage of 1024 and ~6.7× of 384; the HNSW index and table for
a 4b-embedded corpus are materially larger. 1024 is a reasonable middle; 2560 is the premium
you pay storage/index-build cost for, in exchange for quality. This is part of the GPU
tier's cost story and should be shown in the UI (§6.2).

---

## 4. Serving architecture on Railway

### 4.1 0.6b — TEI on Railway CPU
Deploy **Hugging Face Text Embeddings Inference** as a Railway service:
```
ghcr.io/huggingface/text-embeddings-inference:cpu-1.9 --model-id Qwen/Qwen3-Embedding-0.6B
```
- Expose only on the **Railway private network** (the web + worker services already use
  private networking). No public endpoint needed.
- TEI is OpenAI-compatible (`/embeddings`, accepts `dimensions` for MRL, Bearer auth
  optional). The existing OpenAI branch in `embeddings.ts:188` and the worker's
  `callOpenAiEmbeddings` already send `dimensions` and read `base_url` from
  `provider_access_configs` + a key from Vault.
- Persist the model weights on a Railway volume so cold starts don't re-download.
- Run the **INT4** variant (Olive ONNX) if you want the lowest CPU latency/RAM; verify MTEB
  stays within ~5% (Olive's documented bound).

### 4.2 4b — TEI/vLLM on an external GPU host
- Host qwen3-embedding-4b on a GPU instance (RunPod/Modal/Replicate or a cloud GPU VM)
  running TEI (GPU image) or vLLM in embedding mode. Expose an OpenAI-compatible
  `/embeddings` endpoint, ideally private (private networking / signed URL / IP allowlist).
- Register it in `provider_access_configs` as a provider (e.g. `qwen-gpu`) with that
  `base_url` and a token in Vault. The web/worker OpenAI-compatible branch reaches it with
  no code change.
- The GPU endpoint is the thing you **charge for**: it is the premium tier. The
  configuration UI marks this model "requires GPU" (§6.2).

### 4.3 Measured-data selling point (the whole point of 4b)
The 4b upsell is only credible with numbers. Before going to market:
1. Pick a labeled sample of your real query/document pairs (a few hundred, stratified by
   query length, language, document type).
2. Embed the sample with the current model (e.g. nomic 768) and with qwen3-0.6b and 4b.
3. Measure **nDCG@10 / Recall@10** for cosine search on each.
4. Compare. The ~7 MTEB-point gap is the *expected* gain; your corpus may show more, less,
   or a wash. The sales story is **your measured delta**, not the leaderboard (§11).
Keep the eval harness — re-run it whenever you consider a new model.

---

## 5. Code changes to add the two models

> **Chunk size + overlap need no schema change.** `chunk_max_tokens` /
> `chunk_overlap_tokens` already exist on `rag_ingestion_settings`, already flow through
> `upsertRagSettings` and the PUT `/api/rag-settings` handler, and are already validated by
> `RagSettingsSchema` in `rag-core`. The work for them in §6.5 is **UI relocation** (dashboard
> → Configuration > Database > Embeddings) plus the new reprocess-all route (§7.6) — no
> migration, no new column.

### 5.1 Registry (`packages/rag-core/src/index.ts`)
Add a provider and two model options. Use a distinct provider (e.g. `"tei"`) so CPU-TEI and
GPU-TEI endpoints and their base_urls are explicit and not conflated with `openai`:

```ts
export const EMBEDDING_PROVIDERS = ["supabase","ollama","openai","tei"] as const;

// append to EMBEDDING_MODEL_OPTIONS:
{
  provider: "tei",
  model: "qwen3-embedding-0.6b",
  label: "Qwen3 Embedding 0.6B (CPU)",
  dimensions: 1024,
  contextTokens: 32768,
  queryPrefix: "Instruct: Retrieve the most relevant document chunks for the user's question\nQuery: ",
  documentPrefix: "",
},
{
  provider: "tei",
  model: "qwen3-embedding-4b",
  label: "Qwen3 Embedding 4B (GPU)",
  dimensions: 2560,
  contextTokens: 32768,
  queryPrefix: "Instruct: Retrieve the most relevant document chunks for the user's question\nQuery: ",
  documentPrefix: "",
},
```

> Qwen3 is instruction-aware: the query side wants `Instruct: {task}\nQuery: {q}`; documents
> take no instruction (hence empty `documentPrefix`). The ~1–5% retrieval lift comes from
> this. `formatEmbeddingInput` (`embeddings.ts:313`) already supports separate query/doc
> prefixes, so no new prefix machinery is needed.

### 5.2 Provider dispatch
- `apps/web/src/lib/embeddings.ts:251` `normalizeEmbeddingProvider` — accept `"tei"`.
- The `:188` OpenAI-compatible branch already does the right thing (base_url from
  `provider_access_configs`, key from Vault, sends `dimensions`). Route `"tei"` through it
  (rename/relabel as needed) rather than writing a new HTTP client. TEI accepts the
  OpenAI `/embeddings` body shape including `dimensions`.
- `apps/worker/src/index.ts` `callEmbeddingProvider` (`:3665`) and `callOpenAiEmbeddings`
  (`:3619`) — same: route `"tei"` through the OpenAI-compatible call. Add `"tei"` to the
  worker's `getEmbeddingConfig` provider normalization and `buildEmbeddingVersion` is already
  generic (`provider:model:dimensions:v1`).
- Add `provider_access_configs` rows for `tei` (one base_url for the Railway CPU TEI, and
  optionally a second for the GPU endpoint) and store any auth token in Vault via the
  existing `provider_secret_refs` mechanism.

### 5.3 Schema/search (`match_document_embeddings`)
Add 1024 and 2560 branches mirroring the 384/768 pattern, **before** the raise. New
migration:

```sql
create or replace function match_document_embeddings(
  match_tenant_id uuid,
  query_embedding vector,
  match_count integer default 10,
  filter_project_id uuid default null,
  filter_document_id uuid default null,
  filter_chunk_types chunk_type[] default null,
  filter_embedding_version text default null,
  filter_silo_id uuid default null
) returns table (...) language plpgsql stable security definer set search_path = public as $$
declare embedding_dims integer := vector_dims(query_embedding);
begin
  if embedding_dims = 384  then return query select ... (de.embedding::vector(384)  <=> query_embedding::vector(384))  ... ; return; end if;
  if embedding_dims = 768  then return query select ... (de.embedding::vector(768)  <=> query_embedding::vector(768))  ... ; return; end if;
  if embedding_dims = 1024 then return query select ... (de.embedding::vector(1024) <=> query_embedding::vector(1024)) ... ; return; end if;
  if embedding_dims = 2560 then return query select ... (de.embedding::vector(2560) <=> query_embedding::vector(2560)) ... ; return; end if;
  raise exception 'Unsupported embedding dimension: %', embedding_dims using errcode = '22023';
end; $$;
```
(Use the **exact** SELECT body from the existing 384/768 branches — same joins, filters,
`embedding_dimensions = embedding_dims`, `embedding_version` filter, `limit least(greatest(match_count,1),50)` — only the cast dimension changes.)

Add per-dimension partial HNSW indexes (same pattern as the 384/768 indexes):

```sql
create index if not exists document_embeddings_vector_1024_idx
on document_embeddings using hnsw ((embedding::vector(1024)) vector_cosine_ops)
where embedding_dimensions = 1024;

create index if not exists document_embeddings_vector_2560_idx
on document_embeddings using hnsw ((embedding::vector(2560)) vector_cosine_ops)
where embedding_dimensions = 2560;
```

> The column is already untyped `vector`, so **no `ALTER COLUMN TYPE` is needed** — unlike
> the earlier gte-small migration that changed the column type. Only the function branches
> and the two partial indexes are new. Keep the generic-fallback idea out: a typed branch
> per dimension is what lets the per-dim partial HNSW index be used; a generic untyped `<=>`
> branch would seq-scan.

---

## 6. Configuration UI restructure

Goal: a **Database** section above "Access Points", with **Supabase** moved into it, and an
**Embeddings** subsection below Supabase. All in `apps/web/src/app/configuration/page.tsx`
unless noted.

### 6.1 New section order
Inside `<div className="configList">` (line 1203), insert above the "Access points" label
(line 1204):

1. **Database** (new group label) — contains the consolidated Supabase config + "database
   setup" action.
2. **Embeddings** (new subgroup label, below Supabase) — the model picker, the chunk size +
   overlap fields (§6.5), the "Re-embed the database" action (§6.4), and the "Re-chunk +
   re-embed the database" action (§6.6).
3. Access points (existing, minus the Supabase row and the "database setup" row, which
   move up).
4. Model tasks … (unchanged)
5. Runtime … (unchanged)

Add a `section.database` entry to `apps/web/src/lib/field-help.ts` and surface it with
`<SectionHelp helpKey="section.database">`. The Embeddings subsection can **reuse the
existing, currently-unused `section.rag`** help key (`field-help.ts:550`).

### 6.2 Consolidate Supabase into Database
Today Supabase config is split across (a) `SupabaseConnectionPanel.tsx` (sibling panel,
rendered `:1335` — connection root, fingerprints, rotation/promote/redeploy), (b) the
Supabase row's provider modal (`:1429` — URL/ref/host/db/password/service key), and (c) the
"database setup" modal (`:2578`, runs `/api/setup/supabase`).

Consolidate into the Database section:
- A **Supabase** `configItem` row that opens a modal combining the connection values + the
  rotation/promote flow (lift `SupabaseConnectionPanel`'s content into a modal, or keep the
  panel but render it inside the Database group instead of as a sibling).
- A **database setup** `configItem` row (the existing `setupOpen` modal) as the "initialize
  / repair schema" action inside Database.
- Remove the Supabase row and the "database setup" row from "Access points" (`PROVIDER_ACCESS_ORDER`
  at `:286` currently lists `"supabase"` first — drop it from the access-points list since it
  now lives in Database). Supabase is conceptually the *database*, not a model "access
  point" like Ollama/OpenAI, so this is a clearer mental model.

### 6.3 Embeddings subsection — the model picker
A new `configItem` row "Embedding model" that opens a modal. The modal:

- **Model selector** — dropdown sourced from `EMBEDDING_MODEL_OPTIONS` (the same registry
  the validation reads). Group by provider. Mark `qwen3-embedding-4b` with a
  **"requires GPU"** badge.
- **Per-model descriptive card** (shown for the selected model) with, in plain language:
  - **Dimension size** — what it means (the width of the vector; bigger = more expressive
    but more storage and a larger/slower index). Show the number and a one-line gloss.
  - **Context size** — max input tokens the model accepts per chunk; chunks longer than this
    are truncated. Show contextTokens.
  - **Approximate run time** — a per-query estimate and a rough batch throughput, with the
    hardware assumption stated. Suggested table to show in the UI:

    | model | dims | context | query embed (est.) | batch (est.) | needs |
    |---|---|---|---|---|---|
    | Supabase gte-small | 384 | 512 | ~50–100 ms (hosted) | n/a (hosted) | Supabase edge fn |
    | Ollama nomic-embed-text | 768 | 2048 | ~20–60 ms (local CPU) | ~150–250 ch/s | local Ollama |
    | OpenAI text-embedding-3-small | 384 | 8191 | ~100–300 ms (external) | API-limited | OpenAI key |
    | Qwen3 0.6B | 1024 | 32K | ~80–200 ms (CPU, INT4 ~50–120) | ~50–150 ch/s | Railway CPU (TEI) |
    | Qwen3 4B | 2560 | 32K | ~30–80 ms (GPU) / ~0.5–1.5 s (CPU) | high (GPU) | **GPU endpoint** |

    > These are estimates to set expectations, not guarantees. Label them "approximate,
    > depends on hardware/load" in the UI and link to a short "How we measured this" note
    > once you have on-hardware numbers.
  - **Quality hint** — a relative ranking (baseline / improved / premium) with a link to the
    measured-eval methodology (§4.3), not a raw MTEB number that over-promises.
- **"Test before save"** — a button that calls `validateEmbeddingSelection`
  (`embeddings.ts:72`) for the selected model and shows pass/fail. This already exists in
  code; wire the UI to it. Failure (e.g. GPU endpoint unreachable, wrong dim returned) must
  block save.
- **Save** — writes the tenant's `model_config` row via `upsertEmbeddingModelConfig`
  (`rag-settings.ts:275`). Saving does **not** by itself re-embed (see §7) — the save and the
  re-embed are two buttons so the admin can change config without kicking off a full
  re-embed, and can re-embed later.

### 6.5 Chunk size + overlap (moved into Embeddings)

Chunk size and overlap are **document-shaping** settings that live just downstream of the
embedding model — chunk size must fit the model's context window, and the chunk/overlap
ratio affects retrieval granularity. They belong next to the model picker, so this plan
moves them out of the dashboard (`apps/web/src/app/page.tsx:172`) and into the Database >
Embeddings section. The API already accepts them in the same PUT `/api/rag-settings` call
as the model, so this is a **UI relocation, not a new endpoint**.

Add two fields to the Embeddings modal, below the model card and above the action buttons:

- **Chunk size (tokens)** — `chunkMaxTokens`. Bounds **100–2000**
  (`RAG_CHUNK_MIN_TOKENS` / `RAG_CHUNK_HARD_MAX_TOKENS`), default **900**. Plain-language
  help: "Maximum tokens per chunk. Larger chunks carry more context per result but are
  truncated if they exceed the model's context size, and dilute the embedding's focus on any
  one passage. Smaller chunks return more targeted snippets but may split a point across
  two results." Show the selected model's `contextTokens` next to this field and warn when
  `chunkMaxTokens` exceeds it — e.g. the legacy Supabase gte-small model caps at 512 tokens,
  so a 900-token chunk is silently truncated; Qwen3 (32K) is never truncated by any setting
  in range. This interaction is the main reason chunk size belongs on the Embeddings screen.
- **Chunk overlap (tokens)** — `chunkOverlapTokens`. Bounds **0–500**
  (`RAG_CHUNK_OVERLAP_HARD_MAX_TOKENS`), default **120**, and must be **strictly less than**
  the chunk size (the `RagSettingsSchema` superRefine rejects `overlap >= chunkMaxTokens`).
  Help: "Tokens shared between adjacent chunks so a point sitting on a chunk boundary still
  appears whole in one of them. Set to 0 for no overlap, or roughly 10–15% of the chunk size
  as a rule of thumb. Must be smaller than the chunk size."

Both fields are validated client-side against the same bounds as the server
(`RAG_SETTINGS_LIMITS` in `rag-settings.ts:174` carries the limits for the UI) before the
PUT, so out-of-range values never leave the browser. On save, `upsertRagSettings` writes
both columns to `rag_ingestion_settings` in the same call that writes the embedding model.

**Crucially, changing chunk size/overlap does NOT by itself re-chunk existing documents.**
The PUT updates the settings used for *future* ingestion only. Existing `document_chunks`
keep their old boundaries. Re-shaping already-ingested documents needs a `reprocess` job
(re-parse → re-chunk → re-embed), which is a different, heavier flow than the `embed`-only
re-embed (§7.6). Surface this distinction in the UI: an explanatory note under the chunk
fields — "Applies to new uploads. To re-cut existing documents with these settings, use
Re-chunk + re-embed the database below." — plus the re-chunk action in §6.6.

### 6.4 "Re-embed the database" action
In the Embeddings modal (or as a second `configItem` row in the Embeddings subgroup), a
**"Re-embed the database"** action:
- Shows the count of documents that will be re-embedded and the selected target model.
- Requires the model to have been saved first (or warns that it will use the current active
  model).
- On confirm, calls the new re-embed-all endpoint (§7) and shows the queued count + a link
  to the Work Queues view to watch progress.
- Explains, in plain language: "Every document will be re-embedded with the selected model.
  Existing chunks are reused (no re-parsing). Old embeddings are kept until the new ones are
  ready, then can be pruned. This runs in the background at low priority so normal work is not
  blocked."

### 6.6 "Re-chunk + re-embed the database" action
A second action in the Embeddings modal, distinct from §6.4, for when the admin has changed
the **chunk size or overlap** rather than (or in addition to) the model:
- Shows the count of documents to re-process and the **current chunk settings + selected
  model**.
- On confirm, calls the new reprocess-all endpoint (§7.6) — **not** the re-embed endpoint.
  Re-embedding alone (§6.4) is wrong here: the chunks keep their old boundaries, so the new
  chunk size would never take effect on existing documents.
- Explains, in plain language: "Each document is re-parsed and re-cut with the current chunk
  size and overlap, then re-embedded with the selected model. This is heavier than a plain
  re-embed: it re-reads the source files and regenerates chunks, so it takes longer and does
  more work. New chunks replace the old ones. Runs in the background at low priority."
- Because `reprocess` regenerates `document_chunks`, **old embeddings become orphaned** once
  the new chunks are written — they reference `chunk_id`s that no longer exist. The
  reprocess flow already deletes/replaces chunk rows; confirm the worker also removes their
  `document_embeddings` rows (or relies on the FK/cascade) so the old vectors don't linger.
  See §7.6 and §11.

---

## 7. Re-embed the database (the new flow)

### 7.1 New admin route
Add an admin route, e.g. `POST /api/embeddings/reembed-all` (or
`POST /api/model-config/reembed`), that:

1. **Guards with `requireAdmin`** (`apps/web/src/lib/admin-guard.ts`). The
   `security-concerns.md` systemic finding is that ~60 control-panel routes call only
   `requireSupabase` with no identity check — **do not repeat that here.** This route mutates
   state for the whole tenant, so it must be admin-gated.
2. Reads the tenant's active `model_config` (the saved target model) and its
   `embedding_version` = `buildEmbeddingVersion(provider, model, dimensions)`.
3. Enqueues one `embed` job per document — clone the restore precedent
   (`apps/maintenance/src/restore-run.ts:179-209`), scoped to the tenant (and optionally to a
   silo/project if a scope is supplied), at **priority 200** so routine work isn't blocked:
   ```sql
   insert into processing_jobs (tenant_id, document_id, job_type, status, stage, priority, requested_config)
   select d.tenant_id, d.id, 'embed', 'queued', 'registered', 200,
          jsonb_build_object('source','reembed_all','target_embedding_version', $1)
   from documents d
   where d.tenant_id = $2
     and d.status = 'ready'
     and not exists (
       select 1 from processing_jobs p
       where p.document_id = d.id
         and p.job_type = 'embed'
         and p.status in ('queued','running')
     );
   ```
   The `not exists` guard prevents double-queueing if the admin clicks twice.
4. Calls `wakeWorker("reembed_all")` so idle workers pick up immediately.
5. Returns the queued count and the target `embedding_version`.

### 7.2 Determinism: snapshot the target version
`getEmbeddingConfig` reads `is_active` `model_config` at job run time, so a job queued now
will use whatever is active when it runs — usually fine, but if an admin changes the model
again mid-re-embed, late jobs would use the newer model. For determinism, store the
`target_embedding_version` in `requested_config` (above) and have `completeEmbedJob`
prefer it over the live `model_config` when present. This is a small, contained change to
the worker and makes a re-embed run produce a single consistent `embedding_version`.

### 7.3 Worker behavior (already exists)
- The `embed` job kind flows through `completeEmbedJob` → `embedDocumentChunks`
  (`apps/worker/src/index.ts:3174`/`:3236`). It reads existing `document_chunks` (no
  re-parse), embeds them with the target model, and upserts `document_embeddings` on
  `(chunk_id, embedding_version)`.
- The chunk-skip-by-hash (`:3540`) skips chunks already embedded for that
  `embedding_version`, so a re-embed is resumable and idempotent.
- Because rows are upserted on `(chunk_id, embedding_version)`, **old vectors are kept
  alongside new ones** — different `embedding_version`. Search stays correct throughout
  because `match_document_embeddings` filters by `embedding_version` (the query is embedded
  with the active model, so it only scores against same-version rows).

### 7.4 Prune old embeddings (recommended, separate step)
After a full re-embed completes, old `embedding_version` rows are dead weight (storage +
larger HNSW indexes). Add an optional "prune previous embeddings" action (or a maintenance
job) that deletes rows where `embedding_version <> <active>` for the tenant. **Keep this
manual / opt-in** until you trust the new model — old vectors are your rollback. Suggested:
a `DELETE FROM document_embeddings WHERE tenant_id = $1 AND embedding_version <> $2` behind
a confirm dialog showing how many rows will be removed.

### 7.5 Dimension-change safety
Switching to 1024 or 2560 just works at the storage level (untyped column + the new partial
indexes from §5.3). Two things to verify operationally:
- The **first** 1024/2560 query before the per-dim index exists will seq-scan — so create the
  indexes (§5.3) **before** flipping queries to the new model. `CREATE INDEX` on a large
  table takes time; build it `CONCURRENTLY` and out of band.
- The worker's `expectedEmbeddingDimensions` (`:3474`) must accept 1024/2560 — it will once
  the registry (§5.1) lists those models with those dimensions.

### 7.6 Re-chunk + re-embed (for chunk-size changes)
This is a **different flow** from §7.1–§7.5 and must not be confused with it. When the admin
changes **chunk size or overlap** (§6.5) and wants it to apply to existing documents, the
`embed` job used by re-embed-all is the **wrong job** — it reuses existing `document_chunks`
verbatim, so the new chunk size never takes effect. The right job is `reprocess`, which
re-parses the source file → regenerates chunks at the new size/overlap → re-embeds them via
the full ingestion path (`completeProviderIngest` / the same path a new upload takes).

- **New admin route**, e.g. `POST /api/embeddings/reprocess-all`, gated with `requireAdmin`
  (same rule as §7.1). Clone the §7.1 SQL but emit `'reprocess'` jobs, and stamp
  `requested_config` with `{"source":"rechunk_all","chunk_max_tokens":..., "chunk_overlap_tokens":...,
  "target_embedding_version":...}`.
  ```sql
  insert into processing_jobs (tenant_id, document_id, job_type, status, stage, priority, requested_config)
  select d.tenant_id, d.id, 'reprocess', 'queued', 'registered', 200,
         jsonb_build_object('source','rechunk_all','target_embedding_version', $1)
  from documents d
  where d.tenant_id = $2
    and d.status = 'ready'
    and not exists (
      select 1 from processing_jobs p
      where p.document_id = d.id
        and p.job_type in ('reprocess','ingest')
        and p.status in ('queued','running')
    );
  ```
  Priority **200** like re-embed (low, behind routine work). `reprocess` re-reads the source
  file, so the documents must still be reachable in storage (a caveat to surface in the UI —
  if the original was deleted from Storage, the reprocess job cannot re-parse it and will
  fail that document).
- **Not currently wired.** `upsertRagSettings` queues backfill jobs only on an
  embedding-model change (`queueEmbeddingBackfillJobs`, `rag-settings.ts:140`), and those
  jobs are `embed`-only. A **chunk-size-only change** queues nothing today — the settings are
  written and apply to future uploads, and existing documents keep their old chunks. This
  route is the new wiring for that case.
- **Heavier than re-embed.** `reprocess` re-parses (OCR/PDF text extraction if applicable)
  and re-chunks, then re-embeds. On a large corpus this is meaningfully more CPU and time
  than `embed`-only, and it touches storage (re-reads source files). Warn the admin in the
  UI (§6.6) and let them scope it to a silo/project before queueing the whole tenant.
- **Old embeddings orphaned.** Because `reprocess` regenerates `document_chunks`, the old
  `chunk_id`s go away and their `document_embeddings` rows must be removed (or cascade) so
  stale vectors don't linger and pollute the index. Confirm the existing `reprocess`/delete
  path cleans `document_embeddings` for replaced chunks; if it only deletes chunk rows, add
  the embedding cleanup. This is a correctness point, not just storage hygiene — a stale
  vector for a deleted chunk can still be returned by `match_document_embeddings` until it's
  gone.
- **Resumability** is coarser than re-embed: the chunk-skip-by-hash
  (`getChunksForEmbedding`/`getExistingEmbeddingHashes`, `:3540`) keys on chunk content hash,
  and re-chunked chunks have new hashes, so a partially-completed reprocess of a document
  re-does that document from parse. Acceptable, but it means a reprocess-all interruption is
  more re-work than an embed-all interruption.

---

## 8. End-to-end rollout sequence

1. **Registry + provider** (§5.1, §5.2): add `"tei"` provider + the two model options;
   route `tei` through the OpenAI-compatible branches in web + worker. No behavior change
   yet (nothing selects them).
2. **Schema** (§5.3): migration adds the 1024/2560 `match_document_embeddings` branches and
   the two partial HNSW indexes. Deploy via the maintenance service's migration runner.
3. **TEI services**: stand up the Railway CPU TEI (0.6b) and the external GPU endpoint (4b);
   add `provider_access_configs` rows + Vault tokens.
4. **Smoke-test**: use `validateEmbeddingSelection` against both endpoints; confirm returned
   dimensions match (1024 / 2560) and a sample query returns sane neighbors.
5. **Eval** (§4.3): on a labeled sample, measure nDCG@10 for current vs 0.6b vs 4b. Record
   the numbers — this is the sales artifact and the go/no-go for 4b.
6. **UI** (§6): ship the Database section, the consolidated Supabase config, the Embeddings
   model picker (with the descriptive cards), the chunk size + overlap fields (§6.5), and
   the two actions — "Re-embed the database" (§6.4) and "Re-chunk + re-embed the database"
   (§6.6).
7. **Reprocess-all route** (§7.6): ship the `reprocess`-emitting admin route alongside the
   re-embed-all route (§7.1). Without it, chunk-size changes saved in the new UI affect only
   future uploads, which would be a silent footgun now that chunk settings live next to the
   re-embed button.
8. **Pilot tenant**: switch one tenant to 0.6b, run re-embed-all, watch Work Queues, verify
   retrieval quality on real traffic. Then offer 4b (GPU) as the premium tier to customers
   who want the measured delta.
9. **Prune** (§7.4): after confidence, prune the old `embedding_version` rows for migrated
   tenants.

---

## 9. Files touched (summary)

| Concern | File | What |
|---|---|---|
| Model registry | `packages/rag-core/src/index.ts` (`:182`,`:185`,`:330`) | add `tei` provider + 2 options |
| Web provider dispatch | `apps/web/src/lib/embeddings.ts` (`:188`,`:251`) | accept `tei`, route via OpenAI-compatible branch |
| Worker provider dispatch | `apps/worker/src/index.ts` (`:3474`,`:3619`,`:3665`,`:4060`) | accept `tei`, route via OpenAI-compatible call; prefer `requested_config.target_embedding_version` |
| Search function + indexes | new migration | 1024/2560 branches in `match_document_embeddings` + 2 partial HNSW indexes |
| Re-embed-all route | new `apps/web/src/app/api/embeddings/reembed-all/route.ts` | admin-gated bulk `embed` queue (clone `restore-run.ts:179`) |
| Reprocess-all route | new `apps/web/src/app/api/embeddings/reprocess-all/route.ts` | admin-gated bulk `reprocess` queue for chunk-size changes (§7.6) |
| Config UI | `apps/web/src/app/configuration/page.tsx` (`:1204`,`:1335`,`:2578`) | Database section above Access Points; consolidate Supabase; Embeddings subsection + model modal + chunk size/overlap fields + re-embed + re-chunk actions |
| Chunk settings (relocate) | `apps/web/src/app/page.tsx` (`:172`) → configuration | remove chunk size/overlap from dashboard; render in Embeddings modal (§6.5) |
| Supabase panel | `apps/web/src/components/SupabaseConnectionPanel.tsx` | relocate/refactor into Database section |
| Help text | `apps/web/src/lib/field-help.ts` (`:277`,`:550`) | add `section.database`; correct the re-embed help text (wiring exists, with limits — §2.5); surface `section.rag`; add chunk-field help |
| Rag settings API | `apps/web/src/app/api/rag-settings/route.ts`, `apps/web/src/app/api/v1/rag-settings/route.ts` | already accepts chunk + model in one PUT; no change needed for chunk fields |
| Model save | `apps/web/src/lib/rag-settings.ts` (`:68`,`:140`,`:275`,`:322`) | `upsertRagSettings` already queues `embed` backfill on model change (cap 1000, priority 35); add chunk-size-change → no backfill today (§7.6 closes the gap) |

---

## 10. Recommendations

- **0.6b is the included tier; 4b is the paid GPU tier.** Frame it that way in the UI and
  in sales. 0.6b alone already removes the external embedding call (the original latency
  win) and gives a small quality bump; 4b is the ~7-point premium that justifies a GPU.
- **Never expose 4b as a CPU query-time model.** Gate it in the UI behind "requires GPU"
  and refuse to save it (or warn loudly) if the `tei` GPU endpoint isn't configured/reachable.
- **Decouple the one-time bulk re-embed from serving.** The first full re-embed of a large
  corpus is throughput-bound; on CPU it's slow. Consider running the initial re-embed of a
  big tenant on a transient GPU even if the ongoing query-time model is 0.6b on CPU — you
  pay GPU once, not forever. (The worker reads the endpoint from `provider_access_configs`,
  so you can point it at a GPU TEI for the bulk run and back to the CPU TEI after.)
- **Keep save and re-embed as two buttons.** Admins should be able to change config, test,
  and re-embed on their own schedule. Auto-re-embedding on every save would be a footgun.
- **Chunk size belongs on the Embeddings screen, and its re-cut action must ship with it.**
  The chunk size and the model's context window interact (a 900-token chunk is silently
  truncated on a 512-context model), so co-locating them is the right call — but only if the
  "Re-chunk + re-embed the database" action (§6.6/§7.6) lands in the same release. Without
  it, the new UI promises control over existing documents it can't deliver.
- **Default chunk size (900) was set for 512–8191-context models.** Once Qwen3 (32K context)
  is the active model, larger chunks (e.g. 1200–1500) become safe and can carry more context
  per result. Treat the chunk default as model-dependent guidance, not a fixed number — but
  never set it above the active model's `contextTokens`.
- **Keep old embeddings until you trust the new model.** `embedding_version` filtering makes
  rollback free; pruning is opt-in.
- **Build the eval harness once and keep it.** It's how you sell 4b and how you choose the
  next model after that.

---

## 11. Risks and caveats

- **MTEB ≠ your corpus.** Two models within 1 MTEB point regularly sit 8–12 points apart on
  real traffic. The ~7-point 4b gain is the *expected* delta; **your measured nDCG@10 on your
  data is the only number that should go in the sales pitch.** Run §4.3 before claiming
  anything. If 4b doesn't beat 0.6b meaningfully on your corpus, the GPU upsell has no leg to
  stand on — and that's an acceptable, data-driven outcome.
- **4b on CPU is a regression, not an improvement** (~0.5–1.5 s/query). The UI and the save
  validation must prevent selecting it without a working GPU endpoint.
- **2560-dim storage/index cost** is real (~6.7× the 384 baseline). For large libraries the
  HNSW index build and RAM for 2560-dim can be significant; budget for it in the GPU tier's
  pricing.
- **`match_document_embeddings` currently raises on unsupported dims.** Forgetting the
  1024/2560 branches (§5.3) means the first query with the new model errors with
  "Unsupported embedding dimension." Add the branches before flipping any tenant.
- **The re-embed help text is half-true today.** `field-help.ts:277` claims changing the
  embedding model marks content for re-embedding — and `queueEmbeddingBackfillJobs`
  (`rag-settings.ts:140/322`) does queue `embed` jobs on a model change, so it isn't a lie.
  But it **silently caps at 1000 documents** and queues `embed`-only (no re-chunk), so on a
  larger corpus the promise is only partially kept. With the new explicit "Re-embed the
  database" action (§6.4) handling the full unbounded re-embed, reword the help text to point
  at that action for a complete re-embed, and document the 1000-doc auto-backfill as a
  best-effort start.
- **Chunk-size change does not re-cut existing documents.** This is the biggest footgun in
  the new UI: an admin lowers the chunk size expecting tighter retrieval, the PUT succeeds,
  and nothing changes for existing documents — only future uploads get the new size. Without
  the §6.6/§7.6 reprocess action shipped alongside the chunk fields, moving chunk settings
  onto the Configuration page makes this trap *more* visible, not less. Ship them together.
- **Reprocess-all is heavier and re-reads source files.** Unlike re-embed (chunks reused in
  place), `reprocess` re-parses from Storage. If an original document was deleted from
  Storage, that document's reprocess job fails. Surface this in the UI and allow silo/project
  scoping before queueing the whole tenant.
- **Reprocess orphans old embeddings.** Regenerating `document_chunks` retires the old
  `chunk_id`s; their `document_embeddings` rows must be removed (or cascade) or stale vectors
  linger and can still be returned by `match_document_embeddings`. Verify the existing
  `reprocess`/delete path cleans embeddings for replaced chunks before relying on it.
- **1000-doc cap on the existing auto-backfill.** `queueEmbeddingBackfillJobs` uses
  `.limit(1000)`. A tenant with more ready documents gets a partial auto re-embed on model
  change with no warning. The new explicit re-embed-all route (§7.1) has no cap, so recommend
  the admin use that for any real migration and treat the auto-backfill as a starter.
- **Admin guarding.** The re-embed-all and reprocess-all routes mutate state for the whole
  tenant. Both must use `requireAdmin`, not just `requireSupabase` (see `security-concerns.md`).
- **TEI vs Ollama for 0.6b.** Ollama can run some embedding models but qwen3-embedding is
  best served via TEI (official CPU image, INT4, dynamic batching, OpenAI-compatible). Don't
  try to force it through the existing Ollama path unless Ollama packages that model well.
- **Provider naming.** Using `"tei"` (not `"openai"`) keeps the OpenAI-compatible branch
  reusable without conflating "OpenAI the company" with "self-hosted TEI." It also makes the
  GPU endpoint a distinct `provider_access_configs` row.

---

## 12. References

### Models
- Qwen3-Embedding-0.6B: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Qwen3-Embedding-4B: https://huggingface.co/Qwen/Qwen3-Embedding-4B
- Qwen3-Embedding blog: https://qwenlm.github.io/blog/qwen3-embedding/
- Microsoft Olive INT4 CPU recipe (0.6B): https://github.com/microsoft/olive-recipes/tree/main/Qwen-Qwen3-Embedding-0.6B/cpu

### Serving
- Hugging Face Text Embeddings Inference (TEI): https://github.com/huggingface/text-embeddings-inference/
- vLLM (GPU, embedding mode): https://railway.com/deploy/vllm
- MTEB leaderboard: https://huggingface.co/spaces/mteb/leaderboard

### In-repo load-bearing code (read-only references)
- Model registry: `packages/rag-core/src/index.ts` (`EMBEDDING_PROVIDERS:182`,
  `EMBEDDING_MODEL_OPTIONS:185`, `getEmbeddingModelOption:330`; chunk constants
  `RAG_CHUNK_MIN_TOKENS`, `RAG_CHUNK_HARD_MAX_TOKENS=2000`,
  `RAG_CHUNK_OVERLAP_HARD_MAX_TOKENS=500`; `DEFAULT_RAG_SETTINGS` chunkMaxTokens=900 /
  chunkOverlapTokens=120; `RagSettingsSchema` superRefine `overlap < chunkMaxTokens`)
- Web embedding: `apps/web/src/lib/embeddings.ts` (`getEmbeddingConfig:44`,
  `validateEmbeddingSelection:72`, OpenAI-compatible branch `:188`,
  `normalizeEmbeddingProvider:251`, `buildEmbeddingVersion:294`, `formatEmbeddingInput:313`)
- Worker embedding: `apps/worker/src/index.ts` (`processJob:1285`, `completeEmbedJob:3174`,
  `embedDocumentChunks:3236`, `getEmbeddingConfig:3367`, `callEmbeddingProvider:3665`,
  `getChunksForEmbedding:3540`, `getExistingEmbeddingHashes:3587`)
- Rag settings (chunk + model save + backfill): `apps/web/src/lib/rag-settings.ts`
  (`getRagSettings:34`, `upsertRagSettings:68` → calls `queueEmbeddingBackfillJobs:140/322`
  on model change, cap 1000, priority 35, embed-only; `RAG_SETTINGS_LIMITS:174`;
  `resolveEmbeddingSelection:230`; `upsertEmbeddingModelConfig:275`)
- Rag settings API: `apps/web/src/app/api/rag-settings/route.ts` and
  `apps/web/src/app/api/v1/rag-settings/route.ts` (GET/PUT; already accepts chunk + model)
- Schema/search: `supabase/migrations/20260725000100_ollama_embeddings_and_rag_context.sql`
  (untyped `vector` + per-dim partial HNSW indexes), `20260801000200_restore_dynamic_vector_search.sql`
  (current `match_document_embeddings`, 384/768 only)
- Jobs: `supabase/migrations/20260714000100_initial_rag_schema.sql:200` (`job_type` CHECK:
  ingest/reprocess/extract/embed/delete), `apps/maintenance/src/restore-run.ts:179` (bulk
  re-embed precedent), `apps/web/src/app/api/v1/documents/[documentId]/embed/route.ts`
  (per-doc embed)
- Config UI: `apps/web/src/app/configuration/page.tsx` (Access points `:1204`, Model tasks
  `:1252`, `SupabaseConnectionPanel` render `:1335`, setup modal `:2578`),
  `apps/web/src/components/SupabaseConnectionPanel.tsx`, `apps/web/src/lib/field-help.ts`
  (`section.rag:550` unused, re-embed help text `:277`)
- Chunk settings today (to be relocated): `apps/web/src/app/page.tsx:172` (dashboard chunk
  size/overlap surface — moves into Configuration > Database > Embeddings per §6.5)
- Model save: `apps/web/src/lib/rag-settings.ts:275` (`upsertEmbeddingModelConfig`)
- Related: `docs/security-concerns.md` (admin-guard requirement for the new route),
  `docs/archi-change.md` (Railway CPU/no-GPU constraint, embeddings-on-Railway context)