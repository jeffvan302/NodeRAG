# NodeRag platform policy

This document records release decisions from the NodeRag project planning set. It is part of the approved Milestone 12 evaluation corpus.

## Product boundary

NodeRag is a self-contained retrieval augmented generation database for Synology DSM 7.2 or later. It is distributed as one SPK and runs under the package-created account. PostgreSQL 17, pgvector, the application, the worker, and the local embedding runtime are package controlled.

Milestones 0 through 14 are implemented and certified in WSL and Docker. The exact release candidate then receives one final installed DSM test. Docker results are never presented as Package Center, DSM ACL, NAS thermal, or real storage performance evidence.

## Content boundary

Document text, embeddings, queries, and results remain on the NAS. The only content permitted to leave the device is an image selected for analysis by the configured Ollama vision provider. Provider failure leaves the image pending while text ingestion continues.

The supported release formats are PDF, DOCX, XLSX, Markdown, and plain text. Macro-enabled or legacy spreadsheet formats are outside the release contract.

## Identity and authorization

Every browser, REST, or MCP request resolves to a principal and an allowed silo set. Silos carry access control, not separate models or chunk settings. Search-only API keys may retrieve passages but may not download originals or fetch full Markdown.

PostgreSQL row-level security is a backstop for source, document, page, image, and chunk data. The release threshold for cross-silo leakage is exactly zero. The audit code SEC-403 identifies a denied cross-silo retrieval attempt.

## Retrieval defaults

Vector search is the initial default. Keyword search supports exact identifiers, names, error codes, and quoted phrases. Hybrid is promoted only if it improves overall Recall at 10 by at least two percentage points without more than doubling p95 latency.

The accepted initial chunk profile is 2,000 target characters with 300 overlap, a 1,024-token guard, heading prefix enabled, and `ef_search` set to 100. Candidate runs also compare 1,200/200 and 3,000/400 profiles.

## Stable evidence

Relevance is stored against a stable document identity and page number or sheet range, never an internal chunk ID. Chunks carry UTF-16 character offsets and UTF-8 byte offsets. PDF and Word retain page numbers, Excel retains sheet labels, and Markdown and text retain document-relative character positions.

The nightly evaluation pins the commit, migration head, build, model manifest, settings revision, corpus snapshot, and search mode. It reports Recall at 10, mean reciprocal rank, nDCG at 10, zero-result rate, and p50 and p95 latency.

## Unicode behavior

Text is normalized to NFC before offsets, hashes, and chunks are computed. A query for `café` must match a document containing the canonically equivalent decomposed form. The same pipeline preserves `ローカル検索`, `البحث المحلي`, `로컬 검색`, and the supplementary character in `storage check ✅`.
