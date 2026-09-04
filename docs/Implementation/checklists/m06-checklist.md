# M06 — TXT, PDF, DOCX, and XLSX Extraction Checklist

Status: testbed-complete

Environment: WSL/Docker testbed and non-root Linux package simulation

Recorded: 2026-09-04

## Pure extraction and assembly contract

- [x] The extractor boundary accepts bytes, an exact supported format, options, and an injected vision capability; it has no database, filesystem-path, system-clock, or network dependency.
- [x] MD, TXT, PDF, DOCX, and XLSX return the same page/document contract with method, confidence, warnings, images, page basis, and metadata.
- [x] Shared assembly normalizes LF/NFC, orders pages, and inserts exactly two newlines between multi-page bodies.
- [x] Page markers remain metadata and are not injected into searchable Markdown.
- [x] Every page records UTF-16 character and UTF-8 byte ranges against the final assembled Markdown.
- [x] Empty pages, including scan-only pages awaiting vision, use valid zero-length ranges without being represented as text.
- [x] Canonical Markdown is durably written before database rows expose the extracted version.

## TXT and Markdown

- [x] BOM-marked UTF-8, UTF-16LE, and UTF-16BE are decoded with the BOM removed.
- [x] BOM-less UTF-16 uses an alternating-null heuristic before strict UTF-8.
- [x] Strict UTF-8 is preferred and malformed input is never silently accepted as UTF-8.
- [x] The locked `chardet` and `iconv-lite` path decodes supported legacy encodings, records confidence, and exposes low-confidence warnings.
- [x] Candidate legacy decodes containing replacement characters lose to a clean detector candidate.
- [x] CRLF/lone-CR conversion and NFC normalization occur before locators are computed.
- [x] Markdown structure is preserved; plain text does not invent headings.
- [x] Byte-identical single-page UTF-8 input retains `offsets_match_original=true`, including its final newline.

## PDF

- [x] The locked PDF.js legacy ESM runtime extracts one exact page per PDF page.
- [x] Glyph coordinates, approximate render-mode evidence, inferred gaps, duplicate suppression, ligature folding, conservative hyphen joining, and two-column ordering are implemented.
- [x] Page confidence penalizes replacements, private-use/control characters, and implausible single-glyph fragmentation.
- [x] Empty, low-quality, or document-median outlier pages route to injected vision rather than gibberish indexing.
- [x] Scan-only pages remain `awaiting_vision` with an explicit warning until M07 supplies the provider.
- [x] Encrypted/password-protected PDFs produce a stable unsupported-encryption error.
- [x] PDF.js and its worker are copied as ESM vendor assets and load from the production CJS bundle and packaged worker.

## DOCX

- [x] DOCX is walked directly from bounded OOXML entries.
- [x] Heading/title styles, bold/italic runs, ordered/unordered lists, tables, images, footnotes, explicit page breaks, section breaks, and `lastRenderedPageBreak` are handled.
- [x] Saved break evidence yields `rendered`; explicit-only breaks yield `explicit`; generated documents without evidence yield `none`.
- [x] Images retain exact SHA-256 identity and are represented by provenance blocks with a visible pending-vision state.
- [x] Unsafe ZIP paths, encrypted packages, entry-count limits, total uncompressed limits, and extreme compression ratios fail closed.

## XLSX

- [x] Workbook and worksheet OOXML supports namespaced and namespace-prefixed producers.
- [x] Worksheets are parsed incrementally with `saxes`; the implementation does not construct an ExcelJS workbook object.
- [x] One worksheet maps to one `sheet`-basis page with a stable sheet label.
- [x] Date, number, percentage, and currency formats use displayed values rather than raw serials where the format is known.
- [x] Formula cached values are indexed; absent caches emit a cell-addressed warning and never invent zero.
- [x] Blank rows/columns split contiguous regions; conservative headers produce Markdown tables.
- [x] Merged labels repeat across the merged range.
- [x] Regions wider than 15 columns use record-oriented Markdown.
- [x] Hidden, empty, and missing worksheet parts produce explicit warnings.
- [x] Embedded workbook media enters the same injected vision interface and retains digest identity.
- [x] Sheet, cell, archive-entry, uncompressed-byte, and compression-ratio ceilings are enforced.
- [x] A 5,000-row/15,003-cell streaming proxy and a 90-column fixture exercise tall and wide behavior; the final DSM register retains the release-scale memory case.

## Upload, sources, persistence, and retrieval

- [x] Upload validation accepts only the five planned extension/MIME combinations.
- [x] PDF magic and DOCX/XLSX package identities are checked after streaming staging and before database acceptance.
- [x] Managed originals retain the correct extension and extraction jobs freeze the correct format.
- [x] Watched sources deterministically enumerate all five formats under the existing allowlist/symlink/glob protections.
- [x] Document rows persist encoding, confidence, page basis/count, warnings, extraction metadata, canonical digest, and normalization identity.
- [x] Page rows persist exact labels, methods, confidence, and both locator units.
- [x] Image rows persist exact digests, byte counts, dimensions when known, and pending/analysed/skipped state.
- [x] Chunks inherit page ranges only when the source has honest page evidence; page-less MD/TXT chunks remain unqualified.
- [x] Exact chunk/vector cache keys continue to reuse unchanged embedding work.
- [x] Scanned PDFs do not create chunks before vision succeeds.

## Fixtures and tests

- [x] The repository contains the planned MD/TXT/PDF/DOCX/XLSX synthetic fixture matrix and a SHA-256 catalog.
- [x] `pnpm fixtures:m06` regenerates every M06-authored fixture deterministically.
- [x] Fixtures cover UTF-8, BOM-less UTF-16, Shift-JIS, NFD, astral/RTL text, two columns, scan fallback, hyphenation, rendered/explicit/no DOCX pagination, tables/images/footnotes, regions, formats, missing formula caches, merges, 90 columns, and 5,000 rows.
- [x] The catalog distinguishes synthetic controls from approved real external samples; it does not misrepresent provenance.
- [x] Unit tests hand-check expected Markdown semantics, warnings, page bases, memory ceilings, and dual offsets.
- [x] PostgreSQL 17/pgvector integration uploads and indexes all five formats, verifies page-aware chunks, tests scan waiting, rejects signature mismatches, and crawls all five formats.
- [x] The complete M01–M06 integration regression suite passes locally.

## Production bundle, package, delivery, and evidence

- [x] The production server/worker bundles build and the server smoke test passes.
- [x] Runtime dependency licenses pass the approved allowlist; exact new direct runtime components are recorded in `THIRD-PARTY.md`.
- [x] `platform/openapi.m06.json` describes five-format upload acceptance and media/signature rejection.
- [x] The thin SPK contains the M06 OpenAPI contract plus the PDF.js ESM runtime/worker.
- [x] Non-root package simulation uploads MD, TXT, PDF, DOCX, XLSX, and a scan-only PDF through the packaged API and worker.
- [x] Two final package builds are byte-identical at 2,365,440 bytes with SHA-256 `de771049c87d341b65fa1d9cc422670880ac60f05d5fcffebfc785a4666c72dd`; these values will be copied into `m06-proof.json` after the implementation commit exists.
- [x] Frozen install, migrations, TypeScript, lint, formatting, boundaries, units, production build/smoke, licenses, secrets, repository hygiene, and all integration tests pass after documentation freeze.
- [x] The implementation commit is pushed to `main` and every M06 GitHub job succeeds.
- [x] The proof-closure commit passes every M06 GitHub job.
- [x] The final certification commit passes every M06 GitHub job, and annotated tag `m06-complete` resolves remotely to that commit.

## Honest limitations and DSM deferral

- [x] An approved real Google Docs export and a redistributable production no-ToUnicode sample remain named operator inputs; synthetic controls are not presented as those real artifacts.
- [x] Live Package Center, package identity/ACL, NAS memory/thermal, and installed-SPK format checks remain open in the DSM register.
- [x] No Docker, WSL, static archive, or package-simulator result is represented as live DSM evidence.

M07 is authorized. No M06 testbed result closes a live DSM register row.
