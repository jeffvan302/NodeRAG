# Mistral Whole-Document OCR

Mistral OCR is an optional third PDF parse strategy alongside Poppler and
direct vision page groups. It uploads one PDF, receives page-separated
Markdown, then reuses the platform's existing page, chunk, embedding, generated
file, status, and webhook lifecycle.

## Configure It

1. Open **Configuration → Access points → Mistral**.
2. Save the Mistral API base URL and API key, then use **Test**. The result
   lists visible `mistral-ocr-*` models or warns when the key works but the
   workspace has no visible OCR entitlement.
3. Open the **PDF Parse** model task.
4. Select **Mistral whole-document OCR**.
5. Review the model, parallel-document count, table format, header/footer
   separation, image handling, confidence level, soft usage cap, and
   large-document serialization threshold.
6. Save the task.

The default model alias is `mistral-ocr-latest`. The default estimated price is
$4.00 per 1,000 pages and can be changed beside the OCR timeout and retry
allowance. The price is used only for local estimates and soft-cap enforcement;
the provider invoice remains authoritative.

## What Gets Stored

- Page Markdown is written to `document_pages.ocr_text` and becomes the input
  to normal chunking and embeddings.
- Extracted headers and footers remain in page metadata. They are deliberately
  excluded from searchable Markdown so running boilerplate does not weaken
  retrieval.
- Page confidence is written to `document_pages.ocr_confidence` when returned.
- Optional returned figure bytes are stored in `extracted-assets` and linked
  through `document_assets`.
- The assembled Markdown inspection file records requested and resolved model,
  billed pages, retries, duration, missing pages, configured price, estimated
  cost, and the parse engine actually used.
- `mistral_ocr_usage` keeps the provider-usage ledger even if a source document
  is later deleted.

## Reliability And Fallback

Network failures, timeouts, HTTP 429 responses, provider 5xx responses, the
configurable application file-size guard, and an explicitly configured cap fallback
can make one hop to direct vision. Missing/rejected credentials and malformed
accepted responses never fall back because doing so would conceal a broken
configuration or pay twice for an accepted request.

When fallback is enabled, configure at least one route in the PDF model call
list. The generated-file metadata, page metadata, and job progress identify the
requested strategy, engine used, fallback reason, and fallback time.

The upload, signed-URL, and OCR calls all honor `Retry-After`, use bounded
exponential backoff, keep the processing-job heartbeat current, and delete the
temporary Mistral file on both success and failure. Large PDFs at or above the
configured threshold serialize only the remote OCR work to limit peak memory
and soft-cap overshoot.

## Usage And Progress

The PDF task panel shows pages and estimated spend for the active cap window.
This is a soft ceiling: already-running documents can finish after another job
reaches it. The document status reports preparation, submitted page count,
upload, signed-URL preparation, provider processing, transient retries,
temporary-file cleanup, returned pages, chunking, and embedding through the
existing ingestion display.

Operational defaults:

| Setting                |                   Default |              Bounds |
| ---------------------- | ------------------------: | ------------------: |
| Whole-document timeout |                600,000 ms | 30,000–1,800,000 ms |
| Transient retries      |                         3 |                0–10 |
| Parallel documents     |                         4 |                1–32 |
| Application file limit |                     50 MB |            1–512 MB |
| Serialize at size      |                     10 MB | 0–application limit |
| Page soft cap          | 10,000 per calendar month |            Editable |
| Estimated price        |       $4.00 / 1,000 pages |            Editable |

## Verification

The worker transport tests cover temporary-file cleanup, rate-limit retry and
`Retry-After`, authentication failure classification, provider telemetry,
zero-to-one-based page normalization, and missing-page reporting. Runtime
schema tests cover defaults, bounds, and invalid fallback/cap combinations.
