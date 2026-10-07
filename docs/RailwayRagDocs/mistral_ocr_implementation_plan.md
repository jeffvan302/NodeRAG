# Mistral OCR as a Third PDF Parse Strategy

**Status:** Design settled 2026-08-19 (§11). Core implementation completed
2026-08-24, including configuration, transport, page/chunk convergence,
confidence and image persistence, usage ledger and soft caps, concurrency,
serialization, conditional fallback, progress, tests, and operator guidance.
The two deliberately out-of-scope follow-ons remain in §11.2. Written against
the `main` branch at commit time; every file path, line number, and symbol below
was read from the working tree, not assumed.
**Purpose:** Add Mistral Document AI (`POST /v1/ocr`) as a third PDF parse
option beside _Poppler utilities + selective vision_ and _Direct vision page
groups_, with a Mistral access point on the Configuration page, a
documents-in-parallel throughput control, an optional fallback to the vision
pipeline, and per-tenant cost metering with a spend cap.

---

## 1. Decision Summary

- **Mistral becomes a provider access point.** A new row appears in
  Configuration → _Access points_, directly under **Supabase**, with the same
  gear-icon modal pattern every other access point uses. Its API key goes into
  the local settings vault exactly like the Ollama/OpenAI/Modular keys, never
  into a Railway environment variable.
- **A third PDF parse option, `mistral_ocr`.** Selected in Configuration →
  _Model tasks_ → **pdf assembly** → _PDF parse option_. Choosing it hides the
  round-robin route builder and the Poppler-text toggle, and shows a Mistral
  OCR settings block instead.
- **Concurrency is per document, not per page.** Mistral takes a whole PDF in
  one call and returns per-page Markdown, so there is nothing to fan out
  _within_ a document. The single new throughput control is **Parallel
  documents** — how many separate PDFs one worker replica has in flight at
  once.
- **Page boundaries are preserved end to end.** Mistral returns
  `pages[].index` and `pages[].markdown`. We concatenate into one document
  Markdown and record a `PdfMarkdownPageSpan` per page — the same structure the
  direct-vision path already produces — so chunk-to-page attribution, character
  offsets, and neighbour-chunk expansion all work unchanged.
- **No new page-group queue.** The distributed `pdf_vision_page_group_jobs`
  machinery is a page-splitting mechanism and is not reused. Parallelism comes
  from `runAcceleratedJobBatch`, which already exists and already does exactly
  this for RunPod rechunk/embed jobs.
- **Conditional fallback to Direct vision page groups.** A _Fall back to direct
  vision_ checkbox in the Mistral settings. When it is checked **and** at least
  one vision route is configured, a Mistral failure re-runs the document
  through `completePdfDirectVisionIngest` and records which parser actually
  produced it. Otherwise the job fails loudly. §6.4.
- **Cost is metered, visible, and capped by default.** Every document records
  `usage_info.pages_processed`; a per-tenant ledger drives a running counter in
  the Configuration UI; and a cap defaulting to **10,000 pages per calendar
  month** (~$40) refuses new Mistral work past the threshold. §6.8.
- **Large documents run one at a time.** A document over a size threshold takes
  an exclusive worker slot instead of joining the parallel batch. This bounds
  both peak memory and — usefully — the spend-cap overshoot. §6.9.
- **Headers and footers are extracted, stored, and not embedded.** They land in
  `document_pages.metadata`, never in the Markdown that becomes chunks. §6.3.
- **No SDK dependency.** The worker calls Mistral over plain `fetch`, matching
  how every other provider is called today.

```text
Configuration page
  Access points
    Supabase
    Mistral            ← new: API key, base URL, test button
    Ollama
    OpenAI
    Modular
    Together AI
    OpenRouter
  Model tasks
    pdf assembly       ← PDF parse option gains a third choice
      ├── Poppler utilities + selective vision
      ├── Direct vision page groups
      └── Mistral OCR  ← new: model, parallel documents, OCR tuning
```

---

## 2. What Exists Today

Read before designing; this section is the baseline the plan builds on.

### 2.1 The two current strategies

`PDF_PARSE_STRATEGIES` in `packages/rag-core/src/index.ts:537` is
`["poppler", "vision_page_groups"]`. The worker branches on it in
`getPdfParseConfig()` (`apps/worker/src/index.ts:7131`) and dispatches in
`completePdfIngest()` (`apps/worker/src/index.ts:3096`):

| Strategy             | Worker entry point                        | Pipeline label                     |
| -------------------- | ----------------------------------------- | ---------------------------------- |
| `poppler`            | inline in `completePdfIngest`             | `pdf-poppler-v1`                   |
| `vision_page_groups` | `completePdfDirectVisionIngest` (`:4668`) | `pdf-direct-vision-v2-distributed` |

Both converge on the same three calls:

```ts
const documentMarkdown = buildPdfDocumentMarkdown({
  sourceFile,
  totalPages,
  processedPages,
  pages,
});
// → { markdown: string, pageSpans: PdfMarkdownPageSpan[] }

await insertDocumentChunksWithOptionalRunpod({
  job,
  markdown: documentMarkdown.markdown,
  spans: pdfPageSpansToDocumentSpans(documentMarkdown.pageSpans),
  ragSettings,
  provider,
  model,
  chunkingSource,
  chunkingVersion,
  extractionMethod,
  replaceExisting,
});
```

**This convergence point is the whole reason the change is small.** Anything
that can produce `PdfPageResult[]` gets chunking, embeddings, RunPod
acceleration, page attribution, and the generated `.md` artefact for free.

### 2.2 Where settings live

- **Per-task config:** `settingsClient.get(SETTINGS_COLLECTIONS.modelTasks,
"<tenantId>:tenant:pdf_assembly")`, whose `metadata` jsonb already holds
  `pdfParseStrategy`, `pdfPageGroupSize`, `pdfPageGroupConcurrency`,
  `pdfIncludePopplerText`, `pdfModelRoutes`. Written by
  `apps/web/src/app/api/model-tasks/route.ts`, read by the worker.
- **Provider secrets:** `SETTINGS_COLLECTIONS.providerSecrets`, keyed
  `<tenantId>:<provider>:api_key`. The `provider` field is an untyped string
  (`apps/web/src/lib/provider-secrets.ts`), so `mistral` needs no schema change
  to store a key.
- **Platform-wide runtime knobs:** `PlatformRuntimeSettingsSchema` +
  `RUNTIME_SETTING_FIELDS` in `packages/rag-core/src/index.ts`, surfaced by
  `PlatformSettingsPanel` and, for the PDF subset, by
  `apps/web/src/lib/pdf-parse-runtime-settings.ts`.

### 2.3 What already mentions Mistral

`mistral` is already in `PROVIDERS` (`:171`), already selectable as a model
task provider (`configuration/page.tsx:2920`), already resolves a base URL of
`https://api.mistral.ai/v1` for template ingestion
(`apps/worker/src/index.ts:1981`), and `DEFAULT_MODEL_CONFIG.ocrProvider` is
literally `"mistral"` (`:691`) — a vestigial default with no implementation
behind it.

**What is missing:** Mistral is not in `PROVIDER_ACCESS_POINTS` (`:188`), not in
`PROVIDER_ACCESS_ORDER` (`configuration/page.tsx:412`), and not in the
`PROVIDERS` array of `apps/web/src/app/api/provider-access/route.ts:34`. So
there is no UI to store its key, and the worker's only fallback is
`process.env.MISTRAL_API_KEY` (`apps/worker/src/index.ts:1994`) — which the
local-vault architecture is explicitly trying to retire.

### 2.4 How documents are processed in parallel today

`main()` in `apps/worker/src/index.ts:1036` claims **one** ingest job per loop
iteration. The one existing exception is at `:1106`:

```ts
const concurrency = processOnce
  ? 1
  : await getRunpodDocumentConcurrency(claimed.job);
if (concurrency > 1) {
  processedJobs += await runAcceleratedJobBatch({
    first: claimed,
    concurrency,
    claimNext: () =>
      claimNextJob({
        tenantId: claimed.job.tenant_id,
        jobTypes: ["rechunk", "embed"],
        expectedSettingsRevision: claimed.snapshot.revision,
      }),
    process: processClaimedJob,
  });
}
```

`getRunpodDocumentConcurrency` returns `1` unless the job type is `rechunk` or
`embed`. **Extending that gate to `ingest` when the strategy is `mistral_ocr`
is the entire parallelism change.** `runAcceleratedJobBatch`
(`apps/worker/src/accelerated-job-batch.ts`) is 35 lines, already tested, and
already handles claim-until-empty with a live concurrency ceiling.

---

## 3. The Mistral OCR API

Researched from Mistral's documentation. Anything account-specific is called
out; verify against `https://console.mistral.ai` before relying on it.

### 3.1 Endpoint

```
POST https://api.mistral.ai/v1/ocr
Authorization: Bearer <MISTRAL_API_KEY>
Content-Type: application/json
```

### 3.2 Request body

| Field                           | Type                                      | Default  | What it does                                                                                                    |
| ------------------------------- | ----------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `model`                         | string                                    | —        | OCR model id. See §3.5.                                                                                         |
| `document`                      | object                                    | —        | The input. Three shapes; see §3.3.                                                                              |
| `id`                            | string \| null                            | —        | Opaque caller-supplied id echoed back. Useful for log correlation.                                              |
| `pages`                         | string \| int[] \| null                   | all      | Page selection, **0-indexed** (`"0,1,2"` or `"0-5"`).                                                           |
| `include_image_base64`          | boolean                                   | false    | Return each extracted figure as a base64 image alongside its Markdown reference.                                |
| `image_limit`                   | int \| null                               | none     | Cap on how many images are extracted per document.                                                              |
| `image_min_size`                | int \| null                               | none     | Ignore images smaller than this many pixels on either side. Suppresses logos, bullets, rules.                   |
| `table_format`                  | `"markdown"` \| `"html"` \| null          | markdown | How tables are rendered inside the page Markdown.                                                               |
| `extract_header`                | boolean                                   | `false`  | Split running headers into a separate `pages[].header` field instead of leaving them inline.                    |
| `extract_footer`                | boolean                                   | `false`  | Same for footers.                                                                                               |
| `include_blocks`                | boolean                                   | `true`   | Return paragraph-level bounding boxes and structural block labels.                                              |
| `confidence_scores_granularity` | `"page"` \| `"block"` \| `"word"` \| null | none     | Emit OCR confidence at the chosen granularity.                                                                  |
| `bbox_annotation_format`        | ResponseFormat \| null                    | —        | Runs a vision LLM over each extracted bbox with your schema (figure captioning). **Extra cost, extra latency.** |
| `document_annotation_format`    | ResponseFormat \| null                    | —        | Runs a vision LLM over the whole document Markdown + first 8 image bboxes with your schema. **Extra cost.**     |
| `document_annotation_prompt`    | string \| null                            | —        | Free-text steer for `document_annotation_format`.                                                               |

### 3.3 Three ways to pass the document

```jsonc
// 1. Public URL — API must be able to reach it
{ "type": "document_url", "document_url": "https://…/report.pdf" }

// 2. Base64 data URI — no upload round trip
{ "type": "document_url", "document_url": "data:application/pdf;base64,…" }

// 3. Files API upload, then signed URL (recommended for us)
//    POST /v1/files  (multipart, purpose="ocr")  → { id }
//    GET  /v1/files/{id}/url?expiry=24           → { url }
{ "type": "document_url", "document_url": "<signed url>" }
```

Images use `{ "type": "image_url", "image_url": … }` instead.

**Settled: option 3, Files API upload + signed URL.** Our source PDFs live in a
private Supabase bucket, so option 1 would mean handing an external service a
path into our storage. Option 2 inflates a 50 MB PDF to ~67 MB of JSON in one
request body and holds it all in worker memory. Option 3 costs one extra HTTP
call, keeps the blob transfer as multipart, and never exposes Supabase.

Set the shortest workable signed-URL expiry — the OCR call follows immediately,
so `expiry=1` (one hour) is generous. Delete the uploaded file
(`DELETE /v1/files/{id}`) in a `finally` block so failed jobs do not leave
documents accumulating in the Mistral workspace.

### 3.4 Response

```jsonc
{
  "pages": [
    {
      "index": 0,                       // 0-based
      "markdown": "# Title\n\n…",
      "images": [ { "id": "img-0.jpeg", "top_left_x": …, "image_base64": "…" } ],
      "tables": [ … ],
      "hyperlinks": [ … ],
      "header": "…",                    // only when extract_header
      "footer": "…",                    // only when extract_footer
      "dimensions": { "dpi": 200, "height": 2200, "width": 1700 },
      "blocks": [ … ],                  // when include_blocks
      "confidence_scores": { … }        // when confidence_scores_granularity
    }
  ],
  "model": "mistral-ocr-4.1",
  "document_annotation": null,
  "usage_info": { "pages_processed": 42, "doc_size_bytes": 1048576 }
}
```

`usage_info.pages_processed` is the billing quantity, persisted both as
telemetry (§6.5) and as a cost-ledger row (§6.8).

### 3.5 Models

| Alias                | Notes                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `mistral-ocr-4.1`    | Latest. Paragraph bounding boxes, structural block labels, **block-level confidence scores**. |
| `mistral-ocr-4.0`    | Bounding boxes and block labels, no block confidence.                                         |
| `mistral-ocr-2512`   | "OCR 3". Older, cheaper generation.                                                           |
| `mistral-ocr-latest` | Rolling alias.                                                                                |

**Settled: default to `mistral-ocr-latest`.** Mistral OCR is a demo-speed path
here rather than the primary corpus builder, so tracking improvements
automatically is worth more than version stability. The field stays free text,
so any specific version can be pinned per installation.

**The drift this creates is mitigated, not ignored.** The OCR response echoes
the model that actually ran in its `model` field, so record both:

```jsonc
{
  "mistral_ocr_model_requested": "mistral-ocr-latest",
  "mistral_ocr_model_resolved": "mistral-ocr-4.1",
}
```

Storing the resolved value on every document means that when Mistral rolls the
alias forward, you can still answer "which engine version produced this
Markdown" for anything already ingested — which is the question that would
otherwise be unanswerable, and the only real cost of using an alias.

### 3.6 Limits

| Limit                  | Value                                                                            | Consequence for us                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Provider max file size | **512 MB**                                                                       | The application keeps a configurable, lower memory-safety guard; see §6.6.                                  |
| Max pages per document | **1,000**                                                                        | `pdfMaxPages` is already `min 1, max 1000, default 1000` (`rag-core:1444`). Exact match, nothing to change. |
| Input formats          | PDF, PPTX, DOCX, ODF; PNG, JPEG, AVIF                                            | We only route PDFs here.                                                                                    |
| Rate limits            | **Workspace-specific**, RPS + tokens/min, visible at `console.mistral.ai/limits` | This is why _Parallel documents_ must be operator-tunable rather than hardcoded.                            |

### 3.7 Cost

| Service                         | List price           | With Batch API   |
| ------------------------------- | -------------------- | ---------------- |
| OCR 4                           | **$4 / 1,000 pages** | $2 / 1,000 pages |
| Document AI (OCR + annotations) | **$5 / 1,000 pages** | —                |

A 1,000-page document is ~$4 synchronous. The Batch API supports `/v1/ocr` at a
50% discount but is asynchronous with queue latency — the opposite of the
demo-speed goal here. **Settled: synchronous only** (D8).

The list price is not a constant. Make it a setting so the cost ledger in §6.8
stays accurate when Mistral reprices, rather than hardcoding `4` in a cost
calculation that then silently lies. Stored as an integer number of
**thousandths of a cent per 1,000 pages** — see §7.1 for why that shape.

---

## 4. Configuration Page — Mistral Access Point

### 4.1 Placement

`PROVIDER_ACCESS_ORDER` (`apps/web/src/app/configuration/page.tsx:412`)
currently reads `["supabase", "ollama", "openai", "modular", "together",
"openrouter"]`. Insert `"mistral"` at index 1:

```ts
const PROVIDER_ACCESS_ORDER: Array<ProviderAccess["provider"]> = [
  "supabase",
  "mistral", // ← new, directly under Supabase as requested
  "ollama",
  "openai",
  "modular",
  "together",
  "openrouter",
];
```

The row then renders through the existing `orderedProviderAccess.map(...)` at
`:2029` with no other change — status pill, gear button, and modal all come for
free once `mistral` is a recognised access point.

### 4.2 The access-point modal

Reuses the existing provider modal (`:2183`). Fields:

| Field               | Stored as                        | Notes                                                                                                                |
| ------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **API key**         | vault `<tenant>:mistral:api_key` | Masked after save. Blank on re-open means "keep existing", per `common.apiKey` help text.                            |
| **Base URL**        | `provider_access.base_url`       | Defaults to `https://api.mistral.ai/v1`. Editable for EU/self-hosted endpoints and for Azure/Bedrock-style gateways. |
| **Test connection** | —                                | `GET {baseUrl}/models` with the key. Cheapest authenticated call; proves key + reachability without spending a page. |

Add `PROVIDER_WEBSITES.mistral = { href: "https://console.mistral.ai/api-keys", label: "console.mistral.ai" }` so the modal links out the way the others do.

### 4.3 Health surface

`providerEnvStatus()` in `apps/web/src/lib/env.ts:78` hardcodes
`mistral: false`. Once the key can live in the vault this should report vault
presence like the pooled providers do, so the _set / missing_ pill is truthful.

### 4.4 The connection test: fix the fallthrough, not just Mistral

`apps/web/src/app/api/provider-access/test/route.ts:56-71` dispatches like this:

```ts
if (parsed.provider === "openai")            return testOpenAi(...);
if (parsed.provider === "ollama")            return testOllama(...);
if (isPooledOpenAiProvider(parsed.provider)) return testPooledOpenAiProvider(...);
return testSupabase(required.supabase, parsed);   // ← unconditional
```

**The defect is the default, not the missing Mistral case.** Supabase is not
handled by a branch; it is whatever is left over. So _any_ provider added to
`ProviderAccessPointSchema` from now on silently becomes a Supabase test. With
Mistral that means `testSupabase` reads `<tenant>:supabase:service_role_key`
from the vault, finds nothing (the operator just typed a Mistral key), and
returns `supabase_connection_required` — an error naming the wrong product.

Fix the shape, then add the provider:

```ts
if (parsed.provider === "openai") return testOpenAi(required.supabase, parsed);
if (parsed.provider === "ollama") return testOllama(required.supabase, parsed);
if (isPooledOpenAiProvider(parsed.provider))
  return testPooledOpenAiProvider(required.supabase, {
    ...parsed,
    provider: parsed.provider,
  });
if (parsed.provider === "mistral")
  return testMistral(required.supabase, parsed);
if (parsed.provider === "supabase")
  return testSupabase(required.supabase, parsed);

return errorResponse(
  "provider_test_unsupported",
  `No connection test is implemented for ${parsed.provider}.`,
  400,
);
```

The explicit `supabase` branch plus a real default is the part worth doing
whether or not Mistral ships. It converts "the next provider someone adds
quietly misbehaves" into "the next provider someone adds gets a clear 400".

### 4.5 `testMistral`

No new service or abstraction is needed. Mistral's API is OpenAI-shaped, so
this is `testOpenAi` with the URL and error codes changed — roughly 25 lines in
the same file, alongside the four tests already there:

```ts
async function testMistral(
  supabase: SupabaseClient,
  input: { tenantId: string; baseUrl?: string; apiKey?: string },
) {
  const access = await getAccessRow(supabase, input.tenantId, "mistral");
  const baseUrl =
    cleanBaseUrl(input.baseUrl) ||
    cleanBaseUrl(access?.base_url) ||
    "https://api.mistral.ai/v1";
  const apiKey =
    input.apiKey?.trim() ||
    (await getSecret(supabase, input.tenantId, "mistral", "api_key"));

  if (!apiKey) {
    return errorResponse(
      "mistral_api_key_required",
      "Mistral API key is required before testing the Mistral access point.",
      503,
    );
  }

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    return errorResponse(
      "mistral_test_failed",
      extractProviderError(payload) ?? response.statusText,
      response.status,
    );
  }

  // Proves the key works AND that this workspace can actually see an OCR
  // model — without spending a page. A valid key on a workspace with no OCR
  // entitlement would otherwise pass here and fail at the first ingest.
  const ocrModels = (payload?.data ?? [])
    .map((m: { id?: string }) => m.id ?? "")
    .filter((id: string) => id.startsWith("mistral-ocr"));

  return Response.json({
    ok: true,
    provider: "mistral",
    ocrModelsAvailable: ocrModels,
    warning: ocrModels.length
      ? null
      : "The key works, but no mistral-ocr-* model is visible to this workspace. Check the plan or entitlements before selecting Mistral OCR.",
    latencyMs: Date.now() - startedAt,
  });
}
```

Two notes on this.

**`GET /v1/models` is the right probe.** It is free, fast, and needs no
document — unlike `testPooledOpenAiProvider`, which sends a real chat
completion. Sending a chat completion to validate an OCR credential would burn
tokens and would fail outright on a key scoped only to OCR. Verify the exact
models-endpoint shape against the live API when implementing: Mistral is
OpenAI-compatible and `GET /v1/models` with a Bearer token is the documented
"List Available Models" call, but the response field names are worth confirming
before relying on `payload.data[].id`.

**Do not take the shortcut of adding `mistral` to
`POOLED_OPENAI_PROVIDER_CONFIG`.** It is tempting — one config entry and
`isPooledOpenAiProvider` would route Mistral to the existing pooled test for
free. But `POOLED_OPENAI_PROVIDER_CONFIG`
(`apps/web/src/lib/openai-compatible-providers.ts`) is not a test-routing
table; it is the definition of _which providers have multi-key pools_. Adding
Mistral there would pull it into `getProviderApiKeyPool`, per-key parallel-call
capacity, lease acquisition, and the pooled-key UI — a large behavioural change
nothing in this design asked for, and it would route the test through a chat
completion. One dedicated 25-line function is the smaller, more honest change.

---

## 5. Configuration Page — PDF Parse Settings

### 5.1 The third option

`PDF_PARSE_STRATEGY_OPTIONS` (`configuration/page.tsx:456`) gains:

```ts
{
  value: "mistral_ocr",
  label: "Mistral OCR",
  description:
    "Send the whole PDF to Mistral Document AI in one call, take the per-page " +
    "Markdown it returns, and chunk it. Fastest option and the only one billed " +
    "per page by an external service.",
}
```

`withPdfParseStrategy()` (`:6018`) gains a `mistral_ocr` branch that sets
`provider: "mistral"`, `model: <configured OCR model>`, and forces
`toolsEnabled: false`.

> **It must NOT clear `pdfModelRoutes`.** The `poppler` branch discards route
> state, and copying that shape here would be the single easiest way to break
> the fallback: switching to Mistral OCR would silently delete the vision
> routes the fallback depends on, and the operator would only discover it when
> a Mistral failure had nowhere to fall back to. Preserve the array.

### 5.2 Conditional rendering

Three existing blocks are gated on `=== "vision_page_groups"` and must stay
that way (they are meaningless for Mistral):

| Line    | Block                                                              | Under Mistral OCR                                                        |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `:3025` | Include Poppler text toggle                                        | hidden                                                                   |
| `:3055` | PDF model call list (round-robin route builder)                    | **shown when _Fall back to direct vision_ is checked**, hidden otherwise |
| `:3642` | Direct-vision runtime settings (DPI, render concurrency, adaptive) | **shown when _Fall back to direct vision_ is checked**, hidden otherwise |

The gating condition for the last two changes from

```ts
normalizePdfParseStrategy(taskDraft.pdfParseStrategy) === "vision_page_groups";
```

to a small helper:

```ts
function showsVisionRouteControls(draft: ModelTask) {
  const strategy = normalizePdfParseStrategy(draft.pdfParseStrategy);
  return (
    strategy === "vision_page_groups" ||
    (strategy === "mistral_ocr" && draft.mistralOcrFallbackToVision === true)
  );
}
```

This is what makes the fallback configurable in one place. Without it the
operator would have to switch to _Direct vision page groups_, build the routes,
switch back to _Mistral OCR_, and hope nothing cleared them — which is exactly
the workflow that invites the bug called out in §5.1.

One new block, gated on `=== "mistral_ocr"`, sits above the route builder.

### 5.3 The Mistral OCR settings block — every field explained

This is the block Jeff asked to have "well explained for what they do and where
they go and what influence they have". Each row below gives the UI label, the
`FIELD_HELP` key to add in `apps/web/src/lib/field-help.ts`, where the value is
stored, and where it lands in the API call.

#### Throughput

| Label                  | Help key                       | Stored                                 | Effect                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Parallel documents** | `pdf.mistralParallelDocuments` | `metadata.mistralOcrParallelDocuments` | How many _separate PDFs_ one worker replica processes at once. Does **not** split a document — Mistral handles a 1,000-page file in a single call. This is the demo-speed dial: 8 means eight uploads racing. Raise it until you see HTTP 429s from Mistral, then back off. Suggested range 1–32, default 4. |

> **Why there is no "pages per call".** The direct-vision path needs
> `pagesPerCall` because a vision model has a context window and each page is
> an image. Mistral OCR takes the document whole and bills per page regardless
> of how it is sliced, so splitting would add requests, add latency, and lose
> cross-page table continuation for no benefit.

#### Model and output shape

| Label                          | Help key                   | Stored                             | Effect                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OCR model**                  | `pdf.mistralModel`         | `task.model`                       | Which OCR generation runs. **Default `mistral-ocr-latest`**, so improvements arrive without a config change. Every document records the version the alias actually resolved to (§3.5), so the engine behind any given document stays answerable. Pin a specific version (`mistral-ocr-4.1`, `mistral-ocr-2512`) if an installation needs a stable engine.                         |
| **Table format**               | `pdf.mistralTableFormat`   | `metadata.mistralOcrTableFormat`   | `markdown` \| `html`. Markdown chunks and embeds cleanly and is what `markdownLooksTableLike()` already detects to set `chunkType: "table"`. HTML survives merged cells and nested headers that Markdown pipe tables cannot express, at the cost of tag noise in the embedded text. **Default `markdown`.** Choose `html` only for corpora dominated by complex financial tables. |
| **Extract headers separately** | `pdf.mistralExtractHeader` | `metadata.mistralOcrExtractHeader` | When on, a running header ("ACME Annual Report — Confidential") is returned in `pages[].header` instead of inline in `pages[].markdown`. Turning this on removes repeated boilerplate from every chunk, which measurably improves retrieval on long uniform documents. **Default on.**                                                                                            |
| **Extract footers separately** | `pdf.mistralExtractFooter` | `metadata.mistralOcrExtractFooter` | Same for footers and page-number lines. **Default on** — page-number noise is worse than header noise because it differs per page and so defeats dedup.                                                                                                                                                                                                                           |

> **Stored, not embedded.** Extracted headers and footers are written to
> `document_pages.metadata` and never reattached to the Markdown that becomes
> chunks. Provenance is kept — you can still see what was on the page — while
> the embedded text stays free of per-page boilerplate. §6.3 step 7.

#### Images

| Label                           | Help key                   | Stored                                  | Effect                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Return figure images**        | `pdf.mistralIncludeImages` | `metadata.mistralOcrIncludeImageBase64` | Sets `include_image_base64`. Off, the Markdown still contains `![img-0.jpeg](img-0.jpeg)` references but the bytes are absent, so charts and photos are unrecoverable from the parse. On, each figure comes back as base64 and can be written to the `extracted-assets` bucket and linked into `document_assets`, matching what the Poppler path does today. Costs response size and worker memory. |
| **Maximum images per document** | `pdf.mistralImageLimit`    | `metadata.mistralOcrImageLimit`         | `image_limit`. A ceiling on extraction, applied by Mistral. Blank means no cap. Guards against a scanned document where every page decoration is detected as a figure.                                                                                                                                                                                                                              |
| **Minimum image size (px)**     | `pdf.mistralImageMinSize`  | `metadata.mistralOcrImageMinSize`       | `image_min_size`. Ignores images whose height or width is under this. The practical filter for logos, bullet glyphs, and horizontal rules. ~64 px is a reasonable starting value.                                                                                                                                                                                                                   |

#### Quality signals

| Label                 | Help key                   | Stored                                     | Effect                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | -------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Confidence scores** | `pdf.mistralConfidence`    | `metadata.mistralOcrConfidenceGranularity` | `none` \| `page` \| `block` \| `word`. `page` is nearly free and gives one number per page to store in `document_pages.ocr_confidence` — which is a real column already, currently written as a flat `1` by the vision path. That single number makes "which pages did the OCR struggle with" answerable. `word` inflates the response substantially. **Default `page`.** |
| **Paragraph blocks**  | `pdf.mistralIncludeBlocks` | `metadata.mistralOcrIncludeBlocks`         | `include_blocks`, default `true` at the API. Paragraph bounding boxes and structural labels. We do not consume them in v1; leaving it **off** shrinks responses. Turn on when block-aware chunking is built.                                                                                                                                                              |

#### Reliability

| Label                          | Help key                       | Stored                                 | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request timeout (ms)**       | `setting.mistralOcrTimeoutMs`  | runtime setting `mistralOcrTimeoutMs`  | Whole-document ceiling. A 1,000-page scan is a long single request; the direct-vision grouped default of 30 s is far too short. Suggest default 600,000 (10 min), bounds 30,000–1,800,000.                                                                                                                                                                                                                                                                                                                                                          |
| **Retries**                    | `setting.mistralOcrRetryCount` | runtime setting `mistralOcrRetryCount` | Retries on network failure, 429, and 5xx, with exponential backoff and `Retry-After` honoured. Note that a retry after a _partial_ success still bills the pages Mistral processed. Default 3, bounds 0–10.                                                                                                                                                                                                                                                                                                                                         |
| **Fall back to direct vision** | `pdf.mistralFallbackToVision`  | `metadata.mistralOcrFallbackToVision`  | When checked, a document that Mistral cannot parse — retries exhausted, timeout, over the configured application file-size guard, or over the spend cap — is re-run through the _Direct vision page groups_ pipeline instead of failing. Checking it reveals the PDF model call list below so the fallback routes can be built here. Ingestion keeps moving during a demo; the cost is a corpus where two documents may have been parsed by different engines, which is why every document records which one actually produced it. **Default off.** |

#### Cost and limits

| Label                                      | Help key                                      | Stored                                 | Effect                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Usage this period**                      | `pdf.mistralUsage`                            | read-only, from the ledger             | Live counter: pages processed and estimated spend for the current cap window, e.g. `12,430 pages · ~$49.72 of 50,000 page cap`. Read from `mistral_ocr_usage` (§6.8). This is the number that makes cost real before the invoice does.                                                                      |
| **Cap type**                               | `pdf.mistralCapType`                          | `metadata.mistralOcrCapType`           | `none` \| `pages` \| `usd`. What the cap counts. **Default `pages`** — exact, and it matches what Mistral bills, where dollars depend on the configured unit price staying current.                                                                                                                         |
| **Cap value**                              | `pdf.mistralCapValue`                         | `metadata.mistralOcrCapValue`          | The threshold. **Default 10,000 pages** (~$40/month at list price). A fresh installation is capped rather than open-ended; raise it deliberately.                                                                                                                                                           |
| **Cap window**                             | `pdf.mistralCapWindow`                        | `metadata.mistralOcrCapWindow`         | `calendar_month` \| `rolling_30_days` \| `all_time`. **Default `calendar_month`**, aligning to how Mistral invoices.                                                                                                                                                                                        |
| **On cap reached**                         | `pdf.mistralCapAction`                        | `metadata.mistralOcrCapAction`         | `fail` \| `fall_back_to_vision`. **Default `fail`**, since the fallback ships off. `fall_back_to_vision` requires the fallback checkbox and configured routes — it turns a budget ceiling into a graceful downgrade instead of a stopped queue.                                                             |
| **Application file limit (MB)**            | `pdf.mistralMaxFileSize`                      | `metadata.mistralOcrMaxFileSizeMb`     | A pre-upload worker-memory and cost guard. **Default 50 MB**, configurable up to Mistral's current 512 MB upload limit. This is an application limit, not a claim that Mistral rejects larger files.                                                                                                        |
| **Run large documents one at a time (MB)** | `pdf.mistralSerialThresholdMb`                | `metadata.mistralOcrSerialThresholdMb` | Any document at or above this size takes an exclusive worker slot instead of joining the parallel batch. Caps peak memory, and bounds how far the spend cap can overshoot — a 32-wide batch of 1,000-page documents is the worst case, and this is what prevents it. **Default 10 MB.** `0` disables. §6.9. |
| **Price per 1,000 pages**                  | `setting.mistralOcrPriceMillicentsPer1kPages` | runtime setting                        | Converts pages into the estimated dollars shown in the UI and written to the ledger. Stored as **thousandths of a cent**: `400000` = 400 cents = $4.00. Update when Mistral reprices, otherwise dollar figures drift while page counts stay right.                                                          |

#### Deliberately not exposed in v1

**Annotations — settled, not shipping.** `bbox_annotation_format` and
`document_annotation_format` invoke a vision LLM on top of OCR, move billing
from the $4 to the $5 tier, and need a user-authored JSON schema. This platform
already has a purpose-built Extraction subsystem for structured field capture,
and adding these would put two competing extraction paths in the product. No
settings, no code path.

**Batch API — settled, not shipping.** 50% cheaper but asynchronous, which is
the opposite of what a demo path needs. Synchronous only.

---

## 6. Worker Implementation

### 6.1 Config resolution

`getPdfParseConfig()` (`apps/worker/src/index.ts:7131`) currently returns
`{ strategy: "poppler" }` or `{ strategy, directVisionRoutes }`. Add a third
shape:

```ts
type PdfMistralOcrConfig = {
  baseUrl: string; // provider access, default https://api.mistral.ai/v1
  apiKey: string; // vault <tenant>:mistral:api_key
  model: string; // e.g. mistral-ocr-4.1
  parallelDocuments: number; // 1..32
  tableFormat: "markdown" | "html";
  extractHeader: boolean;
  extractFooter: boolean;
  includeImageBase64: boolean;
  imageLimit: number | null;
  imageMinSize: number | null;
  includeBlocks: boolean;
  confidenceGranularity: "none" | "page" | "block" | "word";
  timeoutMs: number;
  retryCount: number;
  fallbackToVision: boolean;
  capType: "none" | "pages" | "usd";
  capValue: number | null;
  capWindow: "calendar_month" | "rolling_30_days" | "all_time";
  capAction: "fail" | "fall_back_to_vision";
  serialThresholdBytes: number; // 0 disables
  priceMillicentsPer1kPages: number; // 400000 = $4.00
};

type PdfParseConfig =
  | { strategy: "poppler" }
  | {
      strategy: "vision_page_groups";
      directVisionRoutes: PdfDirectVisionConfig[];
    }
  | {
      strategy: "mistral_ocr";
      mistralOcr: PdfMistralOcrConfig;
      // Resolved eagerly when fallbackToVision is on, so a Mistral failure does
      // not then have to go back to the settings vault mid-failure. Empty array
      // when the fallback is off.
      directVisionRoutes: PdfDirectVisionConfig[];
    };
```

Resolving the vision routes **up front** rather than lazily matters: the
fallback runs at the moment something has already gone wrong, and a second
settings round-trip there is one more thing that can fail. Resolve both
configurations while the job is healthy, and if `fallbackToVision` is on but
route resolution fails, surface that as a configuration error before any
Mistral spend happens.

Throw a clear operator-facing error when the key is absent, in the style of the
existing messages:
`"Mistral OCR parsing requires a Mistral API key. Add it under Configuration → Access points → Mistral."`

### 6.2 New module: `apps/worker/src/mistral-ocr.ts`

Keeping this out of the 14,649-line `index.ts` matters both for review and
because it is the only part that is unit-testable without Supabase.

```ts
export type MistralOcrPage = {
  index: number; // 0-based, as returned
  markdown: string;
  header: string | null;
  footer: string | null;
  images: MistralOcrImage[];
  confidence: number | null;
};

export type MistralOcrResult = {
  pages: MistralOcrPage[];
  model: string;
  pagesProcessed: number;
  docSizeBytes: number | null;
};

/** POST multipart to /v1/files (purpose=ocr), then GET /v1/files/{id}/url. */
export async function uploadPdfForOcr(cfg, bytes, fileName): Promise<string>;

/** POST /v1/ocr with the signed URL; retries 429/5xx honouring Retry-After. */
export async function runMistralOcr(cfg, signedUrl): Promise<MistralOcrResult>;

/** Normalize + validate: 1-based page numbers, contiguity check, gap report. */
export function toPdfPageResults(result, totalPages): NormalizedOcrPage[];
```

`toPdfPageResults` is where the **0-based → 1-based** conversion happens, once,
with a test. `document_pages.page_number` has `check (page_number > 0)`, so an
off-by-one here fails loudly at insert — but only after paying for the OCR.

### 6.3 New ingest path: `completePdfMistralOcrIngest`

Modelled on `completePdfDirectVisionIngest` (`:4668`), same job stages so the
existing progress UI keeps working:

1. `stage: "extracting_text"`, `progress.pipeline = "pdf-mistral-ocr-v1"`.
2. `downloadSourceFileToPath(sourceFile, tempDir)` — unchanged.
3. `readPdfPageCount(pdfPath)` → `totalPages`; pre-flight §6.5.
4. `resetDocumentExtraction(job)` — unchanged.
5. `stage: "vision_running"` (reused so the existing UI labels it as model
   work), progress carries `pagesSubmitted` and the model name.
6. `uploadPdfForOcr` → `runMistralOcr`, wrapped in `withJobHeartbeat` so a
   ten-minute call does not look stalled and get reclaimed by
   `reclaimStaleJobs()`.
7. Build `PdfPageUpsertInput[]` and call `upsertPdfPages(job, upserts)` →
   `Map<pageNumber, pageId>`. Set `ocr_text` to the page Markdown and
   `ocr_confidence` to the real Mistral confidence when requested (this is the
   first time that column carries a meaningful value). `native_text` stays
   null — Poppler never runs.

   **Headers and footers go in `metadata`, not in the text:**

   ```jsonc
   {
     "mistral_header": "ACME Annual Report — Confidential",
     "mistral_footer": "Page 14 of 220",
     "mistral_header_footer_embedded": false,
   }
   ```

   `ocr_text` and the page Markdown built in step 8 must both exclude them.
   The explicit `false` flag is there so a future change of mind is auditable
   rather than silently changing what old and new documents contain.

8. Map to `PdfPageResult[]` via `buildPdfPageMarkdown({ …, nativeText: "",
visionText: pageMarkdown, usedPageRenderVision: false, tableLike:
markdownLooksTableLike(pageMarkdown), render: null })`.
9. `buildPdfDocumentMarkdown(...)` → `{ markdown, pageSpans }` — **unchanged
   function, no edits needed**.
10. `writeGeneratedFile(...)` with `parse_strategy: "mistral_ocr"` and the
    metadata in §6.5.
11. `insertDocumentChunksWithOptionalRunpod({ …, spans:
pdfPageSpansToDocumentSpans(pageSpans), provider: "mistral-ocr", model,
chunkingSource: "pdf_mistral_ocr_markdown", chunkingVersion:
"pdf-mistral-ocr-v1-markdown-offsets" })`.
12. Record the usage ledger row (§6.8).
13. Mark document + job complete, `notifyJobWebhook(job, "succeeded")`.

**Page-boundary tokens, as Jeff described them, are step 9 — and it already
works.** `buildPdfDocumentMarkdown` records `startOffset`/`endOffset` character
positions per page while concatenating, `pdfPageSpansToDocumentSpans` attaches
`pageId`, `chunkType`, and `sourceLabel: "Page N"`, and the chunker maps every
chunk back to the page whose span contains it. Because Mistral returns clean
per-page Markdown, these boundaries are _more_ reliable here than in either
existing path.

### 6.4 The fallback path

`completePdfIngest` becomes the place that owns the decision, not
`completePdfMistralOcrIngest` — a function should not be responsible for
invoking its own replacement:

```ts
if (pdfParseConfig.strategy === "mistral_ocr") {
  const { mistralOcr, directVisionRoutes } = pdfParseConfig;
  try {
    await completePdfMistralOcrIngest(
      job,
      sourceFile,
      documentContext,
      mistralOcr,
    );
    return;
  } catch (error) {
    if (!mistralOcr.fallbackToVision || directVisionRoutes.length === 0) {
      throw error; // fail loudly
    }
    if (!isFallbackEligible(error)) {
      throw error; // see the table below
    }
    console.warn(
      `[${workerId}] Mistral OCR failed for job ${job.id}; falling back to direct vision: ${formatErrorForLog(error)}`,
    );
    await recordParseFallback(job, error); // visible in job progress, not just logs
    await completePdfDirectVisionIngest(
      job,
      sourceFile,
      documentContext,
      directVisionRoutes,
    );
    return;
  }
}
```

**Which failures fall back, and which do not.** The distinction is between "the
service could not do this document" and "this installation is misconfigured".
Falling back on the second kind hides a problem the operator needs to see, and
does it while quietly costing more per document.

| Failure                                             | Falls back? | Why                                                                                                                                             |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Retries exhausted on 429                            | **yes**     | Rate limit is transient and load-dependent; the document is fine.                                                                               |
| 5xx / network failure                               | **yes**     | Mistral-side.                                                                                                                                   |
| Timeout                                             | **yes**     | Document too slow for the configured ceiling.                                                                                                   |
| File over the configured application guard          | **yes**     | Protects worker memory and cost. The guard defaults to 50 MB and can be raised as high as Mistral's current 512 MB provider limit.              |
| Spend cap reached, `capAction: fall_back_to_vision` | **yes**     | The entire point of that setting.                                                                                                               |
| Spend cap reached, `capAction: fail`                | no          | Operator asked for a hard stop.                                                                                                                 |
| Missing or rejected API key (401/403)               | **no**      | Configuration error. Falling back would mean every document silently costs vision-model time while the Mistral row still shows _set_ in the UI. |
| Malformed response Mistral did accept and bill      | **no**      | Already paid for. Ingest what came back, flag the gap (§9), do not pay twice.                                                                   |

**No re-entry.** `completePdfDirectVisionIngest` calls `resetDocumentExtraction`
itself, so partial Mistral page writes are cleared before the vision run
starts. The vision path must not fall back to anything — if it fails, the job
fails. One hop only.

**Attribution is mandatory.** Every document must record which engine produced
it, in both the generated-file metadata and `document_pages.metadata`:

```jsonc
{
  "parse_strategy": "mistral_ocr",
  "parse_engine_used": "vision_page_groups",
  "parse_fallback_reason": "http_413_file_too_large",
  "parse_fallback_at": "2026-08-19T14:02:11Z",
}
```

Without this a mixed corpus is unauditable, and "why is this document's
extraction worse than that one's" becomes unanswerable.

### 6.5 Telemetry to persist

Into the generated-file metadata and job progress, alongside the existing keys:

```jsonc
{
  "parse_strategy": "mistral_ocr",
  "mistral_pages_processed": 42, // usage_info.pages_processed — the billed quantity
  "mistral_doc_size_bytes": 1048576,
  "mistral_parallel_documents": 4,
  "mistral_table_format": "markdown",
  "mistral_extract_header": true,
  "mistral_extract_footer": true,
  "mistral_confidence_granularity": "page",
  "mistral_request_ms": 18342,
  "mistral_retry_count": 0,
  "mistral_ocr_model_requested": "mistral-ocr-latest",
  "mistral_ocr_model_resolved": "mistral-ocr-4.1", // response.model — survives alias rolls
  "mistral_price_millicents_per_1k_pages": 400000,
  "mistral_estimated_cost_usd": 0.168, // pages_processed / 1000 * configured rate
  "mistral_fallback_enabled": true,
  "parse_engine_used": "mistral_ocr", // or "vision_page_groups" after a fallback
}
```

`mistral_pages_processed` is the audit trail for an externally billed service.
Without it there is no way to reconcile a Mistral invoice against documents
ingested.

### 6.6 Pre-flight guards

Run **before** upload, since both failures are cheap to detect and expensive to
discover late:

| Check      | Threshold                    | Action                                                                                                                                                       |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File size  | > configured `maxFileSizeMb` | Fail before upload, identify the application safety guard, and offer raising the setting or using Direct vision/Poppler. Default 50 MB; maximum 512 MB.      |
| Page count | > `pdfMaxPages` (max 1,000)  | Existing `processedPages = Math.min(totalPages, pdfMaxPages)` clamp applies; pass `pages: "0-{processedPages-1}"` so we are not billed for pages we discard. |

### 6.7 Parallel documents

Two edits in `main()` (`apps/worker/src/index.ts:1036`; the concurrency call is `:1106`, the function is `:10269`):

```ts
// getRunpodDocumentConcurrency → getDocumentConcurrency
async function getDocumentConcurrency(job: Job) {
  if (job.job_type === "ingest" || job.job_type === "reprocess") {
    const cfg = await getPdfParseConfig(job.tenant_id);
    if (cfg.strategy === "mistral_ocr") {
      return Math.max(1, Math.min(32, cfg.mistralOcr.parallelDocuments));
    }
    return 1;
  }
  // …existing RunPod rechunk/embed branch, unchanged
}
```

and widen the claim filter so the batch pulls the right job types:

```ts
claimNext: () => claimNextJob({
  tenantId: claimed.job.tenant_id,
  jobTypes: mistralBatch ? ["ingest", "reprocess"] : ["rechunk", "embed"],
  expectedSettingsRevision: claimed.snapshot.revision,
}),
```

Three properties this inherits for free, all of which matter:

- **`expectedSettingsRevision`** means a settings edit mid-batch stops further
  claims rather than mixing configurations across documents.
- **`tenantId` pinning** means one tenant's burst cannot starve another's under
  the same batch.
- Each concurrent document still gets its own `tempDir`, its own heartbeat, and
  its own failure path. `runAcceleratedJobBatch` has no shared mutable state.

**Settled: per-replica, documented, operator divides.** Two Railway worker
replicas at `parallelDocuments: 8` run up to 16 concurrent Mistral calls, and
Mistral rate-limits per workspace, not per replica. No automatic division and
no global token bucket in v1. The obligations that come with that choice:

- The `pdf.mistralParallelDocuments` help text must say **"per worker replica —
  divide your workspace rate limit by your replica count"** in those words. A
  setting whose real effect depends on an invisible multiplier is only
  defensible if the multiplier is stated where the setting is edited.
- The Mistral settings block should display the current worker replica count
  beside the field if it can be read cheaply, so the operator is not doing the
  multiplication from memory.
- 429 handling (§9) must name _Parallel documents_ as the dial, since that is
  the failure this choice makes most likely.

### 6.8 Cost ledger, running counter, and spend cap

Three pieces, in dependency order.

**1. The ledger.** One append-only row per Mistral OCR call, written in step 12
of §6.3 immediately after a successful response — before chunking, so a later
chunking failure cannot lose a record of money already spent:

```sql
create table mistral_ocr_usage (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  document_id           uuid references documents(id) on delete set null,
  processing_job_id     uuid references processing_jobs(id) on delete set null,
  model                 text not null,
  pages_processed       integer not null check (pages_processed >= 0),
  doc_size_bytes        bigint,
  price_per_1k_pages_usd numeric(10,4) not null,
  estimated_cost_usd    numeric(12,4) not null,
  created_at            timestamptz not null default now()
);
create index on mistral_ocr_usage (tenant_id, created_at desc);
```

`document_id` is `on delete set null`, not `cascade`: deleting a document must
not erase the record that it cost money. The ledger is a financial trail, not
document metadata.

**2. The running counter.** A window aggregate the Configuration page reads:

```sql
select coalesce(sum(pages_processed), 0) as pages,
       coalesce(sum(estimated_cost_usd), 0) as usd
from mistral_ocr_usage
where tenant_id = $1 and created_at >= $2;   -- window start
```

Surfaced through a small `GET /api/mistral-ocr-usage` route and rendered in the
_Usage this period_ row of §5.3.

**3. The cap.** Checked in `getPdfParseConfig` — or immediately before upload —
and enforced per document:

```ts
if (cfg.capType !== "none") {
  const used = await getMistralOcrUsage(tenantId, windowStart(cfg.capWindow));
  const current = cfg.capType === "pages" ? used.pages : used.usd;
  if (cfg.capValue !== null && current >= cfg.capValue) {
    throw new MistralOcrCapReachedError(current, cfg.capValue, cfg.capType);
  }
}
```

`MistralOcrCapReachedError` is a distinct error type precisely so §6.4's
`isFallbackEligible` can route it by `capAction` rather than pattern-matching a
message string.

> **The cap is a soft ceiling, and the UI must say so.** With
> `parallelDocuments` up to 32, concurrent jobs can each pass the check before
> any of them writes a ledger row. Exact enforcement needs a reservation row
> taken before upload and reconciled after, which strands reservations when a
> worker dies. **The overshoot is bounded instead of eliminated — see §6.9,
> which is what makes the bound small enough to live with.** Do not describe
> the cap in the UI as a hard limit.

### 6.9 Large documents run one at a time

The worst case for both peak memory and cap overshoot is the same scenario:
`parallelDocuments` large documents in flight simultaneously. Thirty-two
1,000-page PDFs would overshoot a cap by ~~32,000 pages (~~$128) and hold ~1.6 GB
of PDF bytes in one worker. Rather than build reservations to fix the cap and
a separate memory guard, one rule fixes both.

**Any document at or above `serialThresholdBytes` takes an exclusive worker
slot.** Small documents keep running `parallelDocuments`-wide; a large one runs
alone.

A promise-chain mutex is the whole implementation — no table, no lease, no
cleanup path:

```ts
let largeDocumentChain: Promise<unknown> = Promise.resolve();

function runSerialized<T>(work: () => Promise<T>): Promise<T> {
  const result = largeDocumentChain.then(work, work);
  // Keep the chain alive regardless of outcome; never let a rejection poison it.
  largeDocumentChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const bytes = sourceFile.size_bytes ?? 0;
const oversized =
  cfg.serialThresholdBytes > 0 && bytes >= cfg.serialThresholdBytes;

return oversized
  ? runSerialized(() => runMistralOcrForDocument())
  : runMistralOcrForDocument();
```

Two properties worth being explicit about:

- **The gate wraps only the OCR call**, not download, chunking, or embedding.
  Holding the slot across the whole job would serialize far more than intended
  and waste the parallelism on the cheap stages.
- **The chain must survive a rejection.** `result.then(noop, noop)` rather than
  assigning `result` directly — otherwise one failed large document leaves a
  rejected promise as the chain head and every subsequent large document
  inherits the failure.

**What this does to the overshoot bound.** At the default 10 MB threshold, a
document big enough to be expensive is also big enough to be serialized, so the
worst case becomes roughly `parallelDocuments × pages_in_a_sub-threshold_document`
— a 10 MB PDF is typically a few hundred pages at most, and in practice far
fewer. That turns a ~$128 worst case into single-digit dollars, which is a
soft cap you can actually set close to a real budget.

**Size in MB is the operator-facing control, but pages are what get billed.**
The two correlate loosely — a 3 MB text PDF can be 800 pages while a 40 MB
scan is 20. Since `readPdfPageCount` already runs before the OCR call (§6.3
step 3), a page-count threshold is available at no extra cost and would track
the actual risk better. **Recommendation: gate on MB as specified, and log the
page count of every serialized document** so that after a few weeks of real
use there is data to decide whether to switch the threshold to pages.

---

## 7. Data Model Changes

### 7.1 `packages/rag-core/src/index.ts`

```ts
export const PDF_PARSE_STRATEGIES = [
  "poppler",
  "vision_page_groups",
  "mistral_ocr",
] as const;

export const PROVIDER_ACCESS_POINTS = [
  "ollama",
  "openai",
  "modular",
  "together",
  "openrouter",
  "supabase",
  "mistral",
] as const;

export const MISTRAL_OCR_TABLE_FORMATS = ["markdown", "html"] as const;
export const MISTRAL_OCR_CONFIDENCE_GRANULARITIES = [
  "none",
  "page",
  "block",
  "word",
] as const;
export const MAX_MISTRAL_OCR_PARALLEL_DOCUMENTS = 32;

export const MistralOcrSettingsSchema = z.object({
  model: z.string().trim().min(1).max(180).default("mistral-ocr-4.1"),
  parallelDocuments: z
    .number()
    .int()
    .min(1)
    .max(MAX_MISTRAL_OCR_PARALLEL_DOCUMENTS)
    .default(4),
  tableFormat: z.enum(MISTRAL_OCR_TABLE_FORMATS).default("markdown"),
  extractHeader: z.boolean().default(true),
  extractFooter: z.boolean().default(true),
  includeImageBase64: z.boolean().default(false),
  imageLimit: z.number().int().min(1).max(10000).nullable().default(null),
  imageMinSize: z.number().int().min(1).max(10000).nullable().default(null),
  includeBlocks: z.boolean().default(false),
  confidenceGranularity: z
    .enum(MISTRAL_OCR_CONFIDENCE_GRANULARITIES)
    .default("page"),
  fallbackToVision: z.boolean().default(false),
  capType: z.enum(["none", "pages", "usd"]).default("pages"),
  capValue: z.number().min(0).max(100_000_000).nullable().default(10_000),
  capWindow: z
    .enum(["calendar_month", "rolling_30_days", "all_time"])
    .default("calendar_month"),
  capAction: z.enum(["fail", "fall_back_to_vision"]).default("fail"),
  maxFileSizeMb: z.number().int().min(1).max(512).default(50),
  serialThresholdMb: z.number().int().min(0).max(512).default(10),
});
```

`model` defaults to `mistral-ocr-latest`. The application file guard defaults
to 50 MB to protect Railway worker memory but can be raised to Mistral's
current 512 MB provider limit. A non-zero serialization threshold cannot exceed
the application guard.

Two cross-field rules, enforced in `.superRefine` the way
`RagSettingsSchema` already validates `chunkOverlapTokens < chunkMaxTokens`:

- `capType !== "none"` requires a non-null `capValue`.
- `capAction === "fall_back_to_vision"` requires `fallbackToVision === true`.

And in `apps/web/src/app/api/model-tasks/route.ts`, a 422 mirroring the
existing `pdf_model_route_required` check — because these are the two states
that would otherwise fail silently at ingest time, hours later:

```ts
if (
  nextMetadata.pdfParseStrategy === "mistral_ocr" &&
  nextMetadata.mistralOcrFallbackToVision === true &&
  (nextMetadata.pdfModelRoutes as unknown[]).length === 0
) {
  return errorResponse(
    "pdf_model_route_required",
    "Fallback to direct vision needs at least one provider and model route. Add one, or turn the fallback off.",
    422,
  );
}
```

Plus two runtime settings in `PlatformRuntimeSettingsSchema`,
`RUNTIME_SETTING_FIELDS`, and `RUNTIME_SETTING_ENV_NAMES`:

| Key                                   | Bounds             | Default | Env name                                    |
| ------------------------------------- | ------------------ | ------- | ------------------------------------------- |
| `mistralOcrTimeoutMs`                 | 30,000 – 1,800,000 | 600,000 | `MISTRAL_OCR_TIMEOUT_MS`                    |
| `mistralOcrRetryCount`                | 0 – 10             | 3       | `MISTRAL_OCR_RETRY_COUNT`                   |
| `mistralOcrPriceMillicentsPer1kPages` | 0 – 100,000,000    | 400,000 | `MISTRAL_OCR_PRICE_MILLICENTS_PER_1K_PAGES` |

**The price is stored as thousandths of a cent, as an integer.**
`RUNTIME_SETTING_FIELDS` entries are all `{ type: "integer", minimum, maximum }`
and `parsePdfParseRuntimeDraft` validates with `Number.isInteger`, so a decimal
setting would mean extending that whole path for one field. Millicents avoids
it entirely and keeps more precision than cents would:

```text
stored 400000  →  ÷1000 = 400 cents  →  ÷100 = $4.00 per 1,000 pages
```

```ts
// pages × millicents ÷ 1e8  →  USD.  1000 × 400000 / 1e8 = 4.00 ✓
const estimatedCostUsd =
  (pagesProcessed * priceMillicentsPer1kPages) / 100_000_000;
```

The UI shows and accepts dollars; only storage is integer. Round to 4 decimal
places when writing `estimated_cost_usd`, matching the `numeric(12,4)` column.

### 7.2 Supabase migration

One migration, `supabase/migrations/2026XXXX000100_mistral_ocr_parse_strategy.sql`,
following the shape of `20260726000100_pdf_parse_strategy_config.sql`:

```sql
update model_task_configs
set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
  'mistralOcrModel',                 coalesce(metadata ->> 'mistralOcrModel', 'mistral-ocr-4.1'),
  'mistralOcrParallelDocuments',     coalesce((metadata ->> 'mistralOcrParallelDocuments')::int, 4),
  'mistralOcrTableFormat',           coalesce(metadata ->> 'mistralOcrTableFormat', 'markdown'),
  'mistralOcrExtractHeader',         coalesce((metadata -> 'mistralOcrExtractHeader')::boolean, true),
  'mistralOcrExtractFooter',         coalesce((metadata -> 'mistralOcrExtractFooter')::boolean, true),
  'mistralOcrIncludeImageBase64',    coalesce((metadata -> 'mistralOcrIncludeImageBase64')::boolean, false),
  'mistralOcrIncludeBlocks',         coalesce((metadata -> 'mistralOcrIncludeBlocks')::boolean, false),
  'mistralOcrConfidenceGranularity', coalesce(metadata ->> 'mistralOcrConfidenceGranularity', 'page')
)
where task_key = 'pdf_assembly';
```

**Drop `provider_access_configs_provider_check` rather than widening it.**
Adding `mistral` to `PROVIDER_ACCESS_POINTS` widens
`ProviderAccessPointSchema`, which is the `provider` field of
`ProviderAccessConfigRequestSchema` (`rag-core:1348`). The matching table
constraint (`20260815000900_together_openrouter_providers.sql:5-19`) allows
only `('ollama','openai','modular','together','openrouter','supabase')`.

I flagged this more urgently than it deserved in conversation. The accurate
picture: **`provider_access_configs` is legacy and effectively read-only.**

| Where                                                                            | What it does                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `apps/web/src/app/api/provider-access/route.ts`                                  | Writes to the **vault**, not this table               |
| `apps/web/src/lib/legacy-settings-import.ts:69`                                  | One-time read, imports old rows into the vault        |
| `apps/maintenance/src/restore-run.ts:213`                                        | `select count(*)` to warn that keys were not restored |
| `apps/maintenance/src/migrations.ts:596`                                         | `delete from` during restore                          |
| `packages/rag-core/src/index.ts:3169`, `platform/supabase-resources.v1.json:101` | Backup / contract table lists                         |

Nothing inserts a provider value, so the constraint cannot currently be
violated — and it has now been widened twice (modular, then
together/openrouter) purely to keep a dormant guard in step with an enum it no
longer guards anything about.

**Decision: drop it. `ProviderAccessPointSchema` becomes the single source of
truth**, which it already is in practice — the vault is the live store and zod
validates every write to it. Every future provider then costs one array entry
instead of a migration, a checksum regeneration, and a migration-head bump.

```sql
-- The vault is the store of record for provider access, and
-- ProviderAccessPointSchema validates every write to it. This check has been
-- widened twice to track an enum it no longer meaningfully constrains; the
-- table itself is read-only legacy. Drop the constraint, keep the table.
alter table public.provider_access_configs
  drop constraint if exists provider_access_configs_provider_check;
```

**The table stays.** Only the constraint goes. The eleven legacy settings
tables still back the _Import legacy settings_ button in
`SettingsBackupPanel.tsx:81` → `/api/settings-import` →
`legacy-settings-import.ts`, and they are still listed in the backup manifest
and the platform resource contract. Decommissioning them is a separate piece of
work with its own blast radius; nothing here depends on it.

`model_task_configs_provider_check` (same migration, `:25`) **already includes
`'mistral'`** — verified, no change needed there. Then run
`pnpm platform:checksums` — `platform/migration-checksums.v1.json` is verified
in CI and a new migration without a checksum update fails the build.

`RAG_RAILWAY_EXPECTED_MIGRATION_HEAD` (`rag-core:8`) must be bumped to the new
migration name, or every worker will refuse to claim jobs with
`upgrade_required`.

The same migration creates `mistral_ocr_usage` (§6.8) with the tenant-scoped RLS
policy the other tenant tables use.

**No other new tables.** `document_pages`, `document_chunks`, `document_assets`,
and the generated-files machinery all take Mistral output as-is — including
after a fallback, since the vision path already writes them.

---

## 8. File-by-File Change List

| File                                                                | Change                                                                                                                                                                                                                                                         | Size  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `packages/rag-core/src/index.ts`                                    | `PDF_PARSE_STRATEGIES`, `PROVIDER_ACCESS_POINTS`, `MistralOcrSettingsSchema`, 2 runtime settings, bump `RAG_RAILWAY_EXPECTED_MIGRATION_HEAD`                                                                                                                   | M     |
| `packages/rag-core/src/index.test.ts`                               | Schema defaults + bounds                                                                                                                                                                                                                                       | S     |
| `supabase/migrations/2026XXXX000100_mistral_ocr_parse_strategy.sql` | New: `pdf_assembly` metadata defaults, `mistral_ocr_usage` table, **drop** `provider_access_configs_provider_check`                                                                                                                                            | M     |
| `platform/migration-checksums.v1.json`                              | Regenerate via `pnpm platform:checksums`                                                                                                                                                                                                                       | S     |
| `apps/web/src/app/configuration/page.tsx`                           | `PROVIDER_ACCESS_ORDER` + `PROVIDER_WEBSITES`; local `PdfParseStrategy` union at `:258`; `PDF_PARSE_STRATEGY_OPTIONS`; `withPdfParseStrategy` (preserve routes); new settings block; usage counter; `showsVisionRouteControls` gating                          | **L** |
| `apps/web/src/app/api/provider-access/route.ts`                     | Add `mistral` to local `PROVIDERS` (`:34`) and `ProviderAccessRow` union                                                                                                                                                                                       | S     |
| `apps/web/src/app/api/provider-access/test/route.ts`                | Close the `testSupabase` fallthrough (§4.4) + add `testMistral` (§4.5)                                                                                                                                                                                         | S     |
| `apps/web/src/app/api/model-tasks/route.ts`                         | `mistral_ocr` branch in the `pdf_assembly` normaliser (`:117`); skip the route-required 422                                                                                                                                                                    | M     |
| `apps/web/src/lib/field-help.ts`                                    | ~12 new `pdf.mistral*` / `setting.mistralOcr*` entries                                                                                                                                                                                                         | M     |
| `apps/web/src/lib/env.ts`                                           | `providerEnvStatus().mistral` from vault, not `false`                                                                                                                                                                                                          | S     |
| `apps/web/src/lib/pdf-parse-runtime-settings.ts`                    | Add the 2 runtime keys                                                                                                                                                                                                                                         | S     |
| `apps/web/src/lib/job-progress.ts`                                  | Recognise `pdf-mistral-ocr-v1` (`:143`)                                                                                                                                                                                                                        | S     |
| `apps/web/src/app/api/mistral-ocr-usage/route.ts`                   | **New.** Window aggregate for the running counter                                                                                                                                                                                                              | S     |
| **`apps/worker/src/mistral-ocr.ts`**                                | **New.** Upload, OCR call, retry, normalise                                                                                                                                                                                                                    | **L** |
| **`apps/worker/src/mistral-ocr.test.ts`**                           | **New.** Fixture-driven, no network                                                                                                                                                                                                                            | M     |
| `apps/worker/src/index.ts`                                          | `PdfParseStrategy` union (`:260`); `getPdfParseConfig` branch (`:7131`); `completePdfIngest` dispatch + fallback (`:3096`); `completePdfMistralOcrIngest`; cap check + ledger write; `getDocumentConcurrency` + claim filter (`:1106`, definition at `:10269`) | **L** |
| `docs/`                                                             | Operator guide + `docs/README.md` index row                                                                                                                                                                                                                    | M     |
| `docs/open-questions.md`                                            | Record whatever §11 resolves to                                                                                                                                                                                                                                | S     |

---

## 9. Failure Handling

| Failure                              | Response                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing API key                      | Fail at config resolution, before download. Message names the exact UI path.                                                                                               |
| File > configured application guard  | Fail pre-flight, name the size, explain that the guard is local, and name the available alternatives.                                                                      |
| HTTP 429                             | Retry with backoff, honour `Retry-After`. After `mistralOcrRetryCount`, fail the job with a message that names _Parallel documents_ as the dial to turn down.              |
| HTTP 5xx / network                   | Retry with backoff.                                                                                                                                                        |
| Timeout                              | Fail with elapsed ms and the configured ceiling in the message.                                                                                                            |
| Fewer pages returned than expected   | Warn, record the gap in metadata, ingest what came back. A 40-of-42-page parse is more useful than nothing, but the shortfall must be visible in the UI, not just the log. |
| Malformed / empty Markdown on a page | Insert the page with empty Markdown and flag it in `document_pages.metadata`. Do not fail the document.                                                                    |
| Spend cap reached                    | Route by `capAction` — `fail`, or fall back to vision.                                                                                                                     |

Every row above is then filtered through §6.4: if _Fall back to direct vision_
is on and routes exist, an eligible failure re-runs on vision instead of
failing. The two rules that hold regardless:

- **Configuration errors never fall back.** A missing or rejected API key fails
  loudly, so a misconfigured Mistral access point cannot masquerade as working
  while every document quietly runs on vision models.
- **Every document records the engine that produced it.** `parse_engine_used`
  plus `parse_fallback_reason` (§6.4), in both the generated-file metadata and
  `document_pages.metadata`. A mixed corpus is acceptable; an unlabelled one is
  not.

---

## 10. Testing and Rollout

### 10.1 Tests

- `mistral-ocr.test.ts` against recorded response fixtures: 0→1 page-index
  conversion; header/footer handling; `table_format: html` passthrough;
  missing-page gap detection; 429-then-success retry; `Retry-After` honoured;
  timeout.
- `rag-core` schema tests: defaults, bounds, rejection of
  `parallelDocuments: 0` and `33`.
- A `buildPdfDocumentMarkdown` span test over synthetic Mistral pages proving
  offsets are contiguous and every span maps to exactly one page.
- Fallback tests: eligible failure with routes configured → vision runs and
  `parse_engine_used` is `vision_page_groups`; eligible failure with fallback
  **off** → job fails; 401 with fallback **on** → job still fails; vision
  failure after a fallback → job fails without re-entering Mistral.
- Cap tests: window boundary arithmetic for all three windows; `capAction:
fail` vs `fall_back_to_vision`; ledger row written before chunking so a
  chunking failure still leaves the spend recorded.
- A `withPdfParseStrategy` regression test asserting that switching to
  `mistral_ocr` **preserves** `pdfModelRoutes` (§5.1).
- A provider-test dispatch test: `provider: "mistral"` reaches `testMistral`,
  `provider: "supabase"` reaches `testSupabase`, and an unknown provider gets
  `provider_test_unsupported` rather than a Supabase error (§4.4).
- Manual: a 5-page text PDF, a 40-page scanned PDF, a table-heavy PDF, one
  document over the configured application guard exercising the fallback, and a batch of 10 documents at
  `parallelDocuments: 8`.

### 10.2 Deployment sequence

Per the project's shared-repo rule — sync, change, sync — and because Railway
auto-deploys from GitHub:

1. `git pull --rebase` on `main`; confirm clean.
2. Branch. Land `rag-core` + migration + checksums first so web and worker
   compile against the same schema.
3. Apply the migration to **staging** Supabase, redeploy staging, verify the
   Configuration page renders the Mistral access point and the third parse
   option.
4. Land web and worker changes.
5. `pnpm typecheck && pnpm lint && pnpm test && pnpm docs:check` before every
   push — `docs:check` runs `verify-platform-contract` and
   `verify-railway-template`, both of which fail on an unregistered setting.
6. Merge to `main`, let Railway deploy, apply the migration to production, and
   redeploy the worker **after** the migration lands — the readiness guard will
   otherwise park the worker in `upgrade_required`.
7. Push again so collaborators are not left behind.

### 10.3 Effort

Roughly 3–4 focused days: half a day on `mistral-ocr.ts` and its tests, a day
on the configuration page (it is 6,332 lines and the new block has to thread
through existing state, plus the usage counter), half a day on the worker
ingest path, half a day on the fallback and the cost ledger, and half a day on
migration, docs, and staging verification. The fallback and the spend cap add
roughly a day over the parse path alone — most of it in tests, which is where
that day belongs.

---

## 11. Decisions

### 11.1 Settled 2026-08-19

| #   | Question                                 | Decision                                                                                                                                                                                                       |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How the PDF reaches Mistral              | **Files API upload + signed URL.** Mistral never touches Supabase; no 67 MB JSON bodies. §3.3                                                                                                                  |
| D2  | Parallel documents across replicas       | **Per replica, documented, operator divides.** No auto-division, no global token bucket. Help text must state the per-replica caveat. §6.7                                                                     |
| D3  | Behaviour on failure                     | **Conditional fallback.** _Fall back to direct vision_ checked **and** routes configured → eligible failures re-run on the vision pipeline. Otherwise fail loudly. Config errors never fall back. §6.4         |
| D4  | Cost guardrails                          | **All three.** Per-document ledger, running per-tenant counter in the UI, configurable cap. §6.8                                                                                                               |
| D5  | Access point scope                       | **Full provider access point.** The key is a Studio-wide credential, so scoping it to OCR would misrepresent it — and it lets the existing `mistral` chat-model option stop depending on `MISTRAL_API_KEY`. §4 |
| D6  | Headers and footers                      | **Extract, store, do not embed.** Written to `document_pages.metadata`; excluded from `ocr_text` and from the Markdown that becomes chunks. §6.3 step 7                                                        |
| D7  | Annotations                              | **Not shipping.** Overlaps the existing Extraction subsystem and moves billing to the $5 tier. §5.3                                                                                                            |
| D8  | Batch API                                | **Not shipping.** Mistral OCR here is a demo-speed path; async batching is the opposite of that. §3.7                                                                                                          |
| D9  | Cap overshoot                            | **Bound it rather than eliminate it.** Documents ≥10 MB take an exclusive worker slot, which shrinks the worst case from ~$128 to single-digit dollars without reservations or their cleanup path. §6.9        |
| D10 | Default cap                              | **10,000 pages per calendar month** (~$40), `capAction: fail`. Fresh installations are capped, not open-ended. §5.3                                                                                            |
| D11 | Default model                            | **`mistral-ocr-latest`.** Every document records the version the alias resolved to, so the engine behind any document stays answerable after a roll. §3.5                                                      |
| D12 | Price storage                            | **Thousandths of a cent, as an integer.** `400000` = $4.00 per 1,000 pages. Avoids introducing the first non-integer runtime setting. §7.1                                                                     |
| D13 | `provider_access_configs_provider_check` | **Drop it.** `ProviderAccessPointSchema` becomes the single source of truth it already is in practice. The table stays; only the constraint goes. §7.2                                                         |

### 11.2 Deliberately out of scope

Neither of these blocks the work above. Both are recorded so they are not
rediscovered as surprises.

**Decommissioning the legacy settings tables.** D13 drops one constraint, not
the table. Eleven legacy tables — `provider_access_configs`, `model_config`,
`model_task_configs`, `rag_settings`, `platform_runtime_settings`,
`storage_access_configs`, `runpod_embedding_settings`,
`context_management_configs`, `admin_users`, `api_keys`, `api_test_users` —
still back the _Import legacy settings_ button
(`SettingsBackupPanel.tsx:81` → `/api/settings-import` →
`legacy-settings-import.ts`), and are still listed in the backup manifest
(`rag-core:3169`) and the platform resource contract
(`platform/supabase-resources.v1.json`). Removing them means retiring that
import path, updating both manifests, and confirming no installation still
needs the one-time migration. Separate project.

**Threshold in pages rather than megabytes.** §6.9 gates serialization on file
size because that is what was specified and what is knowable without work. Page
count is the better proxy for cost and is already available from
`readPdfPageCount` before the OCR call. The plan logs the page count of every
serialized document so the switch can be made on evidence rather than
speculation.

---

## 12. Sources

- [Mistral Document AI — Basic OCR](https://docs.mistral.ai/capabilities/OCR/basic_ocr/)
- [Mistral OCR API reference](https://docs.mistral.ai/api/endpoint/ocr)
- [Mistral Document AI — Annotations](https://docs.mistral.ai/capabilities/OCR/annotations/)
- [Mistral models overview](https://docs.mistral.ai/getting-started/models/models_overview/)
- [Mistral Batch Processing](https://docs.mistral.ai/studio/batch-processing)
- [OCR at scale via Mistral's Batch API (cookbook)](https://docs.mistral.ai/resources/cookbooks/mistral-ocr-batch_ocr)
- [Mistral API pricing](https://mistral.ai/pricing/api)
- [Mistral OCR 4 announcement](https://mistral.ai/news/ocr-4/)
- [Mistral known limitations — current 512 MB file-upload limit](https://docs.mistral.ai/resources/known-limitations)
- [Mistral La Plateforme tiers and rate limits](https://docs.mistral.ai/deployment/laplateforme/tier/)
