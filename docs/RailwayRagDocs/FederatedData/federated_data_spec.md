# Federated Data

**Status:** Design settled 2026-08-18 (§13). Schema, REST surface, operator
screens, and the model tool are implemented; §7.7 records what implementation
settled that the design did not.
**Purpose:** Define Federated Data as a first-class product area: shared,
stable reference datasets that give models a durable identifier for a real
world thing, so the same grant, project, department, or vendor carries the same
ID across every Ask, Extraction, and Task run.

Federated Data is modelled on the Templates subsystem: a tenant-level catalog,
a per-dataset model tool, and a silo assignment that decides where the tool
appears. It is not a Reference Library and it is not RAG.

---

## 1. Decision Summary

- The application gains a top-level **Federated Data** section at
  `/federated-data`, beside Templates.
- A **Federated Dataset** is a reusable tool *definition*: name, model tool
  name, description, and ID configuration.
- **The definition is shared across silos. The data is not.** Assigning one
  dataset to two silos gives each silo its own independent set of entries,
  its own ID sequence, and no visibility into the other's.
- An entry carries an immutable system-owned `entry_id`, an editable
  `display_id` that is what appears in generated documents, a required `name`,
  and a `description` of up to 32 KB.
- Names are **not** unique. Two entries may legitimately share or nearly share
  a name; distinguishing them is what lookup's confidence tiers are for.
- The model reads and writes. It addresses every edit by internal ID and can
  never change that ID; it can change the display ID, the name, and the
  description.
- **Unassigning a dataset from a silo never deletes that silo's entries.**
  Re-assigning it later restores them exactly.
- Entries are structured records. They never become `documents`,
  `document_chunks`, or `document_embeddings` rows and never enter RAG.

```text
Tenant
  └── Federated Dataset                 shared definition, one model tool
        ├── Dataset ×  Silo             assignment + that silo's ID sequence
        │     └── Entry                 per-silo data, retained on unassign
        │           ├── internal entry_id      immutable
        │           ├── display_id             editable, what documents print
        │           ├── name                   required, not unique
        │           └── description            up to 32 KB
        └── Deleting the definition removes every silo's data
```

## 2. What Problem This Solves

A model extracting from ten monthly reports has no memory between runs. Asked
to tabulate grants, it will call the same grant "Riverside Bridge Rehab" in
January and "Riverside Bridge Rehabilitation Grant" in February, and any ID it
invents will differ every time. Nothing downstream can join those rows.

Federated Data gives the model a per-silo registry it can consult and extend:

1. The model looks up "Riverside Bridge" before writing anything.
2. If an entry exists, it uses that `entry_id` verbatim.
3. If none exists, it adds one and uses the ID that comes back.
4. The next run finds it.

The registry is the shared vocabulary. Reading it is deliberately cheap by
default and expensive only on request: **`list` returns identifiers and names,
`lookup` resolves many candidates at once, and only `get` moves descriptions**
— see §7.4.

### What it is not

| Federated Data                     | Reference Library / RAG                |
| ---------------------------------- | -------------------------------------- |
| Small set of canonical records     | Large corpus of source text            |
| Exact identifier match             | Semantic passage retrieval             |
| Model reads *and writes*           | Model reads only                       |
| Answers "what is this thing's ID?" | Answers "what do the documents say?"   |

---

## 3. Product Objects

### 3.1 Federated Dataset (the shared definition)

| Field                | Meaning                                                           |
| -------------------- | ----------------------------------------------------------------- |
| `id`                 | Stable UUID. The **federated data ID** used by the API.           |
| `name`               | Human label, e.g. "Grant Registry".                                |
| `slug`               | URL-safe name, unique per tenant.                                  |
| `tool_name`          | Model-facing tool name, e.g. `grant_registry`. Unique per tenant.  |
| `tool_description`   | Detailed model-facing description. See §4.                         |
| `enabled`            | Disabled datasets resolve to no tool anywhere.                     |
| `id_prefix`          | e.g. `GR`. Used for the internal ID.                               |
| `id_padding`         | Zero-pad width for the internal counter. Default 4.                |
| `display_id_strategy`| `mirror` \| `prefixed` \| `slug`. Default `mirror`. See §6.2.    |
| `display_id_prefix`  | Used by the `prefixed` strategy.                                   |
| `model_can_write`    | Master switch for model-initiated create and update.               |
| `model_can_delete`   | Narrower switch. Default off. See §9.                              |

Nothing here is per-silo. A dataset is a definition; two silos using it get the
same tool with the same description and the same ID format, over different data.

### 3.2 Dataset × Silo (the assignment, and where data lives)

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `dataset_id`  | Which definition.                                                 |
| `silo_id`     | Which silo.                                                       |
| `assigned`    | Whether the tool currently resolves here. **Soft.** See §8.2.     |
| `id_sequence` | This silo's own internal-ID counter for this dataset.             |

The counter is per pair, so silo A and silo B each start at `GR-0001`. Their
entries are unrelated records that happen to share an ID string, and since no
query ever spans silos they never meet. §8.3 notes the one case where that is
worth thinking about.

### 3.3 Entry

| Field         | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `entry_id`    | Internal handle. System-owned, immutable, never reused.          |
| `display_id`  | What appears in documents. Editable. Never empty. See §6.2.      |
| `name`        | **Required.** Short canonical name. Not unique — see below.      |
| `description` | Substantial free text, up to 32 KB. See §3.4.                    |
| `aliases`     | Former display IDs and alternate codes, lookup-only. See §6.4.   |
| `status`      | `active` \| `retired`. Retired entries resolve but never suggest.|
| `created_by`  | `ui` \| `api` \| `model`, plus the originating run ID.          |

**A name is mandatory and a bare code is rejected.** If a document offers
`DOT-4021` with nothing that reads as a name, the model must find a name or
create nothing. An entry whose name is a code is a record nobody can later
recognize, which defeats the point of a shared vocabulary.

**Names are deliberately not unique.** Two grants really can be called
"Bridge Repair", and two more can be called "Bridge Repair Phase 2" and "Bridge
Repair — Phase II". Uniqueness enforcement would reject legitimate entries and
push the model into inventing distinguishing suffixes. Instead the burden sits
on lookup: near-identical names surface together as `ambiguous` (§7.2) and the
model is told to disambiguate from descriptions rather than guess.

### 3.4 The description is a body of text, not a caption

`description` is where the durable knowledge about the thing lives: what a grant
is for, which programme it comes from, its conditions, what still has to be done
with it, what to watch for when reporting on it. Up to 32 KB, and the model
decides what it needs from it.

Three consequences shape the rest of this specification.

1. **Reading splits in two.** A description is too large to return
   incidentally, so no operation returns one unless it was asked for by name.
   `list` enumerates identifiers and names cheaply; `get` fetches descriptions
   deliberately and in small numbers. §7.4 covers both.
2. **Search results carry a snippet, never the full description.** Candidates
   carry a 300-character snippet centred on the match; `get` returns the full
   field.
3. **Descriptions are searchable, as the lowest tier.** A match inside 32 KB of
   prose is much weaker evidence than a match on a name, and §7.3 reflects that.

This is still not RAG. Descriptions are never chunked, never embedded, and never
retrieved by semantic similarity. They are a text field on a record, found by
identifier or name, searched with Postgres full-text.

---

## 4. Tool Description Contract

`tool_description` is the only thing standing between a useful registry and a
polluted one. It must state, in the author's own words:

1. **What one entry represents.** "One funded grant or capital project."
2. **When to look up.** "Before writing any grant name or ID into a document."
3. **When to create.** "Only when the retrieved evidence clearly describes a
   grant that lookup did not find."
4. **When not to create.** "Never for a department, a vendor, or a line item."
5. **Naming convention.** "Use the grant's name as written in the adopted
   budget, without the year."
6. **What belongs in an entry description.** "Programme and awarding body,
   award amount and date, reporting obligations, spend deadline, and anything a
   future report about this grant would need to state correctly."

The UI should ship a starter template for this field. An empty or vague
description is the single most likely cause of a junk registry, and it should
be surfaced as a warning on the dataset, in the same spirit as template review
findings.

---

## 5. Database Structure

**Everything below lives in the configured Supabase Postgres database**, in a
migration under `supabase/migrations/` following the existing timestamp naming.
It is not settings data and does not belong in the settings service.

That is not a preference; the schema cannot live anywhere else. Every table
carries a foreign key to `tenants(id)` and the per-silo tables carry one to
`silos(id)`, the resolver in §8.1 joins assignment against those silos, and
lookup depends on `pg_trgm` and `tsvector` indexes. Referential integrity, RLS,
and index-backed search all require the rows to sit alongside the tables they
reference.

The settings service is a different kind of store for a different kind of data:
a collection/key/value record with a revision, reached over an internal Railway
address, built for configuration that must survive an encrypted backup and
restore. Federated Data is tenant row data with relational constraints, RLS, and
search indexes. Putting it there would give up every guarantee this
specification depends on.

```sql
-- The shared definition. No per-silo state lives here.
create table federated_datasets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  slug text not null,
  tool_name text not null,
  tool_description text not null default '',
  enabled boolean not null default true,
  id_prefix text not null default '',
  id_padding integer not null default 4 check (id_padding between 0 and 12),
  display_id_strategy text not null default 'mirror'
    check (display_id_strategy in ('mirror','prefixed','slug')),
  display_id_prefix text not null default '',
  model_can_write boolean not null default true,
  model_can_delete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, slug),
  unique (tenant_id, tool_name)
);

-- Assignment and per-silo state in one row. Deliberately never deleted when a
-- dataset is unassigned: `assigned` goes false, the row and every entry that
-- points at it survive, and re-assigning restores the silo's data untouched.
create table federated_dataset_silos (
  tenant_id uuid not null references tenants(id) on delete cascade,
  dataset_id uuid not null,
  silo_id uuid not null references silos(id) on delete cascade,
  assigned boolean not null default true,
  id_sequence bigint not null default 0,
  assigned_at timestamptz not null default now(),
  unassigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dataset_id, silo_id),
  foreign key (tenant_id, dataset_id)
    references federated_datasets(tenant_id, id) on delete cascade
);

create index federated_dataset_silos_silo_idx
  on federated_dataset_silos (tenant_id, silo_id, assigned);

-- Entries belong to a dataset *within one silo*. Every uniqueness constraint
-- and every query is scoped by (dataset_id, silo_id); nothing spans silos.
create table federated_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  dataset_id uuid not null,
  silo_id uuid not null,
  entry_id text not null,
  -- Monotonic within (dataset_id, silo_id), taken from the same counter that
  -- mints entry_id. Gives listing a stable secondary sort and gives pagination
  -- a snapshot boundary; see §7.4.1.
  entry_seq bigint not null,
  display_id text not null,
  normalized_display_id text not null,
  name text not null check (length(btrim(name)) > 0),
  normalized_name text not null,
  description text not null default ''
    check (octet_length(description) <= 32768),
  description_tsv tsvector generated always as (
    to_tsvector('english', coalesce(description, ''))
  ) stored,
  status text not null default 'active' check (status in ('active','retired')),
  created_source text not null default 'ui'
    check (created_source in ('ui','api','model')),
  created_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (dataset_id, silo_id)
    references federated_dataset_silos(dataset_id, silo_id) on delete cascade,
  unique (tenant_id, dataset_id, silo_id, entry_id),
  unique (tenant_id, dataset_id, silo_id, normalized_display_id)
);

-- There is deliberately no unique constraint on normalized_name. Two entries
-- may share a name; lookup reports them as ambiguous rather than the write
-- being rejected.
create index federated_entries_name_idx
  on federated_entries (tenant_id, dataset_id, silo_id, normalized_name, entry_seq);

-- Every string that should find an entry but is not its current display ID:
-- superseded display IDs, alternate names, and extra source codes. The internal
-- entry_id never changes, so it never needs an alias.
create table federated_entry_aliases (
  tenant_id uuid not null,
  dataset_id uuid not null,
  silo_id uuid not null,
  alias text not null,
  normalized_alias text not null,
  entry_uuid uuid not null references federated_entries(id) on delete cascade,
  kind text not null
    check (kind in ('former_display_id','alternate_name','source_code')),
  source_label text not null default '',
  created_source text not null default 'ui'
    check (created_source in ('ui','api','model')),
  created_run_id uuid,
  created_at timestamptz not null default now(),
  primary key (tenant_id, dataset_id, silo_id, kind, source_label, normalized_alias)
);

create index federated_entry_aliases_lookup_idx
  on federated_entry_aliases (tenant_id, dataset_id, silo_id, normalized_alias);
create index federated_entry_aliases_entry_idx
  on federated_entry_aliases (entry_uuid);

-- There is deliberately no audit-history table. An entry keeps only what it is
-- now: internal ID, display ID, name, description, and the provenance of its
-- creation. Before/after snapshots of a 32 KB description would dwarf the data
-- they describe, and nothing in the product reads them.

-- Tier 5 fuzzy name matching and tier 6 description search.
create extension if not exists pg_trgm;
create index federated_entries_name_trgm_idx
  on federated_entries using gin (normalized_name gin_trgm_ops);
create index federated_entries_description_fts_idx
  on federated_entries using gin (description_tsv);
```

`normalized_name` and `normalized_display_id` are lowercased,
whitespace-collapsed, and punctuation-stripped. Normalized display IDs are
unique within a silo's dataset; normalized names are indexed but not
constrained.

Every table takes RLS, tenant-consistency enforcement, the `service_role`
policy, and the `updated_at` trigger convention already used by the template
schema.

---

## 6. Identifiers

Every entry carries two identifiers with different owners and different rules.

| | Internal `entry_id` | Display `display_id` |
| --- | --- | --- |
| Owner | The system | The author, the API, or the model |
| Mutable | **Never** | Yes |
| Seen by the model | Yes — it is the addressing key | Yes — it is what goes in documents |
| Editable by the tool | **No** | Yes |
| Purpose | Stable handle for edits and joins | Recognition, federation, display |

The internal ID is the thing you edit *against*: every update, retire, and
alias operation addresses an entry by `entry_id`, and because that value can
never change, no operation can ever fail because the handle moved underneath
it. The display ID is the value a reader recognizes, and it is free-form
precisely so it can be corrected to a real grant number later.

### 6.1 The internal ID

`{prefix}-{counter zero-padded to id_padding}` → `GR-0001`, `GR-0002`.

Allocated by atomically incrementing
`federated_dataset_silos.id_sequence` for this dataset-and-silo pair inside the
insert transaction, so it is collision-free under concurrency by construction.
Each silo counts independently: silo A and silo B both begin at `GR-0001`.
It is opaque on purpose: it is never displayed and never edited, so there is
nothing to gain from making it readable and something to lose from making it
derived from a name that may change.

### 6.2 The display ID, when nobody supplies one

Most entries will be created without a known real-world code. `display_id` is
never left empty; the dataset's `display_id_strategy` decides what it starts as:

| Strategy   | Result for `GR-0007`, "Riverside Bridge Rehab"  |
| ---------- | ----------------------------------------------- |
| `mirror`   | `GR-0007` — identical to the internal ID        |
| `prefixed` | `TOWN-GR-0007` — internal ID behind a prefix     |
| `slug`     | `GR-RIVERSIDE-BRIDGE-REHAB`                      |

`mirror` is the default and is the behaviour you described: absent anything
better, the two IDs are the same value. The distinction still exists in the
schema, so the day that entry turns out to be state grant `DOT-4021`, the
display ID changes and the internal handle does not.

### 6.3 Supplying and correcting the display ID

A create call may supply `display_id` directly when the document already names
one:

```json
{"tool":"grant_registry","op":"add",
 "name":"Riverside Bridge Rehabilitation",
 "description":"FY26 state bridge grant, DOT program 4021.",
 "display_id":"DOT-4021"}
```

and an existing entry can be corrected later:

```json
{"tool":"grant_registry","op":"update_many","updates":[
  {"entry_id":"GR-0007","display_id":"DOT-4021"}
]}
```

The entry is addressed by its internal ID, which is why this is safe. **When a
display ID changes, the previous value is automatically written to
`federated_entry_aliases` as a `former_display_id`.** Reports generated before
the correction cited `GR-0007`; lookup keeps resolving that string to the same
entry forever. Nothing orphans.

Display IDs are unique within a dataset **in one silo**. If a create or update
collides with an existing display ID or alias there, the tool returns the
*existing* entry with `matched_existing: true` rather than erroring — a duplicate
code almost always means the model has rediscovered something rather than found
something new. Names carry no such constraint (§3.3).

### 6.4 Additional identifiers that are not the display ID

A grant can carry a state program number, a town budget code, and a vendor
contract number. Only one of those can be the display ID; the rest are still
worth matching on, so `link_alias` attaches them as lookup-only values with a
source label:

```json
{"tool":"grant_registry","op":"link_alias","entry_id":"GR-0007",
 "alias":"TOWN-CIP-88","source_label":"budget_book"}
```

Aliases are found by lookup and never displayed. `source_label` keeps `4021`
from the DOT and `4021` from the EPA distinct.

### 6.5 What the tool may and may not change

| Field         | Tool may edit |
| ------------- | ------------- |
| `entry_id`    | **No.** Rejected with an explicit error, never silently ignored. |
| `display_id`  | Yes           |
| `name`        | Yes           |
| `description` | Yes           |
| `status`      | Retire only, and only when `model_can_delete` is on |

A create call that includes `entry_id` is rejected rather than having the field
dropped: a model that believes it chose the internal handle must not be told it
succeeded.

Because the model sees both identifiers, every tool result must label them
unmistakably. Field names are `entry_id` and `display_id` everywhere, never a
bare `id`, and the tool description states plainly: *"`entry_id` is the internal
handle — use it to address edits, never change it, never print it in a document.
`display_id` is what goes in the document."* Two similarly-shaped strings on the
same object is exactly the situation where a model will reach for the wrong one.

## 7. The Dataset As A Tool

One dataset resolves to one tool named `tool_name`, with an `op` discriminator.
One tool rather than seven keeps the per-silo tool count equal to the dataset
count.

| `op`           | Purpose                                                      |
| -------------- | ------------------------------------------------------------ |
| `list`         | **Default read.** Identifiers and names only, no descriptions. §7.4.1 |
| `lookup`       | Batch resolve many names or IDs at once, with snippets. §7.2. |
| `get`          | Full entries *with* descriptions. Small batches only. §7.4.2 |
| `add`          | Create one entry.                                            |
| `add_many`     | Create up to 100 entries in one call.                        |
| `update_many`  | Edit `entry_id`, `name`, or `description` for N entries.     |
| `retire_many`  | Soft-remove N entries.                                       |
| `link_alias`   | Attach a lookup-only code or alternate name to an entry.      |

### 7.1 How the three reads relate

A model resolving a value has three ways in, and they are not interchangeable.

| Registry size          | What to reach for                                          |
| ---------------------- | ----------------------------------------------------------- |
| Up to ~2,000 entries   | `list` once. Identifiers and names for everything, and usually enough to decide. |
| Larger                 | `lookup`, which resolves up to 25 names or codes per call and ranks candidates. |
| Either, once decided   | `get`, for the descriptions of the few entries that matter.  |

`list` being the default is what keeps the common case simple: for most
registries the model sees the whole vocabulary in one cheap call and never needs
to search at all. `lookup` exists because that stops scaling, and because
matching a name written slightly differently is a judgement the server can make
better than the model scanning a list. Neither returns a description; that is
always `get`, always by explicit identifier.

### 7.2 Batch lookup

One call resolves many names, because a report listing ten grants should cost
one round trip rather than ten:

```json
{"tool":"grant_registry","op":"lookup",
 "queries":[
   {"key":"row1","name":"Riverside Bridge"},
   {"key":"row2","name":"Main St Resurfacing FY26"},
   {"key":"row3","id":"DOT-4021"},
   {"key":"row4","name":"Sewer Lining Program","description_hint":"EPA revolving fund"}
 ],
 "limit_per_query":3}
```

`key` is echoed back so the model can align results to its own rows without
relying on array order. `id` matches internal ID, display ID, or any alias.
Up to 25 queries per call.

The response answers each query separately and never merges them:

```json
{"results":[
  {"key":"row1","status":"matched","candidates":[
    {"entry_id":"GR-0007","display_id":"DOT-4021",
      "name":"Riverside Bridge Rehabilitation",
      "snippet":"…FY26 state bridge grant, DOT programme 4021…",
      "match_kind":"name_contains","confidence":0.82}
  ]},
  {"key":"row3","status":"exact","candidates":[…]},
  {"key":"row4","status":"ambiguous","candidates":[…two near-equal…]},
  {"key":"row2","status":"none","candidates":[]}
]}
```

`status` is the model-facing judgement, and it exists so the model is not left
comparing floats:

| `status`    | Meaning                                          | Expected behaviour              |
| ----------- | ------------------------------------------------ | ------------------------------- |
| `exact`     | Identifier or exact normalized name matched      | Use it. Do not create.          |
| `matched`   | One clear leading candidate                      | Use it unless the description contradicts. |
| `ambiguous` | Top candidates within a narrow confidence band   | **Do not guess.** Disambiguate from descriptions, or report the conflict. Never create. |
| `none`      | Nothing above the floor                          | Create, if the evidence supports it. |

`ambiguous` is the important one. Without it a model handed two candidates at
0.79 and 0.81 will pick the higher and be silently wrong half the time.

### 7.3 Matching tiers

Deterministic, no embeddings. Tried in order; the first tier that produces hits
determines `match_kind` and the confidence band.

| Tier | Match                                                       | Confidence |
| ---- | ----------------------------------------------------------- | ---------- |
| 1    | Internal ID, display ID, or alias, exact                    | 1.00       |
| 2    | Exact normalized name                                        | 0.95       |
| 3    | Normalized name after noise-token removal                    | 0.85       |
| 4    | Full token containment, e.g. "Riverside Bridge" ⊂ "Riverside Bridge Rehabilitation" | 0.80 |
| 5    | Trigram similarity on name (`pg_trgm`), above 0.45          | 0.45–0.75  |
| 6    | Full-text match in description                               | 0.30–0.50  |

Normalization lowercases, strips punctuation, and collapses whitespace. Noise
removal additionally drops a configurable per-dataset token list — for a grant
registry, words like `grant`, `program`, `programme`, `project`, `fund`,
`initiative`, and bare fiscal years, which appear in most entries and carry no
discriminating signal. Without that, "Riverside Bridge Grant" and "Main Street
Grant" look more alike than they are.

Tier 6 only runs when tiers 1–5 return nothing for that query, and only ever
contributes candidates below the `matched` threshold: a hit inside a 32 KB
description is a hint worth surfacing, not an identification.

### 7.4 Two ways to read

Descriptions are the expensive part of an entry and almost never the part being
searched for. So reading is split, and the cheap one is the default.

#### 7.4.1 `list` — the default read

Identifiers and names, nothing else:

```json
{"tool":"grant_registry","op":"list","page":1,"page_size":1000}
```

```json
{"entries":[
   {"entry_id":"GR-0001","display_id":"DOT-4021","name":"Riverside Bridge Rehabilitation"},
   {"entry_id":"GR-0002","display_id":"GR-0002","name":"Main Street Resurfacing"}
 ],
 "page":1, "page_size":1000, "returned":1000,
 "total_entries":10000, "total_pages":10,
 "pages_remaining":9, "has_more":true, "next_page":2,
 "snapshot":48213}
```

`page_size` defaults to 1,000 and caps at 2,000. `page` defaults to 1. Ordered
by name, with `entry_seq` as tiebreak so the order is total and never arbitrary.

Continuing is a matter of asking for the next page and echoing the snapshot
back:

```json
{"tool":"grant_registry","op":"list","page":2,"snapshot":48213}
```

which returns entries 1,001–2,000 and reports `pages_remaining: 8`.

**Why the snapshot exists.** Page numbers over a plain offset are unstable when
the collection is written to between calls, and here the model doing the reading
is usually also the one writing. A model that lists page 1, registers three
grants it did not find, and then asks for page 2 would silently skip three
entries with a naive offset.

`snapshot` is the highest `entry_seq` at the moment the first page was built.
Later pages filter to `entry_seq <= snapshot`, so the paged set is exactly the
registry as it stood when enumeration began. Entries created mid-enumeration are
simply not in it; they will be there next time. The model does not have to
understand any of this — it echoes the value back and gets coherent pages.

Deletions during enumeration still shift boundaries, which is why
`total_entries` and `total_pages` are recomputed on every call rather than
carried in the token: a count that moves is visible rather than silently stale.

Omitting `snapshot` starts a fresh enumeration at the current state.

**On enumerating at all.** A 10,000-entry registry is ten calls and roughly a
megabyte of context, and the tool description should say plainly that this is
rarely the right approach — `lookup` resolves 25 names in one call without
moving the other 9,975 entries. Full enumeration is supported because an
operator may genuinely ask for it, not because a model should reach for it.

#### 7.4.2 `get` — descriptions, on request

```json
{"tool":"grant_registry","op":"get","ids":["GR-0007","DOT-4021"]}
```

Accepts internal IDs, display IDs, or aliases, and returns the full record
including the description. Up to **100 per call**, additionally bounded by a
total byte budget: entries come back in request order until the budget is spent.

Paging uses the same `page` / `pages_remaining` shape as `list`, so the model
learns one convention rather than two. There is no snapshot here — `get` works
from an explicit list of identifiers the caller supplied, so nothing can shift
underneath it.

The asymmetry between 2,000 and 100 is the point. Descriptions are read for a
handful of entries the model has already identified, never swept. A model paging
through `get` has skipped a step — it should have narrowed with `list` or
`lookup` first.

### 7.5 Write shapes

```json
{"tool":"grant_registry","op":"add",
 "name":"Riverside Bridge Rehabilitation",
 "description":"FY26 state bridge grant, DOT program 4021.",
 "display_id":"DOT-4021"}
```

`display_id` is optional; omitted, it is generated per §6.2.

```json
{"tool":"grant_registry","op":"add_many","entries":[
  {"name":"…","description":"…"},
  {"name":"…","description":"…","display_id":"DOT-4021"}
]}
```

Edits address the entry by its immutable internal ID and may change the display
ID, the name, and the description — nothing else:

```json
{"tool":"grant_registry","op":"update_many","updates":[
  {"entry_id":"GR-0003","name":"Riverside Bridge Rehabilitation"},
  {"entry_id":"GR-0007","display_id":"DOT-4021"}
]}
```

An existing entry gains a newly discovered code without changing what it
displays:

```json
{"tool":"grant_registry","op":"link_alias","entry_id":"GR-0003",
 "alias":"TOWN-CIP-88","source_label":"budget_book"}
```

Editing defaults to the multi form as you asked; a single edit is a one-element
array. Every write returns the full resulting entries so the model never has to
guess what the server assigned.

### 7.6 Partial success

`add_many` and `update_many` are **not** transactional across items. Each item
succeeds or fails independently and the response reports both lists with a
reason per failure. An all-or-nothing batch would make one bad name discard
nineteen good ones, and the model's most likely recovery — retry the whole
batch — would then double-write.

### 7.7 What implementation settled

Four things were decided while building this that the design above did not
specify, and each changes behaviour the model can see.

**A seventh tier, below description.** Tiers 1 to 6 as designed return nothing
at all for a query that shares some but not enough with every entry. "Riverside
Sewer Widening" against a registry holding "Riverside Bridge Rehabilitation" and
"Sewer Lining Program" produced an empty result, which reads as *there is no
such entry* and sends the model straight to `add`. But "there is no such entry"
and "nothing matched well" call for opposite actions, and collapsing them is the
most expensive mistake lookup can make. Tier 7 returns partial word overlap at
0.15 to 0.35, labelled `name_weak`, and only when nothing above the floor
exists. The status is still `none`; the candidates are there to be ruled out.

**Tier 5 gained a second signal.** Trigram similarity alone misses abbreviation:
"Bridge Rehab" scores poorly against "Riverside Bridge Rehabilitation" on
characters while matching it perfectly on words. Tier 5 now fires on whichever
of trigram similarity or query-word coverage is higher. Coverage is asymmetric
by design — it measures how much of the *query* is present in the entry, so
extra words in a longer entry name are not evidence against it. Word matching
allows a four-character prefix in either direction, which is what bridges
"rehab" to "rehabilitation".

**`ambiguous` is tested before `exact`.** Names are deliberately not unique
(§3.3), so two entries can both match a name perfectly. That is precisely the
case where a confident `exact` does the most damage, so equal-confidence
candidates are reported ambiguous even when the tier that produced them is an
exact one.

**A model-level failure is a result, not an exception.** The tool returns
`{"ok": false, "error": {...}}` for an unknown op, a missing name, a write to a
read-only registry, or a field the tool does not own. The surrounding model loop
treats a thrown error from a non-DOCX tool as fatal to the entire run, and a
mistyped argument is not worth losing an Ask over — the model can read the
failure and correct itself. Only database failures propagate.

Two implementation notes that are not model-visible but are load-bearing. The
lookup function narrows candidates with index-friendly predicates before it
scores anything, because tokenizing every row of a ten-thousand-entry registry
costs seconds and one `lookup` call carries twenty-five queries. And because
confidence is banded, once tiers 1 to 4 have produced enough rows to fill the
requested limit, the fuzzy tiers cannot change the answer and are skipped
entirely. Together those took the worst measured case from 2.4 s to 0.4 s. The
pre-filter is a deliberate superset of every tier: adding a tier without adding
a matching branch to it would silently stop that tier ever firing.

---

## 8. Silo Assignment And Tool Resolution

### 8.1 Resolution

```sql
create or replace function resolve_federated_dataset_tools(
  p_tenant_id uuid, p_silo_id uuid
) returns table (
  dataset_id uuid, tool_name text, display_name text,
  description text, entry_count bigint
) …
```

Resolved tools are injected at the same two points that already receive
Template Group tools:

- `apps/web/src/lib/ask-runs.ts` — Ask
- `apps/web/src/app/api/extraction-tool/route.ts` — Extraction and Task runs

A dataset resolves when it is `enabled` and its `federated_dataset_silos` row
for this silo has `assigned = true`. Unlike Template Groups, an **empty dataset
still resolves** — a registry with no entries is exactly when the model most
needs to add the first one.

Every read and write the tool performs is implicitly scoped to the calling run's
silo. The model never supplies a silo, never sees one, and cannot reach another
silo's entries through any operation.

### 8.2 Unassigning never destroys data

Removing a dataset from a silo sets `assigned = false` and stamps
`unassigned_at`. It does not delete the `federated_dataset_silos` row and does
not touch a single entry. The tool stops resolving; the data sits still.

Re-assigning sets `assigned = true` and the silo's entries, aliases, and ID
counter are all exactly as they were. The next entry created continues
the old sequence rather than restarting at `GR-0001`.

This is why assignment state is a column rather than row existence. A join table
whose rows are deleted on unassign would lose the sequence position even if the
entries were kept, and re-assignment would then mint IDs that collide with
retained ones.

Deleting the entries is a separate, explicit operation — the **clear** action in
§10.3 and §11 — and it is never a side effect of unassignment.

### 8.2.1 Deleting the dataset itself is total, and that is deliberate

Unassignment is soft. **Deleting the dataset definition is not.** It removes the
definition, every silo's assignment row, every entry in every silo, and every
alias, in one cascade. There is no `deleted_at`, no retained shell, and no
recovery.

This is the opposite treatment from unassignment, on purpose. An unassigned
dataset is one an operator may want back; a deleted one is a concept being
retired, and leaving its per-silo data behind would produce exactly the orphan
records this design refuses to accumulate — rows referencing a tool that no
longer exists, invisible in every screen, still occupying the tenant.

Consequently the delete confirmation must state the total, not the abstraction:
*"Delete Grant Registry? This removes 1,240 entries across 3 silos. This cannot
be undone."* Counting before asking is the whole safeguard.

The `on delete cascade` chain in §5 already implements this
(`federated_datasets` → `federated_dataset_silos` → `federated_entries` →
`federated_entry_aliases`); it is called out here because a cascade that
destructive should be a stated decision rather than a schema side effect.

### 8.3 The same ID string in two silos

Because each silo counts independently, `GR-0001` exists in every silo that uses
the dataset, pointing at unrelated things. Inside the product that is harmless:
no query, tool call, or lookup ever spans silos.

It becomes worth thinking about only when documents from two silos are compared
by a human outside the system. If that is a real workflow, set
`display_id_strategy` to `prefixed` with a per-silo prefix so the printed IDs
differ. That is a configuration choice, not a schema one, and it can be made
later per dataset.

### 8.4 Tool budget

Every assigned dataset adds a tool and its description to every model call in
that silo. A soft warning appears in the UI past **10 datasets per silo**; there
is no hard limit. Resolved tools are ordered by name for prompt stability.

---

## 9. Safety, Concurrency, And Provenance

### 9.1 Concurrency

Creation runs inside one transaction: allocate the internal ID by incrementing
`federated_dataset_silos.id_sequence` for this pair, insert, and let the
display-ID uniqueness constraint arbitrate. A collision on display ID returns the
*existing* entry with `created: false` rather than an error — the model asked for
an entry to exist, and it does.

Names are not constrained, so two runs adding "Riverside Bridge" at the same
moment will produce two entries. That is the accepted cost of allowing duplicate
names (§3.3): the defence is that the model is told to look up first, and that
near-duplicates surface as `ambiguous` on the next lookup so a human or a later
run can merge them. Uniqueness enforcement would trade this occasional duplicate
for rejected legitimate entries, which is the worse failure.

### 9.2 Model writes are the risk

A model with write access to a shared registry can pollute it faster than a
person can clean it. Mitigations, in order of importance:

1. `model_can_delete` defaults **off**. Retire is not delete; retired entries
   still resolve for `get`.
2. Every entry records `created_source` and `created_run_id`, so the entries a
   bad run produced can be listed and removed together. That is the one
   capability the absent history table would otherwise have provided, and it is
   kept because it costs two columns rather than a second copy of every
   description.
3. `created_source = 'model'` is visible in the UI, filterable, and the Federated
   Data screen should default to showing model-created entries first for review.
4. `model_can_write = false` makes a dataset strictly read-only — the right
   setting for a registry maintained from an external system of record.

A refused write is an **explicit error to the model**, never a silent no-op and
never an empty success:

```json
{"ok":false,"error":"write_denied",
 "message":"This dataset is read-only. The entry was not created and no ID was assigned.
            Do not invent one; report the value as unresolved."}
```

The message has to say that no ID was assigned, because the failure mode worth
preventing is a model that treats a failed create as licence to make an
identifier up. The same shape covers a refused `retire_many` when
`model_can_delete` is off.

There is no human approval step. An entry the model creates is immediately
lookupable, because the model must be able to use an ID it just minted within
the same run.

### 9.3 Correcting a display ID without orphaning documents

The internal ID never changes, so the classic hazard — an edit that invalidates
a handle other rows point at — cannot occur. What can change is the display ID,
and that is the value already printed into last month's report.

So a `display_id` change is a rename with an alias trail: the previous value is
written to `federated_entry_aliases` as `former_display_id`, and lookup resolves
it transparently forever. A reader following `GR-0007` from an old report lands
on the same entry that now displays `DOT-4021`. The UI lists former display IDs
on the entry so the history is visible rather than implied.

The alias trail is not an audit log. It stores one short string per rename and
exists so a reference resolves, not so anyone can review what changed. That is
why it survives the decision to keep no history: dropping it would mean a
corrected display ID silently orphans every document that already cited the old
one, which is the opposite of what display-ID editing is for.

Hard deletion of a single entry remains a UI operation, and warns when the entry
has aliases.

## 10. User Interface

`/federated-data`, laid out like Templates, with three tabs.

### 10.1 Federated Data

The landing tab. A left rail lists every federated dataset in the tenant by
name; selecting one opens it, and a **New** action creates one.

A dataset is three fields:

| Field           | Notes                                                        |
| --------------- | ------------------------------------------------------------ |
| Name            | Human label, e.g. "Grant Registry".                           |
| Model tool name | Validated to the tool-name charset, unique per tenant.        |
| Description     | The model-facing description. See §4.                         |

The description is the field most likely to be written badly and the one that
most determines whether the registry stays clean, so it gets an **Insert
example** button that drops a filled-in template into the editor — the six-point
structure from §4, written out for a grant registry, ready to be edited rather
than composed from nothing.

Editing an existing dataset uses the same form. Changing the tool name or
description takes effect on the next run in every silo the dataset is assigned
to; it does not touch any entry.

### 10.2 Federated Data Assigned to Silos

The same shape as the Templates assignment tab: datasets on the left, and for
the selected one, the silos it is assigned to.

Unassigning warns plainly that the silo's entries are **retained, not deleted**,
and that re-assigning restores them. This is the one place an operator might
expect destruction and must not get it.

### 10.3 Edit Federated Data

Where the data itself is managed.

1. A silo dropdown at the top.
2. The datasets assigned to that silo.
3. For the selected dataset, a left-hand list of its entries showing internal
   ID, display ID, and name.
4. Selecting an entry shows its description and full detail on the right.

Everything is editable except the internal ID, which is displayed read-only with
a short note explaining that it is the stable handle and that the display ID is
the value documents print. Editing a display ID warns that the previous value
is kept as a lookup alias, so older documents keep resolving.

Deletion works at three scales: one entry, a multi-select of entries, and
**clear all entries in this dataset for this silo**. The clear action names the
silo and the dataset in its confirmation and reports the row count, because it
is irreversible: with no history table, deleted entries are gone.

#### Reading a registry that has grown

Four controls, and each exists because of a specific way this screen was
misleading without it.

- **Search** matches name, display ID, and internal ID. It applies on Enter
  rather than on every keystroke, so a ten-thousand-entry registry is queried
  once per search instead of once per letter.
- **Status** filters active, retired, or both. Retired is the important one:
  a retired entry is invisible to the model and looked identical to an active
  one here, which is a long way to spend wondering why the registry tool cannot
  find something that is plainly on the screen.
- **Written by** filters to the model, the API, or a person. This is the
  filter §9.2 depends on — combined with **show everything this run wrote** on
  an entry's detail, it is how the entries one bad run produced are found and
  removed together.
- **Order** offers name, newest first, and model-written first. Every ordering
  ends on `entry_seq`, because a partial order over a paged list drops and
  repeats rows between pages and the reader cannot tell that happened. Sorting
  by provenance needs a stored rank rather than `created_source` itself, which
  sorts alphabetically to api, model, ui and buries the rows being reviewed in
  the middle.

Any change to a filter returns to page 1. Page 4 of a filtered registry is not
page 4 of an unfiltered one, and showing an empty page reads as "nothing
matched" when the matches are on page 1.

#### Status and aliases on an entry

An entry's detail states whether it is active or retired in the terms that
matter — whether the registry tool will offer it — and retiring is reversible
from the same place. Retiring is the only edit whose effect is total for the
model and invisible on this screen, so it cannot be a one-way door here.

The detail also lists every alias resolving to the entry, with its kind and
source label. These never appear in a generated document, which is exactly why
they need somewhere to be visible: a former display ID is the only thing
keeping last month's report resolving, and nothing else on screen says so.
That also makes the delete warning honest — deleting an entry destroys its
aliases, so the confirmation counts the references that will stop resolving
rather than describing the loss in the abstract. Entries with no aliases delete
without the extra step; friction where it is not earned is just ceremony.

---

## 11. Public API Shape

Scoped to what is needed now. Entry-level curation is a UI concern for this
pass; the API covers creating datasets, discovering them, assigning them, and
clearing a silo's data.

Scopes follow the template precedent: `federated:read`, `federated:write`, and
`federated:grant`, with `federated:grant` excluded from
`DEFAULT_API_KEY_SCOPES`.

| Method   | Path                                                       | Scope             | Idem. |
| -------- | ---------------------------------------------------------- | ----------------- | ----- |
| `GET`    | `/api/v1/federated-datasets`                               | `federated:read`  | No    |
| `POST`   | `/api/v1/federated-datasets`                               | `federated:write` | Yes   |
| `GET`    | `/api/v1/federated-datasets/{id}`                          | `federated:read`  | No    |
| `PATCH`  | `/api/v1/federated-datasets/{id}`                          | `federated:write` | Yes   |
| `DELETE` | `/api/v1/federated-datasets/{id}`                          | `federated:write` | Yes   |
| `GET`    | `/api/v1/federated-datasets/{id}/silos`                    | `federated:grant` | No    |
| `PUT`    | `/api/v1/federated-datasets/{id}/silos`                    | `federated:grant` | Yes   |
| `DELETE` | `/api/v1/federated-datasets/{id}/silos/{siloId}`           | `federated:grant` | Yes   |
| `DELETE` | `/api/v1/federated-datasets/{id}/silos/{siloId}/entries`   | `federated:write` | Yes   |
| `GET`    | `/api/v1/silos/{siloId}/federated-datasets`                | `federated:read`  | No    |

**`POST /api/v1/federated-datasets`** creates a dataset from the three fields
the UI collects:

```json
{"name":"Grant Registry","toolName":"grant_registry",
 "toolDescription":"One funded grant or capital project. Look up before …"}
```

**`GET /api/v1/federated-datasets`** is the list-everything-to-get-the-ID call,
paginated, returning each dataset's `id`, name, tool name, description, enabled
state, and assigned silo count.

**`PUT .../silos`** replaces the assignment list wholesale, with the same
omitted-means-removed footgun as the Template Group route — except that here
removal is the soft unassignment of §8.2, so omitting a silo stops the tool
resolving without touching data.

**`DELETE .../silos/{siloId}`** unassigns one silo. Also non-destructive.

**`DELETE /api/v1/federated-datasets/{id}`** destroys the definition and every
silo's data with it (§8.2.1). It returns the entry and silo counts it removed so
a caller can log what was lost.

**`DELETE .../silos/{siloId}/entries`** is the narrower destructive one: it
clears one silo's entries for that dataset. It is deliberately a different path from
unassignment so the two can never be confused, requires `federated:write`
rather than `federated:grant`, and returns the number of entries removed.

`GET /api/v1/silos/{siloId}/federated-datasets` is the silo-centric view that
Template Groups currently lack; adding it here from the start avoids repeating
that gap.

Entry create, edit, retire, and alias operations are intentionally absent. The
model performs those through its tool and operators through §10.3. They can be
added later without disturbing anything above.

---

## 12. Interaction With Templates

The two subsystems compose. A template comment can name the registry:

```text
{{Grant ID}}
Word comment:
Look up the grant in the grant registry before writing this. Use the entry_id
exactly as returned. If the grant is not in the registry, add it and use the
returned ID.
type: text
required: true
```

The model calls the `grant_registry` tool during the same run in which it fills
the template, and the ID it writes into the document is the same one the next
month's report will find. Federated Data is what makes a repeating template
produce joinable output rather than a fresh vocabulary every month.

---

## 13. Decisions Taken

Settled 2026-08-18. Recorded with their reasoning so the next reader does not
relitigate them.

| # | Decision | Outcome |
| - | -------- | ------- |
| D1 | Entry scope | **Per silo.** The definition is shared; the data is not. Two silos using one dataset have independent entries and independent ID counters. |
| D2 | Configurable uniqueness | **Dropped.** Superseded by the internal/display split. Display IDs are always unique within a silo; names are never unique. |
| D3 | Default `display_id_strategy` | **`mirror`.** Display ID equals the internal ID until something better is known. |
| D4 | Approval for model-created entries | **None.** A model must be able to use an ID it just minted in the same run. |
| D5 | Tool-count cap | **Soft warning at 10 per silo**, no hard limit. Expected real usage is two or three. |
| D6 | Bare code with no name | **Rejected.** A name is mandatory. An entry named after a code is unrecognizable later. |
| D7 | Model visibility of the internal ID | **Visible, and used to address edits.** Tool output must label `entry_id` and `display_id` unmistakably. |
| D8 | `noise_tokens` curation | **Deferred.** Ships with a built-in default list, not operator-editable in the first pass. |
| D9 | Deleting a dataset definition | **Total cascade.** Definition, assignments, entries in every silo, and aliases all go. No soft delete, no orphans, no recovery. |
| D10 | Bulk import of an existing registry | **Not built.** Seed a registry by running an Ask against a source document already in the silo and letting the model write the entries through the tool. |
| D11 | Change history | **None retained.** No audit table. An entry keeps only what it is now, plus the provenance of its creation. |
| D12 | A write the model is not permitted to make | **Explicit error**, stating that no ID was assigned and that the model must not invent one. |
| D13 | How entries are read | **Two operations, both paged by page number.** `list` is the default and returns identifiers and names only — 1,000 per page by default, 2,000 maximum. `get` returns full descriptions, 100 per page with a byte budget. Descriptions are never returned incidentally. |
| D15 | Pagination style | **Page numbers, with a snapshot token.** Responses report `page`, `total_pages`, and `pages_remaining` because a model reasons about those and cannot reason about a cursor. The snapshot pins the enumeration to the registry as it stood at page 1, so a model that writes between pages does not skip rows. |
| D14 | Seeding a newly assigned silo | **Never.** A dataset added to a silo starts empty. |

### Consequences worth remembering

D1 and D5 interact: because data is per silo and unassignment is soft, a silo
that loses a dataset keeps its entries and its sequence position, and getting
the dataset back restores everything. Destroying that data requires the explicit
clear action in §10.3 and §11.

D6 and the no-uniqueness rule on names pull against each other by design. Names
are required so entries stay recognizable, and unconstrained so real duplicates
are representable. The tension is resolved at lookup, not at write: §7.2's
`ambiguous` status is what stops the model guessing between two similar names.

D9 and D5 are deliberately opposite and the UI must make the difference
obvious. Unassigning is reversible and touches no data; deleting is total. They
sit on different screens, use different verbs, and the delete confirmation
counts the rows it will destroy before asking.

D10 is worth restating because it is easy to read as a gap. There is no importer
because there does not need to be one: point an Ask run at a grant schedule
already in the silo and instruct it to register every grant it finds. The write
tools that exist for incidental discovery are the same ones that bootstrap the
registry, which also means the bootstrap run exercises exactly the path
production will use.

D15 pairs with D1: because entries are per silo, a page number means the same
thing on every call within a run, and the snapshot only ever has to pin one
silo's data.

D11 removes the ability to review what an entry used to say. The alias trail in
§9.3 survives that decision because it is a resolution mechanism rather than a
record — without it, correcting a display ID would orphan every document that
cited the old value.

### Still to design

Nothing blocks implementation. Two areas are deliberately unspecified and will
be settled once the section exists and has real data in it:

- **Noise-token curation (D8).** Whether this ever becomes operator-facing
  depends on how badly the built-in list performs on real registries.

Settled since: **how entries are presented at scale in §10.3**. Search, status,
provenance, and ordering are specified above, along with why each exists.

---

## 14. Boundary

Explicitly out of scope for the first implementation:

- Embedding or vector search over entries. Deterministic lookup only, even
  though descriptions are large: Postgres full-text, never a vector.
- Fields beyond id / name / description / external IDs. No custom columns, no
  typed attributes, no relationships between entries.
- Cross-dataset references.
- Importing from an external system of record, on a schedule or otherwise.
- Seeding a newly assigned silo from another silo's entries.
- Any audit history of what an entry previously contained.
- Automatic reconciliation of near-duplicate entries. Detection is surfaced;
  merging is manual.

Each of these is a plausible second pass. None should block the first.
