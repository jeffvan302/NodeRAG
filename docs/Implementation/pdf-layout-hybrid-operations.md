# Hybrid PDF extraction operations

Status: WSL/Docker testbed implementation complete; DSM certification deferred

## What the pipeline does

NodeRag uses `pdf-layout.v3-hybrid` for new PDF extraction. PDF.js first acquires positioned text,
then the deterministic `native-layout.v1` classifier reconstructs headings, lists, reading order,
simple tables, captions, and conservative fallbacks. The `pdf-confidence.v1` policy accepts reliable
blocks, sends only uncertain bounded regions to vision, and reserves full-page vision for scans or
unreadable text maps.

All of this remains inside **1/3: ingesting to Markdown**. The operator still sees one workflow per
document, followed by **2/3: chunking** and **3/3: embedding**. Internal progress can say
`classifying-layout`, `analysing-pages`, or `reconciling-vision`; those are not additional document
jobs.

The frozen revisions are:

- PDF extraction: `pdf-layout.v3-hybrid`
- PDF parser: `pdfjs-dist@6.3.289`
- layout policy: `native-layout.v1`
- confidence policy: `pdf-confidence.v1`
- vision prompt: `vision-transcription.v3-layout`
- vision schema: `vision-result.v3-layout-blocks`
- preprocessing: `vision-preprocess.v1`
- crop policy: `pdf-crop.v1-margin-015`

## Reading diagnostics

Open **Knowledge Bases**, choose a knowledge base, select a PDF, and review **PDF extraction
diagnostics**. Extraction confidence describes the reliability of text, order, and structure; it is
not the confidence shown for a search result. The panel reports the extraction revision, accepted
native blocks, regional candidates, low-confidence blocks, provider calls, cache hits, cache-hit
rate, extraction time, and warnings. The same dialog contains the improved Markdown reader and the
original PDF viewer.

The authorized API equivalents are:

- `GET /v1/documents/{id}/extraction-diagnostics`
- `GET /v1/documents/{id}/enhanced-reindex-estimate`
- `GET /v1/documents/{id}/markdown`

The diagnostic endpoint never returns block text. A caller still needs the document's
`read_markdown` capability and silo scope.

## Enhanced re-index procedure

1. Confirm that the retained original PDF is available and its integrity check passes.
2. Open the document details and select **Re-index**.
3. Review the estimate. It separates images per call from parallel calls and shows regional and
   full-page candidates, estimated batches, provider timing availability, and scan-heavy warnings.
4. Confirm the operation. NodeRag extracts and embeds from the immutable managed original.
5. Watch the single document workflow. Existing search chunks remain active during extraction and
   embedding. The replacement chunk set is swapped in one database transaction only after all new
   embeddings exist.
6. Reopen diagnostics and verify `pdf-layout.v3-hybrid`, expected native/vision/mixed counts, and
   any fallbacks. Search a known passage and open both its cited PDF page and Markdown location.

Accepted vision Markdown is surrounded by invisible provenance comments. Chunk embeddings omit the
comments while retaining the reconstructed content and heading context. Regional results replace
only their target block; full-page recovery replaces, rather than appends to, an unreadable native
page.

## Failure and recovery guidance

- **`vision-provider-unreachable`, timeout, or rate limit:** reliable native text remains available.
  The image or crop stays retryable. Restore the provider and use the existing manual vision retry.
- **`vision-content-malformed` or schema-invalid:** do not loosen validation. Confirm that the model
  supports the configured structured response. PDF responses must contain ordered layout blocks,
  one valid source-image index per result, confidence, plain text, Markdown, and normalized bounds.
- **`vision-low-confidence`:** NodeRag retains the native fallback or placeholder and records the
  unresolved warning. Review the crop/model and retry; do not treat the rejected response as
  canonical content.
- **Unexpected regional dispatch database failure after upgrade:** verify migration head
  `000015_pdf_hybrid_vision`. That migration admits `pdf-region` dispatches and persists revisioned
  layout blocks and source crop policy in the vision cache.
- **Re-index failure:** the prior searchable chunk set remains active and diagnostics record a
  retryable enhanced-reindex error. Keep the original PDF. Correct the provider, storage, or worker
  condition and requeue the document.
- **Suspected duplicate text:** compare canonical Markdown and block diagnostics. Accepted regional
  output must replace one target range and full-page output must replace the page. Never repair the
  canonical file manually; retry under the last passing extraction policy.
- **Locator failure or integrity warning:** stop enhanced activations, retain the original and prior
  search build, run the integrity job, and preserve job events plus the proof output for diagnosis.

## Testbed and DSM boundary

The automated acceptance provider is deterministic and keyed by image bytes. Real-provider checks
remain opt-in because they require the operator's Ollama endpoint, model, credential, availability,
and cost approval. No intermediate Synology package is produced for this four-stage amendment.
Repeat regional crop rendering, scan recovery, cache/retry behavior, large-PDF pressure, restart,
backup/restore, search citation, and 1-hour operation with the exact future SPK on DSM before
claiming DSM certification.
