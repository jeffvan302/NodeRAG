# Federated Data

This folder is the source of truth for Federated Data: per-silo reference
datasets that give models a durable identifier for a real world thing, so the
same grant, project, department, or vendor carries the same ID across every Ask,
Extraction, and Task run.

## Current Direction

- Federated Data is its own product area at `/federated-data`, beside Templates.
  It is not a Reference Library and it is not RAG.
- All of it is stored in the configured Supabase Postgres database, in a
  migration under `supabase/migrations/`. It is tenant row data with foreign
  keys, RLS, and search indexes — not settings, and not in the settings service.
- A **Federated Dataset** is a reusable tool definition: name, model tool name,
  description, and ID configuration. One dataset becomes one dynamic model tool.
- **The definition is shared across silos. The data is not.** Assigning one
  dataset to two silos gives each silo its own entries, its own ID sequence, and
  no visibility into the other's.
- An **Entry** carries an immutable system-owned `entry_id`, an editable
  `display_id` that is what generated documents print, a required `name`, and a
  description of up to 32 KB.
- Names are not unique. Two entries may legitimately share or nearly share a
  name; distinguishing them is what lookup's confidence tiers are for.
- The model reads and writes. It addresses every edit by internal ID and can
  never change that ID; it can change the display ID, the name, and the
  description.
- Unassigning a dataset from a silo never deletes that silo's entries.
  Re-assigning restores them, including the ID sequence position. Destroying
  data is a separate, explicit clear action.
- Deleting the dataset definition is the opposite: it removes every silo's
  entries and aliases in one cascade, so no orphan data survives a retired tool.
- A newly assigned silo always starts empty. Nothing is seeded or copied.
- No audit history is kept. An entry holds what it is now; superseded display
  IDs survive only as lookup aliases, so older documents keep resolving.
- Reading is cheap by default and expensive only on request. `list` returns
  identifiers and names, `lookup` resolves up to 25 names or codes at once, and
  only `get` moves descriptions. No operation returns a description that was not
  asked for by identifier.
- Reads page by page number, reporting `total_pages` and `pages_remaining`, with
  a snapshot token so a model that writes entries between pages does not skip
  rows.
- Matching is deterministic: exact identifiers, then names through several
  normalization tiers, then Postgres full-text over descriptions. No embeddings.

```text
Tenant
  └── Federated Dataset                 shared definition, one model tool
        ├── Dataset × Silo              assignment + that silo's ID sequence
        │     └── Entry                 per-silo data, retained on unassign
        │           ├── internal entry_id      immutable
        │           ├── display_id             editable, what documents print
        │           ├── name                   required, not unique
        │           └── description            up to 32 KB
        └── Deleting the definition removes every silo's data
```

## Reading Order

1. [Federated Data specification](federated_data_spec.md)

The specification is authoritative. Section 13 records the fourteen design
decisions that have been settled, with their reasoning, so they are not
relitigated.

## Implementation State

**Nothing is implemented.** The specification is complete enough to build from;
the schema, tool contract, three-tab user interface, and REST surface are all
defined. The API endpoints described in the specification are deliberately
absent from [the canonical API guide](../api-usage.md), which documents only
routes that exist — `pnpm docs:check` verifies that.

Two areas are deliberately unspecified until the section exists and holds real
data: how entries are presented at scale in the Edit tab, and whether
noise-token curation ever becomes operator-facing.

There is no bulk importer, by decision. A registry is seeded by running an Ask
against a source document already in the silo and letting the model write the
entries through the tool it will use in production.

## Relationship To Templates

The two subsystems compose. A template comment can instruct the model to resolve
a value through a federated dataset before writing it, so a repeating monthly
report produces joinable output rather than a fresh vocabulary each month. See
section 12 of the specification.
