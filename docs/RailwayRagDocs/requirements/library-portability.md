# Portable Library Export And Import

> Status: Target feature and implementation plan. No export/import runtime is
> implemented by this document.

## Purpose

Reference libraries can require substantial editorial work: selecting source
documents, producing useful canonical Markdown, grouping documents into library
projects, and writing tool names and descriptions that models can choose
correctly. That work should be movable without carrying a complete database or
repeating expensive document parsing.

A portable library package contains the reusable knowledge source and library
design. It deliberately does not contain a ready-made vector index or any
destination silo assignment.

On import, the target restores the original and canonical Markdown files, then
uses the target tenant's current chunking and embedding configuration to create
new chunks and vectors. PDF/DOCX/Excel parsing, OCR, image analysis, and source
Markdown assembly are skipped unless the operator later requests a full
reprocess.

## Not A System Backup

A library package and a system backup serve different purposes.

| Property | System backup | Library package |
| --- | --- | --- |
| Goal | Recover an installation | Move reusable reference knowledge |
| Scope | Tenant/system data according to backup policy | Selected libraries or library projects |
| Original files | Included | Included |
| Canonical Markdown | Included | Included and required |
| Chunks and embeddings | Included for fast recovery | Excluded and rebuilt on import |
| Silo access and tool bindings | Included as authorization state | Excluded |
| Encryption | Mandatory | Optional, with an explicit sensitivity choice |
| Installation settings/history | Classified by backup contract | Excluded |

Calling the package a backup would create the wrong recovery expectation. A
library package is complete only for recreating the library after chunking and
embedding; it cannot restore the surrounding installation.

## Current Schema Terms

The word "project" has two meanings in the current schema:

- `library_projects` are subdivisions of a library. Each row is also a model
  tool definition through `tool_name`, `display_name`, and `description`.
- `projects` are ordinary silo/workflow projects.

Portable library export includes **library projects**. It does not include
ordinary projects, silos, or their memberships. A document that belongs to
several library projects preserves those library-project memberships inside the
package.

## Package Scope

The export interface should support:

- one complete library, including all of its library projects
- selected library projects from one library
- optionally selected documents, provided every exported document retains at
  least one exported library-project membership

The complete-library option is the default because it is easiest to understand
and least likely to omit a tool or a shared document accidentally.

## Included Values

### Library and tool definitions

| Current source | Values included |
| --- | --- |
| `libraries` | Export-local ID, name, slug, description, safe metadata, and ordering timestamps where meaningful |
| `library_projects` | Export-local ID, parent library ID, tool name, display name, description, enabled intent, and safe metadata |
| `library_project_documents` | Library-project/document relationships, preserving many-to-many membership |

A `library_projects` row is the reusable tool definition. Its model-facing name
and description are included. The destination-specific polling limit is not:
`max_polls` currently belongs to `library_tool_bindings`, which is an assignment
to a particular silo/project/task and is excluded.

### Documents and files

| Data | Values included |
| --- | --- |
| Document identity | Export-local ID, file name, title, MIME type, parser provenance, processing depth, safe metadata, and source timestamps needed for display |
| Original object | Exact original bytes, original file name, MIME type, byte size, checksum, and document role |
| Canonical Markdown object | Exact assembled Markdown bytes, file name, UTF-8 content type, byte size, checksum, canonical-format version, and parser/source provenance |
| Relationships | Document-to-library-project memberships and package-local object references |

The physical source bucket, Supabase project, S3 endpoint, signed URL, Railway
volume path, and source tenant ID are not importable values. The package uses
provider-neutral paths and export-local IDs. Import writes the objects through
the target document service, which applies the target's mandatory object
encryption and physical placement.

## Explicit Exclusions

The package must prove that it does not contain:

- `document_chunks`
- `document_embeddings`
- vector indexes or embedding caches
- `document_pages`, page renders, extracted assets, table exports, and parser
  diagnostics
- processing jobs, locks, retries, progress, and ingestion history
- generated files other than the canonical Markdown selected for the package
- conversations, Ask/Extraction runs, results, citations, or usage logs
- tenants, administrators, API users, API keys, provider secrets, or credentials
- ordinary `projects`, `silos`, `document_project_memberships`, or silo documents
- `library_project_access` rows that grant a silo permission to use a library
- `library_tool_bindings` rows assigning a tool to a silo/project and Ask or
  Extraction
- source storage routes, database routes, or installation settings

These exclusions are semantic, not just table exclusions. A silo ID, access
grant, binding, credential, signed URL, or vector value hidden inside metadata
or JSON must also be removed or cause verification to fail.

## Canonical Markdown Requirement

Every exported document requires both an original object and canonical
Markdown. The package must not fall back to exporting chunks as a substitute
for Markdown.

The current database supports a `canonical_markdown` document-file role, and
the Markdown download path can assemble and privately cache the representation
when it is absent. However, the ingestion worker currently saves its assembled
source Markdown only when the document has a `silo_id`; library documents use
`silo_id = null`, so their assembly is skipped during normal ingestion.

Before packaging a library document, export must call one shared canonical
Markdown materialization path that:

1. Returns an existing verified `canonical_markdown` object when available.
2. Otherwise assembles the same lossless Markdown used by the document text and
   Markdown-download paths from durable page/source data. A legacy document may
   use stored chunk/source offsets only to materialize this Markdown object;
   those chunks still do not enter the package.
3. Writes it as a first-class encrypted document representation.
4. Records checksum, byte size, parser/format version, and source-document
   checksum.
5. Re-reads or hashes the stored result before admitting it to the package.

If the canonical representation cannot be reproduced losslessly, export blocks
that document and offers an explicit reprocess. It must not invent a Markdown
file by concatenating chunks with lost ordering, overlap, or source regions.

Longer term, ingestion should persist canonical Markdown for both silo and
library documents before chunking. Export-time materialization remains a
compatibility path for documents ingested before that change.

## Package Format

Use a distinct, versioned format such as `.braglibrary`; do not reuse the
system-backup format or extension.

```text
manifest.json
checksums.sha256
library/library.json
library/projects.jsonl
library/project-documents.jsonl
documents/documents.jsonl
objects/original/<package-document-id>/<file>
objects/markdown/<package-document-id>/<file>.md
reports/export-summary.json
```

The exact container can reuse the backup stream's tar/zstd and encryption
primitives, but it has its own magic value, format version, manifest schema,
content rules, and verifier.

The manifest includes:

- package format and minimum compatible application version
- export ID and creation time
- encryption state, algorithm/version, and key fingerprint when encrypted
- library/project/document counts
- every relationship count
- each object path, role, byte size, MIME type, and checksum
- source and canonical Markdown checksum pair for every document
- explicit assertions that chunks, embeddings, silo access, and bindings are
  absent
- warnings for incomplete or unavailable documents

The manifest may carry non-secret source provenance for diagnosis, but it must
not carry a source tenant route, database endpoint, project reference, bucket
credential, or usable secret.

## Optional Package Encryption

Library-package encryption is optional because these collections are often
reusable manuals, standards, and operating guidance rather than an exclusive
tenant knowledge base. Some libraries are sensitive, so encryption must be an
obvious export choice rather than a hidden advanced option.

### Unencrypted export

- The export interface clearly states that original and Markdown content will
  be readable by anyone holding the package.
- The operator explicitly confirms the unencrypted choice.
- The manifest records `encrypted: false`.
- No credential, secret, signed URL, or private installation value is included,
  regardless of the encryption choice.

Primary object storage remains application-encrypted. An unencrypted package is
the authorized export artifact, not an exception that writes primary originals
unencrypted. If the application temporarily retains the package server-side,
the normal encrypted object-storage layer still protects the stored package.

### Encrypted export

- The operator supplies and confirms a package password.
- The password meets the configured strength policy and is never stored.
- A per-package salt derives an authenticated-encryption key.
- Only algorithm/version, salt/nonce material, and a non-reversible key
  fingerprint accompany the package.
- Inspect and import require the password again.
- A wrong password or modified byte fails authentication before import begins.

The package password is independent from the mandatory system-backup password,
object-encryption key, administrator password, and provider credentials.

Export streams target objects through authorized object decryption and directly
into optional package encryption. Import streams optional package decryption
directly into the target's mandatory object encryption. Plaintext is not staged
on a Railway volume or temporary object.

## Import Modes And Conflicts

### Default: import as a new library

- Generate new target IDs and retain a package-to-target ID mapping in the
  import report.
- Create a unique library slug when the source slug already exists.
- Preserve library-project grouping and document many-to-many membership.
- Preserve the tool's requested name and description when the name is free.
- Keep each imported tool unavailable until its documents finish indexing.

Source UUIDs are package identities, not target primary keys. Generating target
IDs avoids collisions when a package is imported twice or moved within the
same installation.

### Explicit merge into an existing library

The operator selects the target library and chooses a conflict outcome for each
library project and document:

- create a new library project
- map to an existing library project
- rename a conflicting tool
- skip the item
- reuse an existing document with matching original and Markdown checksums
- import a separate copy

There is no silent overwrite. In particular, matching only by file name or tool
name is not sufficient evidence that two items are the same.

### Tool-name conflicts

Tool names are unique per tenant and must not collide with built-in tools. When
an imported name conflicts, import pauses before committing or applies an
operator-approved rename. The import report records the original and final
names. Descriptions and display names travel with the tool.

## Import And Reindex Pipeline

1. **Inspect:** authenticate/decrypt if needed, validate format/version, scan
   paths, and verify every checksum without mutating the target.
2. **Plan:** show libraries, projects/tools, documents, conflicts, deduplication
   candidates, bytes, and expected indexing work.
3. **Create metadata:** create the library, library projects, documents, and
   package-local relationships in an import-pending state.
4. **Store source representations:** stream originals and canonical Markdown
   through the target document service and target object encryption.
5. **Chunk Markdown:** use the target tenant's current chunk size, overlap, and
   chunking version directly against canonical Markdown.
6. **Embed chunks:** use the target's current embedding provider, model,
   dimensions, and version.
7. **Verify:** compare document/object counts and checksums, chunk coverage,
   embedding counts/dimensions, and representative library searches.
8. **Activate:** mark verified documents ready and restore each library
   project's intended enabled state.
9. **Assign separately:** an administrator may later grant the library project
   to silos and bind its tool to Ask or Extraction. Import never performs this
   step automatically.

The low-cost path begins at step 5. It does not reopen the original file for
OCR, vision, embedded-image analysis, or document parsing. The original remains
available for provenance, download, and an explicit future reprocess.

If the target embedding service is unavailable, metadata and objects can be
imported in a blocked state. The library project remains unsearchable and is not
offered as a model tool until chunking, embedding, and verification succeed.

## Transaction And Failure Behavior

Object storage and Postgres do not share a transaction. Import therefore uses
a durable job and an import ID:

- all writes are idempotent under the import ID
- package-local IDs map to target IDs once
- incomplete objects remain private and unreferenced by ready documents
- a failure leaves the import resumable or explicitly removable
- cancellation does not delete a pre-existing document selected for reuse
- activation happens only after all required relationships and object checks
  pass

The package itself is never modified during import.

## Authorization And Audit

Exporting a complete library is a bulk data-exfiltration capability. Importing
can create model tools and large processing workloads. Both require explicit
permissions rather than inheriting ordinary read/write scopes accidentally.

The target API should introduce administrative `libraries:export` and
`libraries:import` permissions, or keep both operations administrator-only in
the first implementation. `libraries:grant` remains separate because import
does not grant silo access.

Audit records include:

- actor and tenant
- package/export/import ID
- selected library/projects and document counts
- encrypted or explicitly unencrypted choice
- key fingerprint when encrypted, never the password
- checksums and byte totals
- conflict decisions, generated IDs, renames, and deduplication choices
- indexing and verification outcome

Knowledge content is not redacted merely because it resembles a secret; doing
so would corrupt the library. The interface warns that document content may be
sensitive and offers encryption. Package metadata outside original/Markdown
content still undergoes secret-path validation and must not contain credentials.

## Verification Requirements

Export fails unless:

- every document belongs to at least one exported library project
- every document has one verified original and one verified canonical Markdown
  representation
- every declared object exists at the expected byte size and checksum
- all package-local IDs and relationships resolve
- no chunk, vector, silo, access, binding, credential, or route payload exists
- paths are unique, normalized, and cannot escape the package root

Import fails before mutation when:

- container authentication or a checksum fails
- format/application compatibility is unsupported
- required entries or relationships are missing
- object size/count limits or decompression-ratio guards fail
- a conflict has no explicit policy

Import is not complete until the target verifies object checksums, chunk and
embedding coverage, dimensions/model compatibility, and representative library
searches.

## Implementation Work

1. Define and pin `library-package-manifest.v1` plus its independent verifier.
2. Make canonical Markdown durable for library documents during ingestion and
   add export-time materialization for older documents.
3. Add export/import job, artifact, finding, and package-to-target ID-mapping
   records; exclude them from system portable backups as local operation state.
4. Build a streaming package writer/reader, reusing proven archive encryption
   primitives without reusing the system-backup schema.
5. Add a chunk-from-canonical-Markdown import job that bypasses source parsing.
6. Add deterministic conflict, rename, merge, and checksum-deduplication rules.
7. Add admin UI actions for export scope, optional encryption, import inspect,
   conflict resolution, progress, and verification.
8. Add explicit authorization and audit events.
9. Test encrypted and unencrypted round trips, shared documents across library
   projects, name conflicts, duplicate imports, cancellation/resume, tampering,
   path traversal, missing Markdown, and proof that chunks/access/bindings never
   enter a package.

This feature is accepted only after an exported library has been imported into
a clean target, re-chunked, re-embedded, searched successfully, and confirmed to
have no silo access or tool bindings until an administrator assigns them.
