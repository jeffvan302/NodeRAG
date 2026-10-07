# PDF layout block contract

Status: Stage 1 frozen contract (`pdf-layout.v1-shadow`)

## Purpose

`ExtractedBlock` is the durable bridge between page extraction and canonical Markdown assembly. It
records what the extractor observed, how that observation was classified, and exactly where the
emitted block lands in both UTF-16 character and UTF-8 byte coordinates. During Stage 1 the block
representation is shadow-only: every non-empty page receives one compatibility paragraph block, so
assembling the blocks produces exactly the pre-existing page body.

Canonical Markdown remains the searchable source of truth. Block rows are provenance and
diagnostics and never replace the retained original, the canonical Markdown artifact, or page and
chunk locators.

## Identity and ordering

A block is identified by `(document_id, page_ordinal, ordinal)`. The document ID remains independent
of a knowledge-base slug because slugs are editable display/routing metadata, while documents,
pages, blocks, chunks, purge relationships, and restore remapping require a stable identity.
`reading_order` is explicit and unique within the assembled page contract. Content never crosses a
page boundary.

## Bounding boxes

Bounds are page-relative values in the closed interval `0..1`:

- `x` and `y` locate the upper-left corner relative to the page width and height;
- `width` and `height` describe the relative extent;
- `x + width` and `y + height` may not exceed the page boundary, allowing a `0.0001` storage
  tolerance for floating-point normalization;
- all four values are either present or absent together.

PDF compatibility blocks use the full page `(0, 0, 1, 1)`. Formats without meaningful page
geometry may omit bounds. Pixel and PDF-point coordinates are adapter-local and are never persisted
in the normalized contract.

## Block kinds and source

The frozen kinds are `title`, `heading`, `paragraph`, `list-item`, `table`, `caption`, `footnote`,
`header`, `footer`, `code`, and `unknown`. They describe the extractor's structural judgment rather
than Markdown syntax alone. The durable source values are `text`, `vision`, and `mixed`; `text`
means deterministic native/parser extraction.

## Locators

The extractor supplies ordered block Markdown but does not calculate final offsets. The shared
assembler joins blocks and pages, then assigns inclusive-start/exclusive-end ranges in:

- JavaScript/UTF-16 code units (`character_start`, `character_end`); and
- UTF-8 bytes (`byte_start`, `byte_end`).

For every block, slicing the canonical Markdown by either representation must reproduce the exact
emitted Markdown. This keeps database locators, viewer navigation, chunk provenance, and Unicode
content consistent.

## Confidence and revisions

Every block stores text, reading-order, structure, and combined confidence in `0..1`, plus bounded
component details and warning codes. These values describe extraction reliability and must never be
shown as search relevance. Stage 1 compatibility blocks use the frozen page confidence policy.

Every row records parser, layout-policy, and confidence-policy revisions. Vision prompt, schema,
preprocessing, and model revisions are nullable and become mandatory when `source` is `vision` or
`mixed`. Re-indexing creates data under an explicitly frozen revision instead of reinterpreting old
scores.

## Persistence, security, and lifecycle

`noderag.document_block` has silo-preserving foreign keys to its document and composite page
identity, row-level silo security, and cascade deletion. It is included in portable and full backup
classification, restore ordering/remapping, orphan verification, and document/silo purge behavior.
No separate content-grant surface is introduced in Stage 1.

## Compatibility guarantee

For `pdf-layout.v1-shadow`, ordered block Markdown joined with a blank line must equal the normalized
page body byte-for-byte. A mismatch, duplicate ordinal, invalid confidence, invalid bound, or bad
locator is an extraction error rather than a silently repaired result. Structural Markdown does not
become active until the Stage 2 proof passes.
