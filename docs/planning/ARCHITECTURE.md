# NodeRag — Architecture Plan

**A self-contained RAG database for Synology DSM 7, packaged as a single `.spk`.**

| | |
|---|---|
| Status | Draft v0.1 — design only, nothing built |
| Date | 2026-09-03 |
| Target | Synology DSM 7.2+, x86_64, 8 GB+ RAM (Ryzen R1600 / V1500B / Atom C3538 class) |
| Runtime | Node.js 22 (Synology `Node.js_v22` Package Center package) |
| Store | PostgreSQL 17 + pgvector, **bundled inside our own SPK** |
| Embeddings | Qwen3-Embedding-0.6B, ONNX, **on-device CPU only** |
| Documents | `.txt` `.md` `.docx` `.pdf` `.xlsx` → page-scoped Markdown |
| Chunking | 2 000 chars / 300 overlap — system-wide, adjustable, rebuildable |
| Silos | Access control only: `read` / `upload` per principal |
| Vision | Remote Ollama VLM for images, tables and figures |
| Install UX | One `.spk`, DSM volume picker at install, web setup wizard on a port |

---

## 0. Decisions locked for this draft

These came out of the planning conversation and everything below assumes them:

1. **Primary target is an x86_64 NAS with 8 GB+ RAM.** aarch64 (DS223/DS423 class) is explicitly out of scope for v1 — see §17.1 for what it would cost to add later.
2. **PostgreSQL ships inside our SPK.** No dependency on the SynoCommunity PostgreSQL package, no Container Manager. One package, one install.
3. **Embedding runs locally on the NAS CPU.** No external endpoint in v1. This is the biggest performance constraint in the whole design — see §9.5.
4. **Silos, users and API keys from the start.** One database holds N isolated **silos** — bodies of documents with their own access lists, so one person's legal files and another's personal files stay separate. Users and API keys are the same kind of thing (a *principal*) and are granted `read` or `upload` per silo. `silo_id` is a partition key and cannot be retrofitted cheaply, which is why it is in migration 1 (§6).
   *This supersedes the earlier database-per-instance design: a user who needs access to more than one silo cannot be served by separate databases.*
5. **Five input formats, one canonical form.** `.txt`, `.md`, `.docx`, `.pdf` and `.xlsx` in; page-scoped **Markdown** out. One Excel sheet is one page (§10.8). Page numbers are carried for PDF, DOCX and XLSX, honestly labelled by how they were derived (§10.1). Nothing else is accepted in v1.
6. **Images go off-box to an Ollama vision model.** Tables and figures embedded as images become Markdown in the document body, so they are searchable text. This is the one component that needs a machine other than the NAS (§12).
7. **The web UI is a client of the public REST API and nothing else.** Full parity is a design rule, not a goal (§14).
8. **Chunking is character-based**, not token-based: 2 000 characters with 300 overlap by default, adjustable per silo within enforced limits, with a token ceiling as a guard. Boundaries stop depending on the tokenizer, so swapping embedding models re-embeds the same chunks instead of re-cutting the corpus (§11).
9. **Every chunk records both locators.** A page *range* (`page_start`…`page_end`, since chunks flow across page breaks) and a document-level character range (`char_start`…`char_end`). The character range is the one that always works — it is the only locator a `.txt` or `.md` file has (§11.6).
10. **v1.0 is the full system.** Silos, users, API keys, grants, sessions, audit and gateways all ship in 1.0 — nothing deferred, nothing retrofitted. The trade accepted with this: the longest path to something usable, so §18's milestones are ordered to produce a working vertical slice early rather than finishing layers in sequence.
11. **Distribution is manual `.spk` install.** No package repository, no SynoCommunity submission, no auto-update. The spksrc layout stays upstream-compatible so a repo remains possible later, but nothing is designed around it.
12. **Private / internal.** Not open source. Every bundled component — PostgreSQL, pgvector, ONNX Runtime — permits redistribution in a closed product, but dependency licences are catalogued from the first commit so that stays true.
13. **Silos are access control only.** Chunk size, overlap, embedding model, CPU threads, vision settings and search defaults are all **system-wide** (§7.8). A silo has a name, a description and a list of who can read it and who can upload to it (§6).
14. **Two permissions per silo: `read` and `upload`.** `read` searches and retrieves; `upload` adds, re-indexes and deletes. A `server_admin` flag covers everything that isn't silo-scoped. API keys can be narrowed below `read` to search-only (§6.3).
15. **Delete always purges.** The document, its pages, its chunks and vectors, its original file, its Markdown file, and every cache row reachable only from it. No soft delete, no recycle bin (§7.6).
16. **Re-chunking and re-embedding are first-class.** A *build* is one chunk profile plus one embedding model; changing either populates staging partitions in the background and swaps them in, so search never goes down (§7.5).
17. **This document is the deliverable.** Implementation strategy lives in `IMPLEMENTATION.md`.

---

## 1. Three DSM 7 realities that shape everything

Before the architecture, three constraints that are non-negotiable on DSM 7 and that quietly rewrite parts of the original brief.

### 1.1 You cannot choose the user the service runs as

DSM 7 removed `run-as system` and `run-as root` for third-party packages. Every package must ship `conf/privilege` declaring `"run-as": "package"`, and DSM creates a *system internal user* for it (`NodeRag`, or `sc-noderag` if built through the SynoCommunity toolchain). That account is what the service runs as, always.

So the setup wizard **cannot** offer "run as user X." What it can — and should — offer instead is **which shared folders NodeRag is allowed to read**, which is the thing the original requirement was actually reaching for. Two mechanisms:

- `conf/resource` → `data-share`: the package declares shared folders it needs and DSM grants the package user access at install time.
- Control Panel → Shared Folder → Permissions → *System internal user*: the admin ticks `NodeRag` on whichever folders they want indexed, after install. File Station's Properties dialog does the same per-folder, recursively.

This is strictly better than a run-as setting: permissions are visible and revocable in the DSM UI, and they survive package upgrades.

**One convenient side effect:** PostgreSQL refuses to run as root anyway. Running as a dedicated package user is exactly what it wants.

### 1.2 The volume picker is free, the *data* location is not

DSM's Package Center already asks which volume to install to when more than one exists, and lays the package out as:

```
/var/packages/NodeRag/target  ->  /volumeX/@appstore/NodeRag    binaries, node app, ONNX model
/var/packages/NodeRag/var     ->  /volumeX/@appdata/NodeRag     PGDATA, model cache, logs
/var/packages/NodeRag/etc     ->  /volumeX/@appconf/NodeRag     config
/var/packages/NodeRag/home    ->  /volumeX/@apphome/NodeRag     0700 private
```

That covers "the user picks the storage drive" for free — but it ties the *database* to the same volume as the binaries. For a RAG corpus that may reach tens of GB, that is often wrong: people want the app on the fast SSD volume and the data on the big HDD volume.

**Design:** treat the DSM-chosen volume as the default, then let the setup wizard place the *bulk* of the data wherever the user wants — including on an ordinary shared folder. The mechanism is a PostgreSQL tablespace for the large tables and indexes plus plain relocation for the model and extraction caches, while PGDATA itself stays somewhere with clean POSIX permissions. §5 works this through, including the four ways a shared folder can bite and the probe the wizard runs to catch them.

> **Phase 0 spike:** confirm exactly what triggers Package Center's volume selector on DSM 7.2/7.3, and run the §5.4 permission probe against a real ACL-enabled shared folder. Do not build on assumption here.

### 1.3 Native modules must match Synology's Node

Depending on Synology's official `Node.js_v22` package (rather than bundling our own Node build) is the right call for install simplicity — it's in the stock Package Center, no third-party repo to add. The cost is that our native modules must load against *their* Node binary and *DSM's* glibc/libstdc++.

We get lucky here: both critical native modules use **Node-API**, which is ABI-stable across Node majors.

- `onnxruntime-node` — N-API, ships prebuilt `linux-x64` binaries
- `better-sqlite3` (if used at all) — N-API

The residual risk is not the Node ABI, it's the **C++ runtime**: ONNX Runtime prebuilds want a reasonably modern `libstdc++`/`GLIBCXX`, and DSM's is older than a current Debian. Mitigation, in order of preference: (a) it just works; (b) ship `libstdc++.so.6` from the matching toolchain in `target/lib` and set `LD_LIBRARY_PATH` in the service wrapper; (c) build ONNX Runtime from source in the spksrc toolchain.

> **Phase 0 spike #1, and the highest-risk item in the plan.** Get `require('onnxruntime-node')` to load and run one inference on the actual NAS before anything else is designed further.

---

## 2. System overview

```
   Browser ────► SPA (search, documents, ingest, admin)  ─┐
   External app ────────► REST / MCP  + Bearer API key  ──┤   :5300…  gateways
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Synology NAS · one SPK · package user NodeRag                           │
│                                                                          │
│   ┌────────────────────┐          ┌──────────────────────────────┐      │
│   │ API server         │          │ Ingest worker                 │      │
│   │ Fastify + static   │◄────────►│ crawl → paginate → extract    │      │
│   │ SiloScope on every │          │ → vision → markdown → chunk   │      │
│   │ request (§6.4)     │          └───┬───────────────────┬───────┘      │
│   └─────────┬──────────┘              │                   │              │
│             │                          ▼                   │              │
│             │            ┌──────────────────────────┐      │              │
│             │            │ Embedder (shared, 1 proc)│      │              │
│             │            │ onnxruntime-node · q8    │      │              │
│             │            │ Qwen3-Emb-0.6B · 1024-d  │      │              │
│             │            └────────────┬─────────────┘      │              │
│             ▼                         ▼                    │              │
│   ┌──────────────────────────────────────────────┐         │              │
│   │ PostgreSQL 17 + pgvector · unix socket        │         │              │
│   │ silos = LIST partitions, HNSW index per silo  │         │              │
│   │ PGDATA + per-silo tablespaces (§5)            │         │              │
│   └──────────────────────────────────────────────┘         │              │
└────────────────────────────┬────────────────────────────────┼─────────────┘
              reads in place │                                │ images only
                             ▼                                ▼
        /volume1/Documents, /volume2/Archive …     ┌────────────────────────┐
        shared folders granted to user NodeRag     │ Ollama host (off-box)  │
        .txt .md .docx .pdf                        │ VLM → markdown tables, │
                                                   │ charts, diagrams (§12) │
                                                   └────────────────────────┘
```

Everything is one SPK, one package user, and a small process tree supervised by DSM's `start-stop-status` script.

Content is divided into **silos** (§6). Every request — from the SPA, an API key, or MCP — resolves to a principal whose grants determine which silos it can touch; the SPA has no privileged path, it is a client of the same REST API (§14). PostgreSQL, the embedder and the ingest worker are single shared processes, and what varies per request is the silo scope plus which network gateway it arrived on.

**One boundary is worth noticing on the diagram:** the only thing that leaves the NAS is *images*, and only to the Ollama host. Document text, embeddings, queries and results never go anywhere. If that host is unreachable, ingest continues and images are marked `pending_vision` (§12.3) — the system degrades rather than stopping.

---

## 3. Package layout

### 3.1 SPK anatomy

```
NodeRag.spk
├── INFO                        package, version, arch, os_min_ver, maintainer, description
├── PACKAGE_ICON.PNG            64×64   (256×256 as PACKAGE_ICON_256.PNG)
├── LICENSE
├── package.tgz                 → extracted to /var/packages/NodeRag/target
│   ├── bin/                    node app entrypoints, wrappers
│   ├── app/                    compiled JS (esbuild bundle) + static admin SPA
│   ├── pgsql/                  bundled PostgreSQL 17: bin/, lib/, share/
│   │   └── lib/postgresql/vector.so
│   ├── models/                 (empty at install; model lands in var/ — see §9.4)
│   └── lib/                    bundled libstdc++ etc. if §1.3 needs it
├── scripts/
│   ├── preinst                 arch/RAM/DSM sanity checks, fail fast with a clear message
│   ├── postinst                create data root, write initial config, generate setup token
│   ├── preuninst  / postuninst optional data retention prompt
│   ├── preupgrade / postupgrade PG major-version guard (§8.4)
│   └── start-stop-status       start/stop/status/prestart, log rotation hook
├── conf/
│   ├── privilege               {"defaults":{"run-as":"package"}, ...}
│   ├── resource                data-share, port-config, usr-local-linker
│   └── PKG_DEPS                Node.js_v22>=22.0
├── WIZARD_UIFILES/
│   ├── install_uifile          data-root hint, accept-defaults path
│   └── uninstall_uifile        "also delete indexed data?" checkbox
└── ui/
    └── config                  DSM desktop icon → opens http://<nas>:8787
```

> The exact JSON schemas for `conf/privilege`, `conf/resource` and `ui/config` should be taken from the DSM 7 Developer Guide at build time rather than from memory — Synology has changed field names between 7.0, 7.1 and 7.2.

### 3.2 Build system

Use **spksrc** (SynoCommunity's cross-compilation framework) rather than hand-rolling. The decisive reason: spksrc already carries `cross/postgresql` (currently PostgreSQL 17.x) and `cross/pgvector` as buildable cross packages, plus per-platform toolchains for every x86_64 Synology platform (`apollolake`, `geminilake`, `denverton`, `broadwellnk`, `v1000`, `r1000`, `epyc7002`, …). We get a tested PostgreSQL cross-build for free and inherit their ICU handling, which is the part that usually breaks.

Repo shape:

```
D:\Dev\NodeRag
├── docs/                       this document, ADRs, schema notes
├── app/                        the Node.js application (TypeScript)
│   ├── src/server/             Fastify API + admin UI backend
│   ├── src/ingest/             crawler, paginators, extractors, chunker
│   │   ├── pdf/                per-page text + image extraction
│   │   ├── docx/               OOXML walk, page-basis detection
│   │   └── markdown/           assembly, image splicing, anchors
│   ├── src/vision/             Ollama client, schema, semaphore, cache
│   ├── src/embed/              onnxruntime-node wrapper, tokenizer, pooling
│   ├── src/store/              pg client, migrations, query builders
│   └── ui/                     Vite SPA: search, documents, ingest, admin,
│                               setup wizard — built at package time, served static
├── spk/noderag/                spksrc package definition (Makefile, src/, conf/)
└── build/                      docker-based spksrc invocation, CI
```

The Node app is bundled with esbuild into a small number of JS files and shipped with `node_modules` pruned to production + the two native modules. No `npm install` on the NAS.

---

## 4. Install and first-run flow

```
1. User installs NodeRag.spk (Package Center → Manual Install, or a repo URL)
2. preinst   → checks arch=x86_64, DSM ≥ 7.2, RAM ≥ 4 GB free, Node.js_v22 present
3. DSM       → volume picker (if >1 volume); creates system internal user "NodeRag"
4. postinst  → creates data root under @appdata, writes config.json defaults,
                generates a one-time setup token, prints it into the install wizard's
                final screen and writes it to /var/packages/NodeRag/etc/setup-token
5. First start → PG is NOT initialised yet. The API starts in "unconfigured" mode
                 and serves only the setup wizard on :8787.
6. User opens http://<nas>:8787, pastes the setup token, and completes:
      • data root  (default = DSM-chosen volume; can point at another volume/share)
      • admin account for NodeRag itself (argon2id, stored in PG once PG exists —
        held in etc/ until then)
      • which shared folders to index, from a picker of folders the package user
        can actually read (with a clear "grant access in Control Panel" hint for
        the ones it can't)
      • embedding settings: chunk size, max sequence length, thread count
      • a "run benchmark" button (§9.5) that embeds a sample doc and reports
        seconds-per-chunk before the user commits to indexing 40 GB
7. Wizard "Finish" → initdb, start Postgres, run migrations, download/verify the
   ONNX model, enqueue the first crawl. Progress streamed over SSE.
8. Subsequent visits to :8787 land on the dashboard, authenticated by session.
```

**Why a setup token rather than DSM SSO:** authenticating against DSM accounts from a package requires either root or undocumented calls into `authenticate.cgi`. For v1, a one-time token handed over by the install wizard plus a local admin account is honest, safe and portable. DSM SSO can be added later behind the same session interface.

---

## 5. Storage layout — where the database actually lives

This is the part of the brief that needs the most care, because "put it on a shared folder" is a reasonable thing to want and a slightly dangerous thing to do.

### 5.1 What DSM gives you for free, and what it doesn't

| Granularity | Mechanism | User-selectable? |
|---|---|---|
| **Which volume** | Package Center's install-time volume picker; `@appstore`/`@appdata` follow it | **Yes**, free, reliable |
| **A dedicated shared folder** | `conf/resource` → `data-share` creates a share at package start and grants our package user `rw` | Name is **hard-coded by us**; volume is **not** user-selectable |
| **An arbitrary existing shared folder** | Nothing built in — we implement it | **Yes**, but we own the validation |

So `data-share` is not the answer to "let the user pick the folder." It is useful as a *default*: declare a share named `NodeRag` with `rw` for the package user only, and the user gets a visible, File-Station-manageable home for their RAG data without doing anything. But if they want it on volume 2, they have to point us there themselves.

### 5.2 The three-way split

Rather than one monolithic "data root," split it, because the three pieces have very different requirements:

| Piece | Size | Requirements | Default | User-relocatable? |
|---|---|---|---|---|
| **PGDATA** — catalogs, WAL, control files | 1–3 GB | POSIX 0700, local fs, low-latency, never touched by anything else | `@appdata` on the install volume | Advanced option, heavily validated |
| **`chunk` partitions** — text, vectors, HNSW + GIN indexes | **The multi-GB part** — roughly 8–10 GB per million chunks | Local fs, capacity | Same volume as PGDATA | **Yes — this is the one that matters** |
| **Document files** — originals + canonical Markdown (§7.1) | Whatever the corpus weighs | Local fs, capacity | Same volume as PGDATA | Yes |
| **`models/` + `cache/extracted/`** | ~1–5 GB | Plain files, no permission drama | `@appdata` | **Yes, freely** |

A PostgreSQL **tablespace** is the right tool here and it's exactly what tablespaces are for:

```sql
CREATE TABLESPACE ts_bulk LOCATION '/volume2/RagData/pgbulk';

-- and then, per silo, at silo-creation time (§7.3):
CREATE TABLE chunk_s3 PARTITION OF chunk
  FOR VALUES IN (3) TABLESPACE ts_bulk;
```

Silos carry no configuration of their own (§6.1), so storage is a **system-wide** setting: one bulk tablespace, applied to every partition as it is created, plus the document file store (§7.1) under the same data root. Per-silo placement remains *possible* — partitions can take individual tablespaces — but it is not offered as a setting, because "which volume is this silo on" is not a question anyone asked.

This gets you the thing you actually want — app and catalogs on the fast SSD volume, the bulk of the vectors and indexes on the big HDD share — without putting the fragile parts of the cluster on a shared folder. It also keeps `pg_dump`/restore straightforward, and a lost tablespace is a recoverable situation in a way that a lost PGDATA is not.

### 5.3 Why a shared folder is not automatically safe for PGDATA

Four things go wrong, in rough order of likelihood:

**1. Windows ACLs vs PostgreSQL's 0700 check.** Since PG 11, the server refuses to start unless the data directory's POSIX mode is exactly `u=rwx` (0700) or `u=rwx,g=rx` (0750) — otherwise `FATAL: data directory has invalid permissions`. Synology shared folders commonly have Windows ACL enabled, where DSM's ACL layer governs access and `chmod` does not necessarily stick to what you asked for. This is the most likely way a user's chosen path silently fails to start.

**2. Encrypted shared folders and startup ordering.** An encrypted share is mounted after boot, sometimes only after a manual unlock or a key-store step. A package that starts before its PGDATA is mounted will find an empty directory — and in the worst case `initdb` into it. Encrypted shares must be detected and refused, or gated behind a mount-wait in `prestart`.

**3. Other DSM services touching the files.** Cloud Sync, Synology Drive, Hyper Backup file-level jobs, Universal Search / media indexing, and Snapshot Replication all operate on shared folders and not on `@appdata`. Any of them pointed at a live PGDATA will at best waste enormous I/O and at worst upload a torn database to someone's Dropbox. `@appdata` is invisible to all of them, which is a large part of why it exists.

**4. Users can see and delete it.** Anyone with access to that share sees `pgbulk/` in File Station. A dedicated share with only the package user granted mitigates this; a folder inside `Documents` does not.

None of these make it impossible. They make it something the wizard has to *verify empirically* rather than assume.

### 5.4 What the wizard actually does

When the user picks a path, run a probe before accepting it — don't guess at any of the above:

```
1. Resolve the real path; reject anything not under /volumeN/
2. /proc/mounts → filesystem must be ext4 or btrfs, not cifs/nfs/fuse
3. Detect encryption (share listed as encrypted / path under an eCryptfs mount) → refuse,
   with a clear explanation
4. Permission probe (the important one):
     mkdir  <path>/.noderag-probe
     chmod  0700 <path>/.noderag-probe
     stat   → is the mode ACTUALLY 0700 or 0750?
     write + fsync + read back a file
     rmdir
   If the mode did not stick, this share has ACLs that PostgreSQL will reject.
   Offer: (a) pick a different folder, (b) use it for models/cache only and keep
   PGDATA on @appdata, (c) show the admin the exact steps to disable Windows ACL
   on a dedicated share.
5. Free-space check against a projected index size from the corpus estimate
6. Warn if the path is inside a folder covered by Cloud Sync / Drive / an indexed share
```

Only after all six does the wizard write the path into config and run `initdb` / `CREATE TABLESPACE`.

### 5.5 Moving it later

Relocation after data exists is an explicit, guarded action in the admin UI, never an edit to a config field:

```
stop ingest → CHECKPOINT → stop postgres → rsync -aHAX --delete old → new
→ verify byte counts + a sample checksum → repoint symlink / ALTER TABLESPACE
→ start postgres → run integrity check → only then offer to delete the old copy
```

For the tablespace specifically, PostgreSQL has no online `ALTER TABLESPACE ... SET LOCATION`; the supported route is stop the server, move the directory, and fix the symlink in `PGDATA/pg_tblspc/`. Script it, test it, and take a `pg_dump` first.

### 5.6 Resulting layout

```
/volume1/@appdata/NodeRag/            ← DSM-chosen volume, the safe default
├── pgdata/                           PGDATA — 0700, catalogs + WAL
├── run/                              unix socket, pid files (0700)
├── logs/
└── config/

/volume2/RagData/                     ← user-chosen shared folder (optional)
├── pgbulk/                           TABLESPACE noderag_bulk — chunks, vectors, HNSW
├── models/                           Qwen3-Embedding-0.6B-ONNX
├── originals/                        content-addressed original files (§10.7)
│   └── 7f/7f3a91…                    referenced by every silo that has that file
└── cache/
    ├── pages/                        extracted page markdown, keyed by content sha
    └── images/                       extracted images, keyed by image sha
```

Two rules that survive whatever the user chooses:

- **PGDATA is never on a network mount, and never on an encrypted share** without an explicit mount-wait.
- **Indexed source folders are never written to.** NodeRag reads originals in place and writes only into its own data locations.

## 6. Silos, identity, and access control

**This section supersedes the database-per-instance design of the previous draft.** Silos are a better fit for what's actually needed, and they resolve a conflict the instance model could not.

### 6.1 What a silo is for

A silo is **a named body of documents with its own access list, and nothing else.**

The use case is concrete: one person keeps legal documents, another keeps personal documents, several people share the system, and none of them should see each other's material or have it pollute their search results. That is the whole job.

Everything that could have been per-silo isn't. Chunk size, overlap, the embedding model, the CPU budget, the vision configuration, the keyword-search language — all system-wide, in one `settings` row (§7.8). A silo has an id, a name, a description and a list of who can do what with it.

Two things nonetheless follow the silo boundary, and both are consequences of that access list rather than configuration:

- **Search is scoped to it.** A query returns only chunks from silos the caller may read.
- **It is a partition boundary.** Not for tidiness — for recall. §6.5 explains why a shared approximate index silently returns near-nothing for a user who can see only part of the corpus.

### 6.2 The model

```
silo        a named body of documents with an access list

principal   anything that can authenticate. Two kinds:
              user     — logs in with a password, holds a browser session
              api_key  — presents a bearer token, no session

grant       (principal, silo, permission). The only thing that authorises anything.
            Identical evaluation for users and API keys — this is the point.
```

An API key is not a second permission system bolted alongside the first. It is a principal with grants, exactly like a user, and the authorisation code cannot tell them apart. That is what stops the two from drifting, which is how access-control bugs usually happen.

### 6.3 Two permissions

| Permission | Can |
|---|---|
| `read` | Search the silo, read the Markdown of any document in it, download originals |
| `upload` | `read` + add documents, re-index them, and delete them |

Plus a `server_admin` flag on a user — not a per-silo grant — for everything that is not silo-scoped: creating silos, managing users and keys, system settings, storage, the embedder, rebuilds, upgrades.

Two notes on the edges:

**`upload` includes delete.** Someone who can add documents to a silo can remove them from it. If that is too broad — a shared silo where contributors should add but not destroy — the split is a third permission and is cheap to add later; it is not cheap to add after people have relied on the two-level model. Worth a decision now rather than a surprise later.

**API keys can be narrowed below `read`.** A key wired into an assistant usually needs matching passages, not the ability to download whole confidential PDFs. So `api_key.search_only` (default **true**) further restricts a key to search results and chunk text, with document downloads and full-Markdown fetches refused. It is a per-key flag rather than a permission level, because it is a property of the credential, not of the relationship between a principal and a silo. When a key leaks, this is the difference between someone seeing snippets and someone taking the corpus.

### 6.4 Enforcement — where this is won or lost

Three layers, in order of how much they're relied on:

**1. One choke point, no exceptions.** Every query path takes a `SiloScope` — the resolved, permitted silo-id set for the current principal — as a *required constructor argument*, not an optional filter applied later. There is no code path that can build a query without one, because the query builder does not compile without it. Reviews and tests catch what's left; the type system catches most of it first.

**2. Row-Level Security as a backstop.** Each request opens its transaction with `SET LOCAL app.silo_ids = '{1,3,7}'`, and RLS policies on `source`, `document` and `chunk` restrict to that set. A forgotten `WHERE` clause then returns nothing rather than everything. This is defence in depth for a system whose entire job is holding data people don't want leaked.

> **Needs measuring, not assuming:** RLS adds a predicate that must still permit runtime partition pruning and an index scan. `current_setting()` is STABLE so it should prune at execution time, but the interaction with an HNSW scan is exactly the sort of thing that silently degrades to a sequential scan. Benchmark it in Phase 4 with RLS on and off; if it costs more than ~15 %, keep it on for `document`/`source` and rely on partition boundaries plus the choke point for `chunk`.

**3. Partition boundaries.** Because each silo's vectors live in their own partition with their own HNSW index (§6.5), a query scoped to silo 3 physically cannot traverse silo 4's index graph. This is a structural property, not a filter.

### 6.5 Why silos must be partitions, not just a column

This is the single most important technical consequence of the silo model, and getting it wrong produces a system that looks correct and returns bad results.

pgvector's own documentation is blunt about it: with an approximate index, **filtering happens after the index scan**. `ORDER BY embedding <=> $1 WHERE silo_id = 3 LIMIT 20` searches the whole HNSW graph across all silos, takes the global top ~40, and *then* throws away everything not in silo 3. If silo 3 is 5 % of the corpus, you get one or two results instead of twenty — and no error, just quietly terrible recall. pgvector's own documentation makes the same point about multi-tenancy: a single approximate index shared across tenants causes cross-tenant recall and speed problems, and the remedies it recommends are list partitioning or separate tables per tenant.

So:

```sql
-- one partition, one HNSW index, per silo — created when the silo is created
CREATE TABLE chunk_s3 PARTITION OF chunk FOR VALUES IN (3);

CREATE INDEX ON chunk_s3 USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON chunk_s3 USING gin (tsv);
```

What this buys:

- **Correct recall.** A search scoped to silos {1,3} prunes to two partitions and does a proper top-k scan in each, then merges. Scores are directly comparable — same model, same metric — so the merge is a simple sort.
- **Cheap silo deletion.** `DROP TABLE chunk_s3` — instant, no vacuum storm (§7.6).
- **Bounded index builds.** Rebuilding one silo's HNSW doesn't touch the others, which is what makes the per-silo swap in §7.5 possible.

The cost: a principal granted 20 silos triggers 20 partition scans per query. Postgres handles partition-wise scans well, but this is not free — cap silos per query, expose `hnsw.ef_search` per query, and set `hnsw.iterative_scan = relaxed_order` as a safety net for any residual post-filtering inside a partition.

`document` is deliberately *not* partitioned — it is small, it is queried by id far more than by silo, and keeping it whole avoids a composite foreign key on everything that references a document.

### 6.6 Deduplicate the expensive work, not the files

The same 300-page PDF may be uploaded into two silos. At 6–15 s per chunk (§9.5) and a second or more per vision call (§12), redoing that work is hours; storing the file twice is megabytes. So the trade is the inverse of the obvious one:

- **Files are not deduplicated.** Originals and Markdown are stored per document id (§7.1), so the same PDF in three silos is three files. That is what makes deletion a clean `unlink` with no refcount to reason about.
- **Work is deduplicated**, through two silo-agnostic caches keyed by content hash: `embedding_cache` on chunk text, `vision_cache` on image bytes. A duplicate upload re-extracts (cheap) but re-embeds nothing and re-analyses no images.

`vision_cache` earns its place within a single document too: a letterhead on 300 pages is one vision call and 299 cache hits.

> **Both caches are refcounted, because deletion must be a real purge (§7.6).** A cached vector for deleted text is arguably harmless; a cached **vision transcription** is not — it is readable Markdown of what an image contained. Purge decrements both refcounts and deletes at zero, so shared content survives and content unique to the deleted document does not.

### 6.7 You can still have port 5300 and 5301

The port-per-document-set idea from the previous draft survives, minus the databases. A **gateway** is a listener bound to a fixed silo set:

```sql
CREATE TABLE gateway (
  id         smallserial PRIMARY KEY,
  name       text NOT NULL,
  port       int UNIQUE,              -- NULL = served on the control port under /g/<name>
  silo_ids   smallint[] NOT NULL,     -- the ceiling, not the grant
  require_auth bool NOT NULL DEFAULT true,
  enabled    bool NOT NULL DEFAULT true
);
```

`:5300` serves Legal, `:5301` serves Research, and each is a separate network surface you can firewall differently. The critical semantic: **a gateway narrows, it never widens.** The effective scope of a request is `gateway.silo_ids ∩ principal_grants`. A key with access to five silos hitting the Legal gateway can search Legal and nothing else. A gateway is not an authentication bypass.

This is strictly better than separate processes: no extra Postgres cluster, no second ONNX session, no duplicated model, and one place to reason about permissions. Gateways are cheap enough that a single Node process can hold all of them as additional listeners.

The `.sc` firewall constraint from the previous draft still applies — declare a port range (5300–5319) at install, cap gateways, and probe for a free port before binding rather than hardcoding.

### 6.8 Credentials

**Passwords** (users): argon2id, per-user salt, tuned to ~100 ms on the target CPU. Rate-limited login with per-account backoff. Sessions are server-side rows in Postgres — not JWTs — because instant revocation matters more than statelessness on a single-node appliance. HttpOnly, SameSite=Strict, Secure when TLS is on; sliding expiry with an absolute cap.

**API keys**: a different problem with a different answer.

```
nrag_<8-char prefix>_<32 bytes base62>
```

- The token is high-entropy random, so **hash it with SHA-256, not argon2id.** Argon2 exists to make low-entropy guessing expensive; against 256 bits of randomness it buys nothing and would add ~100 ms to *every API request*. This distinction is worth writing down because "hash all secrets with argon2" is the kind of correct-sounding rule that quietly makes an API unusable.
- The `prefix` is stored in clear, indexed, and shown in the UI, so a key is identifiable without being recoverable.
- Shown **once**, at creation. Never retrievable.
- Per-key: optional expiry, optional CIDR allow-list, per-key rate limit, `last_used_at`, and `created_by`.
- Revocation is immediate — the key row is the authority, checked per request against a small in-memory cache with a short TTL.

**Audit log**, append-only, in its own table: principal, gateway, silo, action, result, row counts, timestamp, source IP. Every search, every ingest, every grant change, every failed auth. On a system whose purpose is controlling access to documents, "who searched for what, and when" is not optional, and it is much harder to add later than now. Retention is configurable; the default should not be "forever."

### 6.9 Bootstrap and defaults

- The setup wizard (§4) creates the first `server_admin` user and a `default` silo, and issues no API keys.
- New silos start with no grants except the creating admin's.
- A user with zero grants can log in and sees an empty state explaining who to ask — not an error.
- Deleting a silo is a typed-confirmation action that drops its partitions; deleting a user revokes sessions immediately and leaves audit rows intact (principals are soft-deleted, so audit history never dangles).

### 6.10 What this changes elsewhere

| Section | Change |
|---|---|
| §4 install | Wizard creates the admin user + first silo; per-silo folder mapping replaces "which folders to index" |
| §5 storage | Per-**silo** partition tablespaces replace the single `noderag_bulk` tablespace |
| §7 data model | `silo_id` on `source`, `document` and `chunk`; LIST partitioning on `chunk`; identity tables; refcounted caches |
| §8 tuning | One connection pool again (one database) — `max_connections` back to ~20; partition count affects planning time, so cap silos (~64) |
| §9 embedding | Embedder is silo-agnostic; fair-share scheduling is now across **silos** rather than instances |
| §13 API | Every route is silo-scoped; `POST /v1/search` takes an optional `silos` array intersected with the principal's grants |
| §18 roadmap | Identity and silos move into Phase 2 — `silo_id` and the partition boundary cannot be retrofitted cheaply |

---

## 7. Data model

One PostgreSQL database. **Configuration is system-wide; silos carry access control and nothing else.**

### 7.1 What lives where

| | Where | Why |
|---|---|---|
| Originals | **Files**, `<data root>/documents/<bucket>/<id>.<ext>` | Named by document id, so purge is unambiguous |
| Canonical Markdown | **Files**, `<data root>/documents/<bucket>/<id>.md` | Large, blob-like, and precious (§10) |
| Page boundaries, chunks, vectors, identity | **PostgreSQL** | Everything that is queried, joined or partitioned |

```
<data root>/documents/
├── 4/4471.pdf        original, named by document id + its real extension
├── 4/4471.md         the canonical markdown for that document
└── 4/…               bucket = floor(id / 1000), so no directory grows unbounded
```

Naming by **document id rather than content hash** is a deliberate reversal of the earlier draft. It costs file-level deduplication — the same PDF in three silos is three copies — and it buys the thing that matters more here: **delete is `rm 4471.pdf 4471.md` plus one cascading DB delete, with no refcount to get wrong.** Given that delete must purge completely (§7.6), that trade is worth making. Content-level deduplication survives anyway, in the caches that actually cost something: identical text is not re-embedded and identical images are not re-analysed (§6.6).

**The consistency protocol**, since files and rows can now disagree:

```
write   file first, fsync, then COMMIT the row
delete  DELETE the row in a transaction, then unlink the files
verify  document.markdown_sha and document.content_sha are stored;
        a nightly sweeper reports rows without files and files without rows
```

Orphaned files are harmless and get swept; a row without a file is a broken document and is reported loudly. Both are detectable, which is the point.

### 7.2 Documents and pages

```sql
CREATE TABLE document (
  id             bigserial PRIMARY KEY,
  silo_id        smallint NOT NULL REFERENCES silo(id),
  source_id      bigint REFERENCES source(id) ON DELETE SET NULL,
  name           text NOT NULL,            -- display name, usually the filename
  title          text,                     -- from document metadata if present
  ext            text NOT NULL,            -- 'pdf' | 'docx' | 'xlsx' | 'txt' | 'md'
  mime           text,
  rel_path       text,                     -- where it came from, if a folder crawl
  bytes          bigint NOT NULL,
  mtime          timestamptz,
  content_sha    bytea NOT NULL,           -- of the original bytes; change detection
  markdown_sha   bytea,                    -- of the canonical markdown file
  char_count     int,                      -- of the canonical markdown
  page_count     int,
  page_basis     text NOT NULL DEFAULT 'none'
                 CHECK (page_basis IN ('exact','sheet','rendered','explicit','none')),
  encoding       text,                     -- detected, txt/md only (§10.4)
  encoding_confidence real,
  offsets_match_original bool NOT NULL DEFAULT false,
  state          text NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','extracting','ready','failed')),
  error          text,
  uploaded_by    bigint REFERENCES principal(id),
  meta           jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  indexed_at     timestamptz
);
CREATE INDEX ON document (silo_id, created_at DESC);
CREATE INDEX ON document (silo_id, content_sha);

-- Page boundaries only. The markdown text itself is in the file (§7.1).
CREATE TABLE document_page (
  document_id  bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal      int    NOT NULL,            -- 0..n-1, always
  page_no      int,                        -- NULL when page_basis = 'none'
  label        text,                       -- 'Q3 Detail' for a worksheet
  char_start   int NOT NULL,               -- into the canonical markdown, UTF-16
  char_end     int NOT NULL,
  byte_start   int NOT NULL,               -- into the same markdown, UTF-8
  byte_end     int NOT NULL,
  extraction   text NOT NULL DEFAULT 'text'
               CHECK (extraction IN ('text','vision','mixed')),   -- §10.5
  extraction_confidence real,
  PRIMARY KEY (document_id, ordinal)
);
```

### 7.3 The chunk table

One row per chunk, **with its vector inline** — text, vector, page range, character range and document id in the same place, which is how the retrieval path reads them anyway.

```sql
CREATE TABLE chunk (
  id           bigserial,
  silo_id      smallint NOT NULL,          -- partition key; see §7.4
  document_id  bigint   NOT NULL,
  build_id     smallint NOT NULL REFERENCES build(id),
  ordinal      int      NOT NULL,          -- position within the document

  text         text     NOT NULL,          -- the chunk markdown

  page_start   int,                        -- NULL only when page_basis = 'none'
  page_end     int,                        -- = page_start when it fits one page
  char_start   int      NOT NULL,          -- UTF-16, into the document markdown
  char_end     int      NOT NULL,
  byte_start   int      NOT NULL,          -- UTF-8, into the same markdown
  byte_end     int      NOT NULL,

  embedding    halfvec(1024) NOT NULL,     -- dimension follows the model (§7.5)

  token_count  int      NOT NULL,
  heading_path text[],
  chunk_sha    bytea    NOT NULL,          -- over exactly what was embedded (§11.5)
  part_of      text,                       -- 'table 3/14' if an atomic unit was split
  tsv          tsvector GENERATED ALWAYS AS (to_tsvector(ts_config(), text)) STORED,

  PRIMARY KEY (silo_id, id),
  UNIQUE (silo_id, document_id, ordinal),
  CHECK (page_end IS NULL OR page_end >= page_start),
  CHECK (char_end > char_start)
) PARTITION BY LIST (silo_id);

-- per partition, created with the silo:
--   CREATE INDEX ON chunk_s7 USING hnsw (embedding halfvec_cosine_ops)
--     WITH (m = 16, ef_construction = 64);
--   CREATE INDEX ON chunk_s7 USING gin (tsv);
--   CREATE INDEX ON chunk_s7 (document_id, ordinal);
```

Note `document_id` has no foreign key to `document`: `chunk` is partitioned and `document` is not, and the rebuild mechanism in §7.5 detaches and swaps chunk partitions wholesale. Referential integrity is maintained by the deletion path (§7.6) and checked by the nightly sweeper — the same trade the file store makes.

### 7.4 Why silos are still partitions, when nothing else is per-silo

Silos now carry **access control and nothing else** — no per-silo chunk size, model, language or storage. So it is fair to ask why they remain a partition key rather than an ordinary column.

The answer is recall, not tidiness. With an approximate index, **pgvector filters after the index scan**. A single HNSW index over every silo, queried by a user who can see one silo holding 5 % of the corpus, searches the whole graph, takes the global top ~40 and then discards everything they may not see — returning one or two results instead of twenty, silently. pgvector's own guidance for multi-tenancy is list partitioning or separate tables per tenant.

So the partition boundary exists to make **access-scoped search return correct results**, which is precisely what silos are for. Everything else about them got simpler; this stays.

### 7.5 Builds: how re-chunking and re-embedding work

A **build** is one complete, self-consistent set of chunks and vectors, produced by one chunk profile and one embedding model. Exactly one build is active at a time. Changing the chunk size, the overlap, or the embedding model all use the same mechanism — which is the reason to have it.

```sql
CREATE TABLE build (
  id              smallserial PRIMARY KEY,
  state           text NOT NULL DEFAULT 'building'
                  CHECK (state IN ('building','active','superseded','failed')),
  target_chars    int  NOT NULL DEFAULT 2000,
  overlap_chars   int  NOT NULL DEFAULT 300,
  max_tokens      int  NOT NULL DEFAULT 1024,
  heading_prefix  bool NOT NULL DEFAULT true,
  rules_version   int  NOT NULL,           -- bump when the boundary snapper changes
  model_name      text NOT NULL,           -- 'Qwen3-Embedding-0.6B'
  model_revision  text NOT NULL,
  dim             int  NOT NULL,           -- 1024
  reason          text,                    -- 'chunk size 2000→3000', 'model swap'
  chunk_count     bigint,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  activated_at    timestamptz,
  CHECK (overlap_chars <= target_chars / 2),
  CHECK (target_chars BETWEEN 200 AND 8000),
  CHECK (max_tokens BETWEEN 128 AND 2048)
);
```

**The rebuild runs against staging tables and swaps them in.** Search keeps serving the old build the entire time:

```sql
-- 1. build into a detached table, with a CHECK matching the partition bound
--    so ATTACH is metadata-only rather than a full scan
CREATE TABLE chunk_s7_new (LIKE chunk INCLUDING ALL);
ALTER TABLE chunk_s7_new ADD CONSTRAINT p CHECK (silo_id = 7);
--    …populate, then build its indexes…

-- 2. swap
BEGIN;
  ALTER TABLE chunk DETACH PARTITION chunk_s7;
  ALTER TABLE chunk ATTACH PARTITION chunk_s7_new FOR VALUES IN (7);
  UPDATE build SET state='superseded' WHERE state='active';
  UPDATE build SET state='active', activated_at=now() WHERE id=$new;
COMMIT;
DROP TABLE chunk_s7;
```

**One rule that matters, and it falls out of the design:**

| Change | Flip granularity | Why |
|---|---|---|
| Chunk size / overlap / snapper, **same model** | Per silo, as each finishes | Vectors are still comparable, so a mix of old and new silos still ranks correctly |
| **Embedding model** (or its revision) | **All silos in one transaction** | Scores from two models are not comparable. A half-flipped corpus silently mis-ranks every cross-silo search |

**Cost:** a rebuild roughly doubles chunk storage until the swap. For 200 000 chunks that is ~400 MB of vectors plus text — cheap. Time is the real cost, and it is the §9.5 number: a full re-embed of a large corpus is days. So the UI shows the projected hours from measured throughput **before** starting, the job is resumable across restarts, and a rebuild can be paused.

**A single document** can be re-chunked and re-embedded in place under the active build — the common case after an edit — without any of this machinery. The build mechanism is for corpus-wide changes.

**If the new model has a different dimension**, `halfvec(1024)` no longer fits and a partition's column type cannot differ from its parent. That case builds an entire new parent table with the new type and renames it into place in one transaction — the same pattern one level up. Worth knowing which kind of model swap you are doing before starting: same-dimension is easy, different-dimension is a bigger operation.

### 7.6 Deletion is always a purge

There is one delete, and it removes everything:

```
DELETE FROM document WHERE id = $1     -- cascades to document_page
DELETE FROM chunk WHERE silo_id = $s AND document_id = $1
sweep embedding_cache and vision_cache for rows now unreachable (refcounted)
unlink  <data root>/documents/<bucket>/<id>.<ext>
unlink  <data root>/documents/<bucket>/<id>.md
write   one audit row recording what was destroyed
```

Two details that make it a real purge rather than a partial one:

- **The shared caches must be swept.** `embedding_cache` and `vision_cache` are keyed by content hash and shared across silos, so they survive a document's deletion by default. `vision_cache` is the sharper edge — it holds a **readable Markdown transcription** of an image's contents, not an opaque vector. Both carry a refcount; purge decrements and deletes at zero, so shared content survives and unique content does not.
- **Deleting a silo** deletes its documents, then drops its partitions (`DROP TABLE chunk_s7` — instant, no vacuum storm), then sweeps the caches.

Deletion is irreversible and typed-confirmation-gated in the UI. There is no recycle bin: a RAG index over documents someone wanted destroyed is exactly the wrong place to keep a soft copy.

### 7.7 Identity

```sql
CREATE TABLE silo (
  id           smallserial PRIMARY KEY,
  slug         text NOT NULL UNIQUE,       -- 'legal'
  display_name text NOT NULL,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principal (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('user','api_key')),
  label        text NOT NULL,
  disabled     bool NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   bigint REFERENCES principal(id),
  deleted_at   timestamptz                 -- soft; audit rows must never dangle
);

CREATE TABLE app_user (
  principal_id  bigint PRIMARY KEY REFERENCES principal(id) ON DELETE CASCADE,
  username      text NOT NULL UNIQUE,
  email         text,
  password_hash text NOT NULL,             -- argon2id, ~100 ms on target CPU
  server_admin  bool NOT NULL DEFAULT false,
  must_change   bool NOT NULL DEFAULT false,
  failed_logins int  NOT NULL DEFAULT 0,
  locked_until  timestamptz
);

CREATE TABLE api_key (
  principal_id  bigint PRIMARY KEY REFERENCES principal(id) ON DELETE CASCADE,
  prefix        text NOT NULL UNIQUE,      -- shown in the UI, stored in clear
  key_sha256    bytea NOT NULL,            -- SHA-256, NOT argon2 (§6.8)
  search_only   bool NOT NULL DEFAULT true,-- narrows further; see §6.3
  expires_at    timestamptz,
  cidr_allow    inet[],
  rate_per_min  int,
  last_used_at  timestamptz,
  last_used_ip  inet
);
CREATE INDEX ON api_key (key_sha256);

-- The only thing that authorises anything. Identical for users and API keys.
CREATE TABLE silo_grant (
  principal_id bigint   NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  silo_id      smallint NOT NULL REFERENCES silo(id) ON DELETE CASCADE,
  permission   text     NOT NULL CHECK (permission IN ('read','upload')),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  granted_by   bigint REFERENCES principal(id),
  PRIMARY KEY (principal_id, silo_id)
);

CREATE TABLE session (
  id           bytea PRIMARY KEY,          -- random, hashed
  principal_id bigint NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           inet,
  user_agent   text
);

CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  principal_id bigint REFERENCES principal(id),
  silo_id      smallint,
  action       text NOT NULL,              -- search | read | upload | delete | grant | auth.fail
  result       text NOT NULL,              -- ok | denied | error
  detail       jsonb NOT NULL DEFAULT '{}',
  ip           inet
);
CREATE INDEX ON audit_log (at DESC);
CREATE INDEX ON audit_log (principal_id, at DESC);
```

### 7.8 System settings

Everything that used to be per-silo now lives in one row, because there is one of each.

```sql
CREATE TABLE settings (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- chunking + embedding: changing any of these starts a build (§7.5)
  target_chars      int  NOT NULL DEFAULT 2000,
  overlap_chars     int  NOT NULL DEFAULT 300,
  max_tokens        int  NOT NULL DEFAULT 1024,
  heading_prefix    bool NOT NULL DEFAULT true,
  model_name        text NOT NULL DEFAULT 'Qwen3-Embedding-0.6B',
  model_revision    text NOT NULL,
  model_quant       text NOT NULL DEFAULT 'q8',

  -- CPU (§9.3)
  embed_threads     int  NOT NULL DEFAULT 4 CHECK (embed_threads BETWEEN 1 AND 32),
  ingest_threads    int  NOT NULL DEFAULT 2,
  throttle_when_busy bool NOT NULL DEFAULT true,

  -- keyword search
  ts_config         regconfig NOT NULL DEFAULT 'english',

  -- vision (§12)
  ollama_base_url   text,
  ollama_token      text,                  -- Ollama Cloud / reverse proxy only
  ollama_model      text,
  ollama_parallel   int  NOT NULL DEFAULT 2,
  ollama_timeout_ms int  NOT NULL DEFAULT 60000,
  vision_enabled    bool NOT NULL DEFAULT true,
  max_image_px      int  NOT NULL DEFAULT 1600,

  -- search
  default_mode      text NOT NULL DEFAULT 'vector'
                    CHECK (default_mode IN ('vector','keyword','hybrid')),
  ef_search         int  NOT NULL DEFAULT 100,

  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        bigint REFERENCES principal(id)
);
```

Changing `target_chars`, `overlap_chars`, `max_tokens`, `heading_prefix` or any `model_*` field does not mutate anything directly — it **proposes a build**, and the UI shows the projected chunk count and re-embedding hours before it is confirmed (§7.5). `ts_config` changes reindex the `tsv` column only, which is minutes, not days.

### 7.9 Sources, jobs and caches

```sql
CREATE TABLE source (                       -- a watched folder, feeding one silo
  id           bigserial PRIMARY KEY,
  silo_id      smallint NOT NULL REFERENCES silo(id) ON DELETE CASCADE,
  uri          text NOT NULL,               -- /volume1/Documents/Contracts
  include_glob text[], exclude_glob text[],
  enabled      bool NOT NULL DEFAULT true,
  last_crawl_at timestamptz,
  UNIQUE (silo_id, uri)
);

CREATE TABLE job (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,               -- crawl|extract|vision|chunk|embed|rebuild|purge
  document_id  bigint, silo_id smallint, build_id smallint,
  priority     smallint NOT NULL DEFAULT 5, -- queries pre-empt; see §9.2
  payload      jsonb NOT NULL DEFAULT '{}',
  state        text NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
CREATE INDEX ON job (priority, run_after) WHERE state = 'pending';

-- Silo-agnostic. Never searched. Refcounted so §7.6 can purge them.
CREATE TABLE embedding_cache (
  chunk_sha bytea NOT NULL, model_name text NOT NULL, model_revision text NOT NULL,
  embedding halfvec(1024) NOT NULL,
  refcount  int NOT NULL DEFAULT 0, last_used timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_sha, model_name, model_revision)
);

CREATE TABLE vision_cache (
  image_sha bytea NOT NULL, model text NOT NULL,
  kind text NOT NULL, markdown text NOT NULL, alt text NOT NULL,
  confidence real NOT NULL, ms int,
  refcount  int NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (image_sha, model)
);

CREATE TABLE document_image (               -- what was found, and what became of it
  id           bigserial PRIMARY KEY,
  document_id  bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  page_ordinal int NOT NULL, seq int NOT NULL,
  image_sha    bytea NOT NULL,
  width int, height int, bytes bigint,
  state        text NOT NULL DEFAULT 'pending_vision'
               CHECK (state IN ('pending_vision','analysed','skipped','failed')),
  skip_reason  text
);
```

### 7.10 Five deliberate choices

**The vector lives on the chunk row.** One table, one row per chunk, read as one row by the retrieval path. The earlier two-table design existed so two models' vectors could coexist during a swap; the build mechanism in §7.5 does that better, by keeping whole *sets* consistent instead of interleaving them, and it covers chunk-size changes too — which the two-table design never did.

**`silo_id` is denormalised onto `chunk`.** It could be joined from `document`. It must not be: it is the partition key, and a partition key cannot be a join result. Every access-control predicate must also be answerable from the row itself.

**Originals and Markdown are files named by document id.** Purge becomes two `unlink`s and a cascading delete, with no refcount to get wrong — which is what makes §7.6 credible rather than aspirational.

**One `principal` table for users and API keys.** The grant table, the scope resolver and the audit log all take a `principal_id` and neither know nor care which kind it is. Two parallel permission systems would drift within a release; one cannot.

**PostgreSQL is the job queue.** `SELECT … FOR UPDATE SKIP LOCKED` gives durable, crash-safe queuing with no extra infrastructure. There is no Redis on a NAS and there shouldn't be.

---

## 8. Bundled PostgreSQL

### 8.1 Build

Via spksrc: `cross/postgresql` + `cross/pgvector`, configured with `--prefix=/var/packages/NodeRag/target/pgsql`, `--with-openssl`, `--with-icu` using spksrc's ICU-archive approach (this avoids the `libicudata` runtime-loading failures that bite on several Synology platforms). No PL/Perl, no PL/Python, no PostGIS — every extra library is another cross-compile to maintain.

### 8.2 Runtime

- **No TCP by default.** Postgres listens on a **unix socket** in `<data root>/run/`, mode 0700, owned by the package user. Nothing outside the package can reach the database. A "expose PostgreSQL on port 5434" toggle in the admin UI is fine as an opt-in for people who want to query it with pgAdmin, defaulting off.
- Single superuser role `noderag`, created by `initdb` as the package user. SCRAM-SHA-256. Password generated at first run, stored in `/var/packages/NodeRag/etc/db.json` at 0600.
- `initdb` runs at **first start**, not in `postinst` — `postinst` runs before the user has chosen the data root.

### 8.3 Tuning for an 8 GB NAS

Written by the wizard from measured RAM, not hardcoded:

```
shared_buffers            = 1GB          # ~12% of 8GB; leave room for ONNX
effective_cache_size      = 3GB
work_mem                  = 32MB
maintenance_work_mem      = 1GB          # HNSW builds want this; see below
max_connections           = 24           # one app, one database; gateways share pools
max_parallel_workers      = 4
wal_compression           = on
random_page_cost          = 1.1          # SSD volume; 4.0 if the wizard detects HDD
hnsw.ef_search            = 100          # per-session, tuned at query time
```

**The memory trap:** an HNSW build with `maintenance_work_mem = 1GB` running *at the same time* as an ONNX session holding ~1 GB of weights and activations will push an 8 GB NAS into swap and make the whole DSM UI unresponsive. The ingest worker must therefore hold a **global mutex**: either the embedder is running or an index build is running, never both. Index maintenance is scheduled for after a batch completes, or nightly.

### 8.4 The upgrade problem — call this out now

Bundling Postgres means **we own major-version upgrades forever**. When NodeRag v2 ships with PG 18, a user upgrading from v1 has a PG 17 data directory that PG 18 binaries will refuse to start against, and DSM's package upgrade gives us one shot in `preupgrade`/`postupgrade`.

Plan:

- Pin one PG major per NodeRag major. Record it in `<data root>/pgdata/PG_MAJOR`.
- `preupgrade` compares the on-disk major with the incoming one. If they differ, run `pg_dumpall` using the **old** binaries (still present at that moment) to `<data root>/upgrade/dump-<ts>.sql`, and refuse to proceed if there isn't 2× the database size free.
- `postupgrade` runs `initdb` with the new binaries and restores. Old dump is retained until the user confirms.
- Ship a manual "export / import database" pair in the admin UI from day one, so there is always a hatch.

This is the single largest long-term maintenance cost of the "bundle it" decision, and it's worth accepting deliberately rather than discovering at v2.

---

## 9. Embedding

### 9.1 Model

**Qwen3-Embedding-0.6B**, ONNX build (`onnx-community/Qwen3-Embedding-0.6B-ONNX` or an equivalent conversion), int8 (`q8`) by default.

| Property | Value |
|---|---|
| Output dimension | 1024 (Matryoshka — truncatable to 32…1024) |
| Context | 32 K tokens (we will use ≤ 1024) |
| Pooling | **last token**, not mean |
| Normalisation | L2, then cosine / inner product |
| Query format | `Instruct: {task}\nQuery: {query}` |
| Document format | raw text, **no prefix** |
| q8 file size | ~600 MB |

The asymmetric query/document convention is easy to get wrong and silently degrades recall by a lot. It belongs in `embedding_model.query_prefix` (§7) so that the retrieval path can never drift from the ingest path.

Matryoshka truncation reduces *storage*, not *compute* — the forward pass is identical. Worth exposing (768 or 512 dims cuts index size by 25–50 %) but don't expect it to speed up ingest.

### 9.2 Runtime

`onnxruntime-node` directly, rather than the full `@huggingface/transformers` pipeline, plus `tokenizers`-compatible JSON tokenizer loading. Reasons: smaller bundle, explicit control over pooling and batching, no surprise model downloads from a package that must work on an air-gapped NAS.

```
intraOpNumThreads  = physical cores (4 on V1500B), NOT logical
interOpNumThreads  = 1
graphOptimizationLevel = 'all'
executionMode      = 'sequential'
```

One session, created once, held for the process lifetime. Creating and destroying ONNX sessions per batch is a common and expensive mistake.

**The embedder is a separate, shared process**, not a library call inside the API server. It owns the ONNX session, listens on a unix socket in the private run directory, and speaks a trivial framed protocol: `{siloId, priority, texts[], maxSeqLen}` → `{vectors[], tokens, ms}`. One model serves every silo; nothing about a vector depends on which silo asked for it. It exports counters — queue depth per silo, chunks/sec, p50/p95 latency by priority — which is what makes "why is search slow right now" an answerable question.

**Scheduling is the part with the non-obvious consequence.** ONNX inference is not preemptible mid-run, and a typical chunk — 2 000 characters, ~500 tokens of English (§11) — costs 6–15 s (§9.5). So if the Archive silo is grinding through an overnight ingest and someone searches Legal, that query waits behind whatever is currently in the accelerator. Three ways out, in increasing cost:

1. **Ingest batch size 1 plus a priority queue.** Query jobs jump ahead at every batch boundary, so worst-case query latency is one chunk — still 6–15 s. Fine if ingest is confined to a night window; not fine if ingest runs continuously.
2. **Two sessions: one for queries, one for ingest.** The query session is built with a short max sequence length (queries are tens of tokens), so its activation memory is small — but ONNX Runtime won't share prepacked weights across sessions from Node, so budget a second ~600 MB of q8 weights. Search stays sub-second while ingest runs around the clock. **Recommended if RAM allows**, and on the 8 GB target it does, just.
3. One embedder per silo — defeats the entire point. Don't.

**Fair share across documents, not silos.** Silos carry no scheduling configuration (§6.1), so the queue is one system-wide list ordered by priority then arrival: every query job first (FIFO among themselves), then ingest work. To stop a single 40 GB import starving everything behind it, ingest interleaves **round-robin across documents** rather than draining one to completion — so ten small files uploaded during a large import still finish in minutes.

**A rebuild (§7.5) runs below everything**, including new-document ingest, because a corpus-wide re-embed takes days and must never block someone adding a file today.

### 9.3 The CPU budget — four cores, five claimants

An omission worth correcting before implementation starts. §9.2 sets `intraOpNumThreads` to the physical core count, which quietly assumes the embedder owns the machine. It does not. On a 4-core NAS, five things want CPU:

| Claimant | Appetite |
|---|---|
| ONNX embedder | All of it, happily |
| PDF/DOCX/XLSX extraction | 1 core, bursty, genuinely CPU-bound |
| PostgreSQL (queries, autovacuum, HNSW builds) | 1–4 cores |
| API server + front end | ~0.2 cores, but latency-sensitive |
| **DSM itself** — Photos, indexing, SMB, the web UI | Whatever's left, and the user notices immediately when it isn't enough |

The failure mode is not a crash. It is a NAS that feels broken while indexing: File Station stalls, Photos stops thumbnailing, DSM takes ten seconds to paint a page — and the user disables NodeRag rather than filing a bug.

So the policy is explicit rather than emergent:

- **`embed_threads` defaults to 4** and is a system setting (§7.8), range 1–32. Four is a good default for the x86_64 target: it uses a typical NAS fully during a night window while leaving something for DSM on a 6- or 8-core box, and the UI states the trade-off rather than burying it. On a 2-core machine it is clamped down at start-up rather than thrashing.
- **Extraction and embedding do not run concurrently at full width.** They are stages of one worker; a semaphore sized `physical_cores` is shared between them, so extracting three PDFs while embedding drops the embedder's threads accordingly.
- The §8.3 memory mutex gains a CPU sibling: **no HNSW build while embedding**, cluster-wide.
- `nice`/`ionice` the ingest worker and the embedder. They are batch work by nature (§9.5) and should always lose to an interactive DSM request.
- The ingest window (§6, per silo) is the blunt instrument that makes all of this moot overnight — and is why it exists.

A "limit background work while I'm using the NAS" toggle in the UI, which simply drops the semaphore to 1, is worth more to a home user than any amount of tuning.

### 9.4 Model delivery

Shipping a 600 MB model *inside* the SPK makes an enormous package and forces a full re-download on every app update. Instead:

- SPK ships the tokenizer, config, and a manifest with the model's SHA-256 and a list of mirror URLs.
- First-run wizard downloads the model into `<data root>/models/`, verifies the hash, shows a progress bar.
- The wizard also accepts a **manual upload / local path**, so an air-gapped NAS can be fed the file over File Station. This is not optional — a meaningful share of Synology users firewall their NAS off the internet entirely.
- The model survives package upgrades because it lives in the data root, not in `target/`.

### 9.5 Performance — set expectations before writing code

Rough arithmetic for one chunk. The default profile is 2 000 characters (§11), which for English prose at ~4 characters per token is ~500 tokens — so the numbers below use 512 as the working figure. Qwen3-0.6B has ~0.6 B parameters, of which ~155 M are the 151 K × 1024 token-embedding table (a lookup, not FLOPs), leaving ~0.44 B compute-relevant. A forward pass costs roughly `2 × params × tokens`:

```
2 × 0.44e9 × 512  ≈  450 GFLOP per 512-token chunk (+ attention)
```

Against an achievable int8 throughput of perhaps 30–80 GFLOPS on a 4-core Zen-based NAS CPU with AVX2:

| | estimate |
|---|---|
| Per chunk (2 000 chars ≈ 500 tokens of English) | **~6–15 seconds** |
| 500-page PDF (~1 000 chunks — arithmetic in §11.10) | **1.7–4.2 hours** |
| 10 000 mixed documents (~200 000 chunks) | **days** |

**These are order-of-magnitude estimates and must be measured, not trusted.** But the shape of the answer is not in doubt: local Qwen3-0.6B on NAS silicon is an *overnight batch* technology, not an interactive one. The design has to absorb that rather than fight it:

- Ingest is a **background queue with a visible ETA**, resumable across restarts and package upgrades.
- **Nothing is ever re-embedded without cause.** Content-hash the chunk text; if the hash exists for this model, reuse the vector. Editing one paragraph of a document re-embeds one chunk.
- The wizard runs a **calibration benchmark** on ~20 real chunks and reports actual seconds-per-chunk, plus a projected completion time for the folders the user selected, *before* they commit.
- A **schedule window** ("index only between 01:00 and 07:00") and a nice-level throttle, so indexing doesn't make Photos and File Station crawl.
- Search-time embedding is one short query — ~0.3–1 s. That's acceptable interactively, but the API should still expose a "query embedding cache" for repeated queries.

**Phase 0 spike #2:** benchmark q8 vs q4 vs fp16, sequence lengths 256/512/1024, thread counts 1…N on the real device. If q4 is within a few points of q8 on retrieval quality and 1.5–2× faster, it should probably be the default.

---

## 10. Document ingestion — the markdown pipeline

**Everything becomes page-scoped Markdown.** Markdown is the canonical internal form: it is what gets chunked, what gets embedded, what gets displayed in search results, and what an API consumer receives. The original file is never the retrieval unit — it is the artefact you open afterwards.

#### The canonical Markdown is the contract

Stated plainly, because everything else in §10, §11 and §12 depends on it:

```
   original file            canonical Markdown            chunks → vectors → index
   ─────────────            ──────────────────            ───────────────────────
   .pdf .docx .xlsx   ──►   page-scoped UTF-8        ──►  2 000 chars / 300 overlap
   .txt .md                 Markdown, stored               embedded, HNSW-indexed
        │                        │                              │
   kept, immutable          kept, precious              disposable, rebuildable
```

Two boundaries, and they behave very differently:

**Left of the Markdown: expensive and not reproducible.** Extraction runs OCR-grade heuristics, and vision calls (§12) go to a remote model at temperature 0 that will still not return byte-identical output twice. Redoing this stage costs real time and, on a metered Ollama, real money.

**Right of the Markdown: cheap and deterministic.** Chunking and embedding are pure functions of the Markdown plus a **build** — one chunk profile and one embedding model (§7.5). Re-chunk at 3 000 characters, swap to a better embedding model, rebuild a corrupted HNSW index: all of it replays from stored Markdown without reopening one original file and without one vision call. That is what makes "change the model later" a scheduling problem rather than a re-ingestion project.

That asymmetry is the whole reason the middle artefact exists, and it has one operational consequence worth acting on: **the canonical Markdown is precious and belongs in the backup set.** Losing the vectors costs CPU hours. Losing the Markdown costs the vision calls again, and the extraction may not even land the same way twice.

It is stored in `document_page.markdown` — in PostgreSQL, not as loose files — so it is transactionally consistent with the chunks and offsets that address it, backed up by the same `pg_dump`, and incapable of drifting out of sync with the database. An **export action** writes real `.md` files per document or per silo for anyone who wants to grep or diff them; that export is a copy, never the source of truth.

"Representative" has a quality bar, and it is about *content*, not appearance: headings, lists, tables, reading order, page boundaries and image transcriptions must survive. Fonts, colours, margins and exact layout deliberately do not.

### 10.1 Supported formats, and what page numbers mean for each

| Format | Page basis | How |
|---|---|---|
| `.txt` | **none** | One synthetic page. `page_no` is NULL — do not invent one |
| `.md` | **none** | Passed through, structure preserved. `page_no` NULL |
| `.pdf` | **exact** | Real page boundaries from the file itself |
| `.docx` | **best available** — see below | `rendered`, `explicit`, or `none` |
| `.xlsx` | **sheet** | One sheet = one page. Exact, and the only format where the page boundary is unarguable (§10.9) |

Nothing else. Refusing `.pptx`, `.html`, `.eml`, `.csv` and images-as-documents in v1 is a feature: each is a different extraction problem with its own failure modes, and five formats done properly beats twelve done badly.

**The uncomfortable truth about DOCX page numbers.** OOXML has no concept of a page. Pagination is computed by the rendering engine from fonts, margins and layout, so a `.docx` does not carry page numbers the way a PDF does. Three things are available, in descending order of reliability:

1. **`<w:lastRenderedPageBreak/>`** — Word writes these when it lays out the document and saves it. They record where *Word* last broke pages, which is the answer the user expects. Present in files saved by Word; **absent** in `.docx` produced by Google Docs export, pandoc, python-docx, and most generators.
2. **Explicit breaks** — `<w:br w:type="page"/>` and section breaks. Always reliable when present, but they only mark deliberate breaks, not natural flow.
3. **Nothing.** Then `page_basis = 'none'` and `page_no` stays NULL.

So: **detect and record which basis was used, per document**, surface it in the UI and API (`"page_basis": "rendered"`), and never present a guessed page number as though it were exact. A `page_basis` of `none` on a Word document is information the user needs, not a failure to hide.

> **The exact-pagination escape hatch:** rendering DOCX → PDF with headless LibreOffice gives true page numbers. LibreOffice cannot realistically ship inside the SPK — it is enormous and cross-compiling it for DSM is not a project anyone should start. But the machine already running Ollama (§12) can host `soffice --headless --convert-to pdf` behind the same companion-service configuration. Optional, off by default, and the right answer for anyone who cares about Word pagination precisely.

### 10.2 Pipeline

```
crawl        walk granted folders per silo, honour include/exclude globs,
             stat → (mtime, size) gate → content_sha authority → enqueue changed only
   ↓
retain       record the original: path + content_sha, and optionally a
             content-addressed copy in the data root (§10.7)
   ↓
decode       TXT/MD only: BOM → strict UTF-8 → legacy detector; then
             CRLF→LF and Unicode NFC, **before** any offset is computed (§10.4)
   ↓
paginate     PDF  → real pages
             DOCX → pages by lastRenderedPageBreak / explicit breaks / none
             XLSX → one page per worksheet, in workbook order
             TXT, MD → a single synthetic page
   ↓
extract      per page: text → Markdown, preserving headings, lists, tables,
             code blocks and emphasis. Images are pulled out with their
             position on the page and their own content hash.
             PDF pages are scored for extraction confidence; a page that fails
             is rendered at ~200 DPI and sent to the VLM instead (§10.5).
   ↓
vision       each surviving image → Ollama VLM (§12) → Markdown fragment,
             spliced back into the page Markdown at its original position.
             Cached by image content hash — a logo on 300 pages costs one call.
   ↓
assemble     page Markdown is stored per page; the document's full Markdown
             is the pages concatenated with page anchors
   ↓
chunk        character-based: 2 000 chars target, 300 overlap (both configurable
             per silo within limits), snapped to paragraph/sentence boundaries,
             atomic Markdown units kept whole, large tables split at row
             boundaries with the header repeated, heading path prefixed to what
             gets embedded, token ceiling as a guard. Chunks **flow across page
             boundaries** and record page_start/page_end plus document-level
             character offsets. Full rules in §11.
   ↓
embed        via the shared embedder (§9), with the embedding cache (§6.6)
   ↓
store        write the markdown file, fsync, then upsert page, image and chunk
             rows in one transaction (§7.1)
```

**Why pages are still stored per page even though chunks ignore them.** Pagination and chunking answer different questions. `document_page` exists so that a page is addressable on its own — for the preview pane, for re-extracting one changed page, and for mapping any character offset back to a page number. Chunking then runs over the *assembled* document Markdown and flows freely across those boundaries, recording the page range it happens to cover (§11.6). Keeping the two independent is what lets a chunk be semantically whole while a citation is still able to say "pages 37–38".

### 10.3 Text → Markdown

- **PDF:** per-page text with layout coordinates, reconstructing headings from font size and weight, lists from indentation and bullet glyphs, and tables from column alignment. Table reconstruction from a text layer is unreliable in the general case — when confidence is low, treat the region as an image and send it to the VLM instead. That fallback is what makes tables in PDFs actually work. PDF has no document encoding and needs no decode step; what it has instead is a fidelity problem, covered in §10.5.
- **DOCX:** walk the OOXML body directly rather than through a converter. Heading styles → `#`/`##`, `w:tbl` → Markdown tables (this one is exact — the structure is in the file), lists → `-`/`1.`, `w:drawing`/`w:pict` → image extraction, footnotes → reference-style links at the end of the page.
- **MD:** normalise, don't reformat. The user's headings are the structure signal.
- **XLSX:** each sheet becomes a page of Markdown — see §10.8, which has enough sharp edges to deserve its own section.
- **TXT:** paragraph splitting on blank lines; do not attempt to infer headings.

### 10.4 Encoding and normalisation — where complex character sets actually bite

Choosing UTF-16 for offsets (§11.7) has **nothing** to do with which character sets NodeRag can handle. All three candidate units — UTF-16 code units, Unicode code points, UTF-8 bytes — address the whole of Unicode losslessly, and none is more capable than the others. Text is stored as UTF-8 in PostgreSQL and read from UTF-8 on disk regardless; the unit choice is about *arithmetic*, not capability.

The things that genuinely break on Japanese, Arabic or emoji-bearing documents are these three, and they all live upstream in extraction.

#### Encoding detection, for `.txt` and `.md` only

A `.txt` file is a bag of bytes with no declared encoding. Guess wrong and you index mojibake — which is unsearchable *and* pollutes the vector space with garbage tokens that match nothing. `.docx` and `.xlsx` are XML with a declared encoding, and PDF carries its own encodings and CMaps, so this applies only to the two plain-text formats.

```
1. BOM wins.  EF BB BF → UTF-8;  FF FE → UTF-16LE;  FE FF → UTF-16BE;
              the UTF-32 pair likewise. Strip it.
2. No BOM: check for BOM-less UTF-16 first — in UTF-16LE Latin text every
   second byte is 0x00, so a high proportion of alternating nulls aligned to
   even (LE) or odd (BE) offsets identifies it with near-certainty.
3. Try strict UTF-8. If it decodes without an invalid sequence, it is UTF-8.
   This is correct for the overwhelming majority of files.
4. Otherwise run a detector for the legacy encodings that still show up —
   Shift-JIS, EUC-JP, GB18030, Big5, KOI8-R, ISO-8859-x, Windows-125x.
5. Record `encoding` and `encoding_confidence` on the document.
```

Low confidence is **surfaced, not silently accepted**: the document ingests with a warning badge in the UI, because a human glancing at the extracted text can tell in one second whether it is Japanese or nonsense, and no detector can.

> **The BOM must be stripped before offsets are computed.** Strip it afterwards and every offset in the document is off by one — the same class of silent bug §11.7 exists to eliminate, arriving through a different door.

#### Unicode normalisation — the one that actually loses search results

The same visible text has more than one valid encoding. `café` is four code points in NFC (`é` as one character) and five in NFD (`e` plus a combining acute). macOS filesystems and some scanners emit NFD; Windows and most editors emit NFC. Both are correct Unicode and they are **not equal** as strings.

Untreated, this means a user who types `café` in NFC gets no keyword match against an NFD document, and the vector side degrades too because the tokenizer sees different tokens. It is a quiet, ugly failure that only appears on accented, Vietnamese, Korean or heavily diacritic text — precisely the corpora where people assume "Unicode support" already covers them.

**So: normalise to NFC at extraction, and normalise queries to NFC as well.** Both sides, or it does nothing. The order in the pipeline is fixed and matters:

```
decode → strip BOM → normalise line endings (CRLF→LF) → NFC
       → THEN compute offsets, hashes, pages and chunks
```

Any normalisation applied after offsets are computed invalidates every one of them. `normalization: 'NFC'` is recorded on the document so that a future change of policy is detectable rather than a silent corpus-wide inconsistency.

This also gives `offsets_match_original` (§11.6) a precise, one-line definition instead of a per-format assumption:

```js
offsets_match_original = Buffer.from(canonicalMarkdown, 'utf8').equals(originalBytes)
```

True for a plain UTF-8, LF, already-NFC `.md` file — which is most of them — and false the moment a BOM was stripped, CRLFs were converted or NFC changed anything. `byte_start`/`byte_end` are populated only when it is true. No heuristics, no per-format special cases, and it cannot drift.

#### Grapheme clusters are a *display* concern, and only that

What a person calls one character can be many code units: a flag emoji, a family emoji joined by ZWJs, an emoji with a skin-tone modifier, a Devanagari conjunct. The locator path never needs to know this — it slices at boundaries §11.4 already guarantees are ASCII whitespace or punctuation.

The **front end** does need to know it, in exactly one place: truncating a snippet with an ellipsis. Cutting at an arbitrary index there can split a grapheme cluster and render a broken glyph or a bare skin-tone modifier. Use `Intl.Segmenter(locale, { granularity: 'grapheme' })` for display truncation, and nowhere else — never in the locator path, where it would reintroduce exactly the conversion boundary §11.7 removes.

While in that layer: render snippets with `dir="auto"` so Arabic and Hebrew lay out correctly, and **preserve** bidi control characters in extracted text rather than stripping them as noise — they are load-bearing. A highlight span in RTL text can render as visually discontiguous while being logically contiguous; that is correct, and worth writing down so nobody later "fixes" it.

### 10.5 PDF text: there is no encoding step, but there is a fidelity problem

Worth settling directly, because it is a natural thing to assume: **a PDF does not have a document encoding, and there is no UTF-16-to-Markdown conversion to perform.**

A `.txt` file is a bag of bytes whose encoding you must guess (§10.4). A PDF is not. PDF stores text as **glyph codes** inside content streams, and each font object carries the mapping needed to turn those codes back into Unicode:

- **Simple fonts** use single-byte codes 0–255, resolved through a base encoding (`WinAnsiEncoding`, `MacRomanEncoding`, `StandardEncoding`) plus an optional `/Differences` array.
- **Composite (Type0/CID) fonts** use multi-byte codes — usually two bytes, which is what people see in a hex dump and reasonably mistake for UTF-16. With the common `/Identity-H` encoding those two bytes are **glyph indices inside that specific embedded font**, not Unicode at all. `0x0024` might be `g` in one PDF and `ł` in the next.
- The bridge back to Unicode is the font's **`/ToUnicode` CMap**, and it is *optional*.

The extraction library resolves all of this. `pdfjs-dist` (or MuPDF) hands back **JavaScript strings** — already decoded, already Unicode, and therefore already UTF-16 by definition of the language. The pipeline in §10.4 reflects this: `decode` is a TXT/MD-only step, because for PDF, DOCX and XLSX the format itself defines the mapping and the library has already applied it.

So the encoding question is answered. The *fidelity* question is the real one, and it is where PDF→Markdown quality is won or lost.

#### What actually goes wrong

| Problem | Symptom | Handling |
|---|---|---|
| **Missing `/ToUnicode`** on a subset-embedded font — common in LaTeX output and some design tools | Extracted text is gibberish, or private-use-area characters, or empty | Detect and fail the page to the vision fallback below |
| **Drawing order ≠ reading order** | A two-column paper extracts as interleaved half-sentences; headers and footnotes land mid-paragraph | Reconstruct reading order from glyph coordinates: column detection, then top-to-bottom within column. **The single biggest quality lever in PDF extraction** |
| **No space characters** — some producers position every glyph individually | `Thequickbrownfox` | Infer word boundaries from inter-glyph x-gaps relative to the font's space width |
| **Typographic ligatures** — `ﬁ` (U+FB01), `ﬂ`, `ﬀ`, `ﬃ`, `ﬄ` | Searching "file" misses `ﬁle`; "workflow" misses `workﬂow` | Fold the five Latin ligatures to their component letters at extraction. A pure presentation artefact — the author's text was always "fi" |
| **Hyphenation across line breaks** | `develop-\nment` indexes as two fragments, matching neither "development" nor anything else | Join when a line ends in `-` and the next begins lowercase; keep the hyphen when both sides are capitalised or the joined form fails a dictionary check. Conservative, and flagged |
| **Invisible text** — render mode 3, OCR layers under scans, watermarks | Duplicated or ghost content in the Markdown | Respect the text render mode; drop mode-3 runs unless the page has no visible text at all (in which case it *is* the OCR layer, and it's what you want) |
| **Encrypted / permission-flagged PDFs** | Extraction refused or empty | Open with an empty user password where the format allows; otherwise fail the document with an honest message, never a silent empty result |
| **No text layer at all** — a scan | Zero extracted characters | Vision fallback below |

Ligature folding and de-hyphenation both change the character count — which is fine, because they run **before** offsets are computed (§10.4's fixed pipeline order), and `offsets_match_original` is false for PDF regardless.

#### The vision fallback, which turns out to be the same mechanism

Several rows above end in "give up on the text layer." Rather than treating each as its own failure mode, **score every page and route the bad ones to the VLM as page images** — reusing §12 exactly as it stands.

```
extraction_confidence per page, failing on any of:
  • > 5 % of characters are U+FFFD or private-use (U+E000–U+F8FF)
  • alphabetic-character ratio far below the document's own median
  • mean run length between spaces implausible (missing-space case)
  • zero extracted characters on a page with visible content
→ render the page at ~200 DPI and send it to the vision model as an image;
  its Markdown becomes that page's Markdown, marked  extraction: 'vision'
```

This is worth more than the sum of its parts. It handles the missing-`/ToUnicode` case, the scanned-page case and the pathological-producer case with one mechanism; it means a **scanned PDF simply works** rather than being a separate feature (open question #11 collapses into "it works, and it costs one vision call per page"); and every affected page is labelled, so a user seeing an odd result can tell whether they are reading extracted text or a model's transcription.

The cost is the honest trade: a vision call per bad page instead of a few milliseconds of text extraction. Pages that fail the gate are counted per document and shown in the UI, because "this 400-page scan will need 400 vision calls" is something to see *before* starting, not after.

#### One addition back in §10.4

A `.txt` or `.md` file that really is UTF-16 **without** a BOM does occur — some Windows tooling produces it. Strict UTF-8 validation rejects it and a generic statistical detector can misread it, so add the cheap structural check before falling through to the detector: in UTF-16LE Latin text, every second byte is `0x00`. A high proportion of alternating nulls, aligned to even or odd offsets, identifies UTF-16LE or UTF-16BE with near-certainty.

### 10.6 Images inside documents

Not every image deserves a vision call — at a second or more per call over the network, a naive implementation spends its life describing bullet glyphs and header rules.

**Filter first:**

```
skip if  width < 64px or height < 64px          bullets, rules, icons
skip if  aspect ratio is extreme (> 20:1)       dividers
skip if  the image is near-uniform (low entropy) fills, spacers
skip if  content hash is in the "decorative" set  learned per silo
```

**Then deduplicate by image content hash, globally.** A company logo on every page of a 300-page report is one vision call and one cached result, reused 300 times. Same principle as the embedding cache (§6.6), and it matters more here because vision calls are the slowest thing in the pipeline.

**Then call the VLM** (§12) and splice the result into the page Markdown at the image's position, in a form that renders cleanly but stays machine-locatable:

```markdown
<!-- noderag:image id=img_7f3a91 page=12 kind=table model=qwen3-vl:8b -->
| Region | Q1    | Q2    |
|--------|-------|-------|
| EMEA   | 1.24  | 1.41  |
| APAC   | 0.87  | 0.95  |
<!-- /noderag:image -->
```

HTML comments survive Markdown rendering invisibly, carry the provenance, and let a later pass re-run a specific image against a better model without re-ingesting the document. The Markdown inside is chunked and embedded like any other text — which is the entire point: **a table that was an image becomes searchable text.**

Images that fail vision analysis are stored with `state = 'pending_vision'` and an alt-text placeholder. The document ingests anyway. This matters more than it sounds: a nightly ingest must not die because the desktop running Ollama went to sleep.

### 10.7 Keeping the original

Search results need to open the real file, so the original must be reachable. Two modes, per silo:

- **Reference in place** (default for stable local folders). Store `path + content_sha`. On open, verify the hash and serve the file. If it has changed, say so and offer a re-index; if it has moved, say that rather than 404.
- **Content-addressed copy** (default for anything else). Store the bytes once at `<data root>/originals/<sha[0:2]>/<sha>`, referenced by every document row that shares that hash. The same PDF in three silos costs one copy. This survives the user deleting, moving or renaming the source, and it is the only mode that makes the index self-contained.

Both modes keep the extracted page Markdown regardless, so a missing original degrades to "you can still search and read it, you just can't open the file."

### 10.8 Excel: one sheet, one page

Spreadsheets are the format where the page concept is *least* ambiguous — a workbook has sheets, sheets are ordered, and nobody argues about where one ends. `page_basis = 'sheet'`, `page_no` = the 1-based sheet index, and the sheet name is carried alongside so the UI can say **`Sheet: Q3 Detail`** rather than `p. 4` (§15.1).

The conversion is straightforward. The traps are not.

**Number formats, or you index 45 292 instead of 2024-01-01.** Excel stores dates as serial numbers and currency as bare floats; the human-readable value lives in the cell's number format. Extracting raw values gives you a spreadsheet full of five-digit integers that match nothing anyone would ever search for. **Apply the cell's number format** and emit the formatted string — that is what the user sees in Excel, and it is therefore what they will search for. Where the raw value is also useful (sorting, filters), keep it in the cell's metadata, not in the Markdown.

**Formulas → cached values.** `.xlsx` stores both the formula and the value from the last calculation. Index the **value**; a chunk full of `=SUMIF(...)` is unsearchable and semantically empty. Optionally note the formula in an HTML comment on the row for provenance. If a workbook was saved without cached values, flag the document rather than emitting zeros.

**Sheets are not always one table.** Real workbooks contain a title block, a blank row, a table, two more blank rows, then a second table, then some notes. Emitting one giant Markdown table for the whole used range produces a wall of empty cells. So: detect contiguous non-empty rectangular regions, emit each as its own Markdown table, and pass through free-standing text cells as paragraphs. A header row is inferred from a type change between the first row and the rest (text over numbers) and from formatting, with a fallback to no header rather than a wrong one.

**Merged cells** get their value repeated across the span, because a Markdown table has no concept of merging and a blank is worse than a repeat.

**Very wide sheets.** A 90-column Markdown table is unreadable and embeds badly. Above a configured width (default ~15 columns), emit the region **record-oriented** instead — one block per row, `key: value` per field. It reads far better, retrieves far better, and costs slightly more characters:

```markdown
**Row 412**
- Region: EMEA
- Product: A-100
- Units: 412
- Revenue: 18 240
```

**Very tall sheets** are handled downstream, not here: the sheet becomes one page of Markdown, and §11.4 splits the table at row boundaries with the header repeated in each part. A 5 000-row sheet is ~14 chunks, each of which says which rows it holds.

**Charts and embedded images** go to the vision pipeline (§12) exactly like images in a PDF or Word file — a chart image becomes a described figure or a transcribed data series, and lands inline in the sheet's Markdown.

**Skip** hidden sheets (configurable — they are usually working calculations, occasionally the actual data), fully empty sheets, and columns beyond the used range. Record what was skipped on the document, so an unexpectedly small ingest is explainable rather than mysterious.

**Library:** `exceljs` with its streaming reader. Workbooks are the format most likely to arrive at 200 MB, and loading one fully into a Node heap on an 8 GB NAS alongside PostgreSQL and the embedder is exactly the allocation that gets the whole package OOM-killed.

> `.xlsm` (macro-enabled) is read the same way, macros ignored and never executed. `.xls` — the pre-2007 binary format — is **not** supported: it needs a completely different parser for a format that should have been converted a decade ago. `.csv` is deliberately excluded too; it is a one-line conversion away from `.xlsx` and supporting it means owning delimiter and encoding detection, which is its own small swamp.

### 10.9 Change detection and deletion

`(mtime, size)` as a cheap gate, `content_sha` as the authority — Btrfs snapshots and Cloud Sync both touch mtimes without changing content. A crawl that finds a document whose file is gone sets `deleted_at` and cascades; hard deletion happens on a retention timer, so an unmounted volume or an offline share does not silently destroy an index.

Re-ingesting a changed document reuses everything that didn't change: unchanged page Markdown keeps its chunks, unchanged chunk text hits the embedding cache, unchanged images hit the vision cache. Editing one paragraph of a 400-page PDF costs one page of work.

---

## 11. Chunking

**Decision: character-based chunking. 2 000 characters target, 300 characters overlap, per silo, with a token ceiling as a safety valve.** Your instinct is right, and the reasons it's right are better than "token counting is iffy."

### 11.1 First, a thing worth untangling: chunk size and vector size are unrelated

There's no requirement for the database to "handle non-fixed-size vectors," because chunk size never changes the vector at all.

An embedding model maps *any* input length to a **fixed-width** output. Qwen3-Embedding-0.6B emits 1 024 dimensions whether you hand it 50 characters or 5 000. So `halfvec(1024)` is a fixed-width column — 2 048 bytes per row, always — and it stores a 200-character chunk and a 3 000-character chunk identically. HNSW in fact *requires* fixed dimensionality; it cannot index a mixture, and it never has to.

So the two knobs are independent:

| Knob | Set by | Effect |
|---|---|---|
| **Dimensions** (1 024) | The model. Not a choice, beyond MRL truncation | Index size, RAM, recall |
| **Chunk size** (2 000 chars) | You, per silo | Retrieval granularity, embedding cost |

Your 1 024 is right: it's Qwen3-Embedding-0.6B's native output width. MRL truncation to 768 or 512 stays available if index size becomes the binding constraint (§7.3), but that is a *corpus-wide* decision applied uniformly — never per chunk, because every vector in one HNSW index must have the same width.

### 11.2 Why characters beat tokens here

The usual argument is that tokenizers are fiddly. True, but minor. The substantial reasons:

**Chunk boundaries stop depending on the model.** This is the big one. With token-based chunking, boundaries are a function of the tokenizer — so swapping embedding models re-tokenizes, which shifts every boundary, which means new chunk rows, new `chunk_sha` values, a cold embedding cache and a full re-chunk of the corpus. With character boundaries, a model swap re-embeds the *same* chunks: the `chunk` rows, their page numbers, their character offsets and their identity all survive. Given that §7 was deliberately built so a second model can be embedded *alongside* the first and cut over when complete, character chunking is what makes that plan actually cheap.

**Offsets are already the unit the rest of the system uses.** `char_start`/`char_end` map straight onto the page Markdown for highlighting in the preview pane (§15.1), onto `document_page.markdown` for reconstruction, and onto the `<!-- noderag:image -->` spans for provenance. Token offsets would need converting at every one of those boundaries.

**The chunker runs without the model loaded.** Extraction, pagination and chunking can proceed while the ONNX session is busy embedding something else — which matters when the embedder is the bottleneck and is deliberately a separate process (§9.2).

**It's deterministic and testable.** Given the same page Markdown and the same profile, the chunk boundaries are reproducible by inspection, in a unit test, without a 600 MB model.

**The honest cost:** 2 000 characters is not a constant amount of *information*. English prose runs about 4 characters per token, CJK about 1.5, dense JSON or code about 2.5. So a 2 000-character chunk is ~500 tokens of English but ~1 300 tokens of Chinese — different embedding cost and different semantic density for the same nominal size. For a mostly-English document corpus this is a non-issue. For a CJK-heavy silo, lower `target_chars` rather than accepting the drift.

### 11.3 The one thing characters can't guarantee — so guard it

Character counts can't bound token counts, and the embedder has a fixed `max_seq_len` (§9.2). An unguarded pathological chunk — a dense table, a base64 blob, a page of Chinese — could exceed it and get silently truncated, which loses the tail of the chunk from the vector while the text still displays fine. That's the worst kind of bug: invisible.

So the chunker counts tokens **once per finished chunk** and splits any chunk over `max_tokens`:

```
target_chars   2000     the rule, ~99 % of the time
overlap_chars   300
max_tokens     1024     the guard; split at the nearest boundary if exceeded
```

Tokenizing 2 000 characters is microseconds, and the tokenizer is already loaded for the query path — so this costs nothing and turns a silent failure mode into a boring one. `token_count` is stored on the chunk either way, because it's what the ingest ETA and the embedder queue are actually calculating from.

Note the interaction: at 2 000 characters the *typical* English chunk is ~500 tokens, which is exactly the working assumption behind the §9.5 performance estimates. The guard exists for the tail of the distribution, not the middle of it.

### 11.4 Boundaries: never cut mid-word, never cut a table in half

A raw `slice(i, i + 2000)` cuts through words, sentences and Markdown structures. So 2 000 is a *target*, and the chunker snaps to the nearest real boundary within ±15 % (1 700–2 300 characters), preferring, in order:

```
1. blank line   (paragraph break)      ← by far the best boundary
2. sentence end (. ? ! followed by space/newline, not an abbreviation)
3. line break
4. word boundary
5. hard cut     (only if nothing else exists within the window)
```

**Some Markdown structures are atomic and must not be split at all:**

- a Markdown **table** — half a table is unparseable and useless in a result
- a fenced **code block**
- a `<!-- noderag:image … -->` block from the vision pipeline (§10.6) — splitting it would orphan the provenance comment from its content
- a list item (splitting between items is fine; splitting inside one is not)

If an atomic unit is larger than `target_chars` but still inside `max_tokens`, it becomes its own oversized chunk rather than being broken — a 3 200-character table as one chunk is far more useful than two half-tables.

**Beyond that, tables are split at row boundaries with the header row repeated in every piece.** This is not optional: a table fragment without its header is a grid of numbers with no meaning, and it will embed and retrieve as noise. It also matters far more than it sounds, because §10.8 turns every Excel sheet into a Markdown table, and a 5 000-row sheet is not going to fit in any chunk anyone would want.

```markdown
<!-- noderag:table-part doc=4471 sheet="Q3 Detail" rows=241–380 of 5012 -->
| Region | Product | Units | Revenue |
|--------|---------|-------|---------|
| EMEA   | A-100   | 412   | 18 240  |
…
```

Each part carries the header, the row range and the total, so a retrieved fragment says what it is and where it sits. Code blocks split at line boundaries with a continuation marker. Both cases are flagged on the chunk so the UI can show "part 3 of 14" rather than pretending it's a whole.

### 11.5 Heading context makes small chunks findable

A 2 000-character chunk from the middle of a contract may not contain any word identifying which contract or which clause it belongs to. Prepending the heading path to the embedded text fixes that cheaply:

```
Schedule 3 › Indemnity › Limitations

…the indemnity shall survive termination for a period of…
```

The prefix goes into **what gets embedded**, not into what gets displayed — the UI shows the body, the `heading_path` array renders as breadcrumbs, and the vector knows where the passage came from. Two consequences to keep straight:

- `chunk_sha` is computed over **exactly what gets embedded** (prefix + body), because that is the embedding cache key (§6.6). A heading rename correctly invalidates the affected chunks.
- The prefix counts against `max_tokens`. It's typically 10–25 tokens; the guard already accounts for it because it measures the rendered string.

### 11.6 Page spans and character offsets

**Correction to the earlier draft: chunks may now span page boundaries.** The previous version confined every chunk to one page so that `page_no` was a single exact value. Letting chunks flow across page breaks is better, and on two counts:

- **Semantics.** A paragraph interrupted by a page break is one thought. Page-bounded chunking cut it in half at every boundary and produced a runt at the foot of all 500 pages of a 500-page document — 500 opportunities to sever a sentence from its conclusion.
- **Cost.** Page-bounded chunking forced a fresh chunk at every page start regardless of remaining space. Flowing across pages drops a 500-page PDF from ~1 000 chunks to ~735 (§11.10) — roughly 27 % less of the slowest operation in the system.

The price is that a chunk no longer has *a* page. It has a range, which is what gets stored:

```
page_start   the page the chunk's first character falls on
page_end     the page its last character falls on   (= page_start when it fits one page)
char_start   offset of the first character, into the assembled document Markdown
char_end     offset one past the last character
```

So chunk 50 of a long report might be `page_start 37, page_end 38, char_start 117 000, char_end 119 000` — spanning a page break, and locatable to the exact character either way.

**Both locators are always populated, and they answer different questions.** The page range is what a person wants when they open the original PDF or Word file. The character range is what actually works everywhere: it is the only locator a `.txt` or `.md` document has at all, it drives highlight-on-open in the preview pane, and it's exact where a page number is approximate — recall that a DOCX's page numbers may be Word's last-rendered guess (§10.1), while its character offsets never are.

**Offsets are into the canonical document Markdown**, defined as the document's pages concatenated in order with exactly `"\n\n"` between them and no injected page markers — so the offset space is the text itself, and page boundaries are metadata. `document_page` stores each page's own `char_start`/`char_end` in that same space, which makes the mapping exact in both directions:

```
page containing offset N   →  SELECT … WHERE N >= char_start AND N < char_end
offset within its page     →  chunk.char_start − page.char_start
```

For `.txt` and `.md` the canonical Markdown is the original file with line endings normalised and nothing else touched, so offsets land on the original bytes too. That is recorded per document as `offsets_match_original`, because it is true for those two formats and false for the other three, and a client deep-linking into a source file needs to know which.

> **What "character" means here, stated once:** a **UTF-16 code unit** — JavaScript's native string unit, so `char_start`/`char_end` are exactly what `.slice()` takes. This is not the "more correct" choice (code points would be), it is the one that removes every conversion boundary from the system. §11.7 explains why, and how the whole class of off-by-one-after-an-emoji bug is designed out rather than guarded against.

**Runts** are now rare: with chunks flowing across pages, a short trailing chunk occurs once per *document* rather than once per page. The rule still holds — if the final remainder is under 25 % of `target_chars`, merge it into the previous chunk.

### 11.7 Offsets: one producer, one unit, and a verifier

The UTF-16-versus-code-point mismatch flagged earlier is real, but "count code points everywhere and add a lint rule" is a *discipline* mitigation, and discipline mitigations fail quietly on exactly the input nobody tested. The problem deserves a structural fix, and it has one — in four parts, none of which requires anybody to remember anything.

#### 1. One producer. Postgres stores offsets; it never interprets them.

The mismatch can only exist because two systems independently compute positions in the same string. So only one of them does.

**The chunker computes every offset, once.** PostgreSQL stores `char_start` and `char_end` as opaque integers — the same way it stores a price. There is **no SQL anywhere that slices `document_page.markdown` using them**: no `substring(markdown, char_start, …)`, no `left()`, no `position()` feeding an offset back into the application. If a query needs the text at an offset, it selects the page and Node does the slicing.

This is a much narrower rule than "never use `.length`", and unlike that one it is mechanically checkable: a CI grep for `substring(`/`substr(` over `markdown` columns in the migrations and query modules, plus a code-review rule that offsets are never arguments to a SQL string function. One rule, one place, verifiable.

Nothing in the design actually wants Postgres to do this anyway. Keyword search uses `ts_headline()`, which returns marked-up *text* rather than positions, so the retrieval path never needs an offset to cross the boundary.

#### 2. One unit — and it should be UTF-16 code units, not code points.

This reverses the earlier instruction, for a reason worth stating plainly: **code points are the more "correct" unit and the worse engineering choice here.**

To be clear about what the choice is *not*: it has no bearing on which character sets NodeRag can ingest. UTF-16 code units, code points and UTF-8 bytes all address the whole of Unicode losslessly — text is stored as UTF-8 in PostgreSQL either way, and every script, emoji and combining mark survives all three. The unit only decides how positions are *counted*. What actually determines whether a Japanese or Arabic document survives ingestion is encoding detection and NFC normalisation, which live in §10.4.

Everything in the JavaScript ecosystem speaks UTF-16 natively. `.length`, `.slice()`, `.indexOf()`, `RegExp.lastIndex`, `Intl.Segmenter` boundaries, every offset returned by a Markdown parser, every span from a tokenizer, and every DOM `Range` in the browser front end. Choosing code points means converting at *every one of those boundaries* — and each conversion is a fresh chance to get it wrong, plus an O(n) array allocation per slice, on documents of a million characters.

Choosing UTF-16 code units means **zero conversions anywhere in the system**. The chunker's arithmetic, the API server's slicing and the browser's highlight all use the same numbers natively. It is self-consistent by construction rather than by vigilance, and the lint rule disappears because plain `.length` and plain `.slice()` are now correct.

The one real hazard of UTF-16 — cutting a surrogate pair in half and producing a lone surrogate — is almost entirely designed out already: §11.4 snaps boundaries to paragraph breaks, sentence ends, line breaks and word boundaries, all of which are ASCII whitespace or punctuation, which cannot occur inside a surrogate pair. That leaves exactly one place a bad boundary can be produced — the hard-cut fallback when no natural boundary exists in the window — so that one place gets an explicit guard:

```js
// A boundary may never land between a high and a low surrogate.
function safeBoundary(str, i) {
  const c = str.charCodeAt(i);
  return (c >= 0xD800 && c <= 0xDBFF) ? i + 1 : i;   // step past the high surrogate
}
```

One function, one call site, one unit test with astral-plane characters (emoji, rare CJK extension-B ideographs, musical symbols). `String.prototype.isWellFormed()` gives a cheap assertion for the test.

#### 3. The offsets are verifiable, because the text is stored too

This is what turns "nobody notices until a user complains" into "the system notices."

`chunk.text` and `document_page.markdown` are both stored. That makes the offsets **checkable against the data itself**, with no external truth needed:

```
assert  chunk.char_end - chunk.char_start === chunk.char_count
assert  page.markdown.slice(rel_start, rel_end) === chunk.text
        where rel_start = chunk.char_start - page.char_start
```

Three places it runs:

- **In the ingest transaction**, as a cheap assertion on every chunk — the strings are already in memory, so it costs a comparison. A failure aborts the document rather than storing a broken locator.
- **In CI**, over a fixture corpus that deliberately contains emoji, CJK, combining marks, RTL text and a zero-width joiner sequence.
- **As a background verifier**, sampling a few hundred chunks per silo per night and re-slicing them. Any mismatch is a loud alarm on the admin dashboard with the offending chunk id, not a quiet wrong highlight three months later.

The verifier is perhaps twenty lines and it converts this entire class of bug from silent to impossible-to-miss. It is worth having even if the fix above were perfect, because it also catches offset drift from a re-extraction bug, a bad migration, or a chunk profile change that half-applied.

#### 4. Don't hand out indices when you can hand out the slices

The remaining exposure is the **public API** (§14): a Python or Go client reading `char_start` and slicing its own string gets code points or bytes, not UTF-16, and would be wrong on astral text. Documenting the unit in OpenAPI is necessary but weak — nobody reads units.

So the API mostly doesn't make clients slice at all:

- `POST /v1/search` returns the **chunk text itself**. The common case needs no slicing.
- `GET /v1/documents/:id/pages/:n?highlight=<chunk_id>` returns the page **pre-split** — `{ before, match, after }` — so the highlight is a render, not an index calculation.
- `char_start`/`char_end` remain in the response as metadata, documented as *"UTF-16 code units, as in JavaScript `String.length`"*, for clients that genuinely want to compute with them.

#### And store the UTF-8 byte offsets too — into the canonical Markdown, for every document

There is a fair objection to UTF-16: the canonical Markdown **is** UTF-8, on disk, in PostgreSQL and in any export. A UTF-8 byte offset is therefore the artefact's own native unit, and it is what a Python, Go, Rust or shell consumer would reach for. That instinct is sound.

The reason UTF-16 is nonetheless the *working* unit is narrow and practical: the two components that actually produce and consume offsets — the chunker in Node and the highlight in the browser — are both UTF-16-native, as is every Markdown parser, tokenizer and `RegExp` they call. Making bytes the working unit means a `Buffer.from(str,'utf8')` round trip at every one of those boundaries: an O(n) allocation of several megabytes per operation on a large document, and a fresh chance to be wrong at each one. PostgreSQL is no help either — `substring()` on `text` counts code points, so byte-slicing there needs `convert_to`/`convert_from` around a `bytea`, which §11.7 has already ruled out by making the database store offsets and never interpret them.

So do both, because it costs almost nothing:

| Field | Unit | Into | Populated |
|---|---|---|---|
| `char_start` / `char_end` | UTF-16 code units | canonical Markdown | always — the working unit |
| `byte_start` / `byte_end` | UTF-8 bytes | canonical Markdown | **always** — the portable unit |
| `offsets_match_original` | — | — | true only when the Markdown is byte-identical to the source file |

Both pairs are computed by the same single producer in the same pass, so they cannot disagree with each other any more than they can disagree with the text. Two extra integers per chunk is ~8 MB per million chunks.

What this buys: a JavaScript client slices with `char_*` and no conversion; every other language slices the exported `.md` with `byte_*` and no conversion; and when `offsets_match_original` is true — a plain UTF-8, LF, already-NFC `.txt` or `.md` file (§10.4) — the byte offsets address the **original file** as well, because the Markdown and the original are the same bytes.

And it strengthens the verifier in part 3: slicing by *both* units must reproduce `chunk.text`. A bug in either representation is caught by the other.

> **Net effect on risk #31:** it stops being a High-severity discipline problem and becomes a Low-severity structural one. One system produces offsets, in the unit its language uses natively, with a single guarded edge case, and a verifier that re-derives them from stored data and shouts if they ever disagree.

### 11.8 Overlap costs 18 %, and creates duplicates you must handle

300 characters of overlap on a 2 000-character target means a stride of 1 700 — so the corpus is chunked at 2 000/1 700 ≈ **1.18× redundancy**. That is 18 % more chunks, 18 % more vectors, 18 % more index, and — the one that matters on this hardware — **18 % more embedding time**, the slowest thing in the system. It's worth it, and it should be a deliberate 18 % rather than an accidental one. 15 % overlap is the conventional sweet spot and 300/2 000 sits right in it.

The consequence people forget: **adjacent chunks share text, so both match the same query.** Without handling, a top-10 becomes the same passage three times with slightly different edges. So after fusion (§13.1), collapse hits from the same **document** whose character ranges overlap or abut — keep the best score, widen the displayed span to the union of the ranges, widen the page range to `min(page_start) … max(page_end)`, and count it once toward the limit. This belongs in the retrieval path, not the chunker, and it is the difference between results that look sharp and results that look broken.

### 11.9 The settings, their limits, and what changing them costs

Chunk size, overlap and the token guard are **system-wide** (§7.8) — one `settings` row, not a per-silo profile. Changing any of them invalidates every chunk and every vector in the corpus, which on this hardware is hours to days of re-embedding (§9.5), so the change does not mutate anything: it **proposes a build** (§7.5), which populates staging partitions in the background and swaps them in when complete. Search never goes down.

**The limits, and why each one is where it is:**

| Setting | Range | Default | Why the bound |
|---|---|---|---|
| `target_chars` | 200 – 8 000 | **2 000** | Below ~200 a chunk carries no context and retrieval degrades to keyword matching with extra steps. Above ~8 000 it is ~2 000 tokens of English — near the practical `max_tokens` ceiling, and coarse enough that a hit points at three topics at once |
| `overlap_chars` | 0 – 50 % of target | **300** | Redundancy is `target / (target − overlap)`. At 15 % that's 1.18×; at 50 % it's **2×** — double the embedding time, which on this hardware is the whole budget. The database refuses anything above half |
| `max_tokens` | 128 – 2 048 | **1 024** | Must not exceed the ONNX session's `max_seq_len` (§9.2); raising it raises activation memory and attention cost on an 8 GB box |
| `snap_window` | 0 – 0.5 | **0.15** | 0 means hard cuts at exactly `target_chars`. Above ~0.3, chunk sizes vary so much that ETA projections stop being meaningful |
| `heading_prefix` | on / off | **on** | §11.5. Costs 10–25 tokens per chunk; whether it earns them is an evaluation question (§16) |

Two rules the **UI** enforces beyond what the database can:

- **Coherence warning.** If `target_chars ÷ 4` (the English estimate) exceeds `max_tokens × 0.8`, most chunks will trip the token guard and be split anyway — so the setting isn't doing what it says. The form says so, using the corpus's *measured* characters-per-token once there is content to measure, not the 4 estimate.
- **Cost preview on the button.** Before confirming, show projected redundancy (`1.18×`), projected total chunk count, and projected re-embedding hours from measured throughput. This is the one screen in the application where an idle two-character edit commits the machine to three days of work.

`build.rules_version` exists so that a **bug fix in the boundary snapper** is also recognised as a rebuild, rather than silently producing chunks that don't line up with their neighbours. `chunk.build_id` records which build produced each row, so provenance survives even mid-rebuild.

Two scopes of rebuild, both using the same machinery:

- **One document** — after an edit, or an operator forcing a re-index. Runs in place under the active build, no staging tables.
- **The whole library** — a settings change or a model swap. Staging partitions, background population, atomic swap; per silo for a same-model change, all silos in one transaction for a model change (§7.5).

### 11.10 The arithmetic, so the estimates are checkable

Chunks flow across pages (§11.6), so the count is a function of the document's total characters, not its page count:

```
stride  = target_chars − overlap_chars          = 1 700 by default
chunks  = max(1, ceil((total_chars − overlap) / stride))     then runt-merge
```

| Corpus | Chars | Chunks | Embedding time @ 6–15 s/chunk |
|---|---|---|---|
| 20-page report | ~50 K | ~30 | 3–8 min |
| 500-page PDF | ~1.25 M | **~735** | **1.2–3.1 hours** |
| 40-sheet workbook | ~400 K | ~235 | 24–59 min |
| 10 000 mixed documents | ~250 M | ~147 000 | **days** — the overnight-batch reality of §9.5 |

The 500-page figure is ~27 % lower than the page-bounded design it replaces, purely because no chunk is now forced to restart at a page boundary. That is 27 % off the slowest operation in the system, for free.

Storage per 1 M chunks stays as budgeted in §6.8: ~2 KB of `halfvec` plus HNSW graph overhead, ~2–3 GB of index that wants to live in page cache.

The number to show users during ingest is **characters per second**, not chunks per second — it's stable across documents and formats, it's what a projected completion time can honestly be computed from, and it doesn't change meaning when someone edits a chunk profile.

---

## 12. Vision analysis via Ollama

The one part of the system that deliberately leaves the NAS. A 0.6B embedding model on NAS silicon is already an overnight batch (§9.5); a vision-language model would be hopeless. So images go to an Ollama host — a desktop, a GPU box, or Ollama Cloud — and the NAS keeps the storage, the index and the orchestration.

### 12.1 The request

Ollama takes base64 image data in the `images` array. `/api/chat`:

```json
POST http://gpubox.lan:11434/api/chat
{
  "model": "qwen3-vl:8b",
  "messages": [{
    "role": "user",
    "content": "<the extraction prompt>",
    "images": ["<base64 PNG, no data: prefix>"]
  }],
  "stream": false,
  "keep_alive": "30m",
  "options": { "temperature": 0, "num_ctx": 8192 },
  "format": { ... JSON schema ... }
}
```

Three fields do most of the work:

- **`format`** accepts a JSON Schema, not just `"json"`, and Ollama constrains generation to it. That turns "please return a markdown table" from a prompt-engineering hope into a structural guarantee.
- **`keep_alive`** keeps the model resident between calls. Without it, a VLM reloads per request and a batch of 40 images spends most of its time on model loading.
- **`temperature: 0`** — this is transcription, not writing.

The schema we ask for:

```json
{
  "type": "object",
  "required": ["kind", "markdown", "alt", "confidence"],
  "properties": {
    "kind":     { "enum": ["table","chart","diagram","screenshot","photo",
                           "formula","logo","decorative"] },
    "markdown": { "type": "string" },
    "alt":      { "type": "string" },
    "confidence": { "type": "number" }
  }
}
```

Then the ingest side decides what to do: a `table` with high confidence is spliced in as a Markdown table; a `chart` becomes a prose description plus any readable data series; `decorative` or `logo` is dropped to alt text alone and added to the silo's decorative-hash set so it is never sent again; low confidence anywhere falls back to alt text with a flag the UI can surface.

The prompt is deliberately narrow — transcribe what is there, produce GitHub-flavoured Markdown, do not interpret, do not summarise, return the table verbatim including empty cells. A VLM asked to "describe this image" will editorialise; asked to transcribe, it mostly transcribes.

### 12.2 Configuration

| Setting | Notes |
|---|---|
| Base URL | `http://host:11434`. Reachability from the NAS is the thing that breaks — validate at save time, not at 2 a.m. |
| Bearer token | See below |
| Model | Free text with a picker populated from `GET /api/tags` |
| Max parallel calls | Client-side semaphore. **Must not exceed the server's `OLLAMA_NUM_PARALLEL`** or requests queue invisibly and time out |
| Request timeout | Per call; a 30 s default is short for a large page image |
| Retries | Exponential backoff, capped; then `pending_vision`, never a hard failure |
| `keep_alive` | Default `30m` |
| Max image dimension | Downscale before sending — the single biggest lever on latency and token cost |
| Enabled per silo | Some silos are pure text and shouldn't pay for vision at all |

**A correction worth making explicitly: a self-hosted Ollama has no API key.** Its API is unauthenticated by design — anyone who can reach the port can use the models, and there is no auth header in the API reference. The token field in NodeRag's config therefore serves two real cases: **Ollama Cloud**, which does issue API keys and expects `Authorization: Bearer …`, and a **reverse proxy** in front of a self-hosted instance doing the auth. The UI should say this plainly rather than presenting an "API key" box that does nothing on a LAN Ollama, and it should warn when the configured base URL is a plain-HTTP non-loopback address with no token — because that is an open inference endpoint on the network.

**A test button that actually tests something**: `GET /api/tags` to confirm reachability and list models, then one round trip with a bundled sample table image, showing the returned Markdown and the elapsed time. That single click answers "is it configured, is the model right, and how slow will ingest be."

### 12.3 Throughput and failure

Vision calls are the slowest stage in the pipeline and the only one with a network dependency, so they are queued separately from embedding — the two run concurrently because they run on different machines, which is most of the reason for splitting the work this way at all. Parallelism is the configured semaphore, shared across all silos and fair-shared the same way (§9).

Everything is cached by image content hash, globally and silo-agnostically, exactly like the embedding cache. The cache is what makes a re-index nearly free and what keeps repeated letterheads from dominating the bill.

When Ollama is unreachable the pipeline does not stall: images are marked `pending_vision`, the document ingests with alt-text placeholders, and a background sweep retries them when the host comes back. The admin UI shows a "N images awaiting vision" count with a manual retry — a visible, recoverable state rather than a stuck queue.

---

## 13. Search

Two modes, plus one I'd argue for.

| Mode | What it does | Default |
|---|---|---|
| `vector` | Embed the query, ANN search over permitted partitions | **Yes** |
| `keyword` | Postgres full-text over the same scope | |
| `hybrid` | Both, fused with Reciprocal Rank Fusion | Available — see below |

**The case for hybrid, made once and then dropped.** Vector search is the right default and handles the "what does this mean" queries that motivate a RAG database at all. But on real document corpora it reliably loses to keyword on exact tokens — part numbers, invoice IDs, surnames, error codes, quoted phrases — because those carry almost no semantic signal. RRF fusion costs one extra query against an index that already exists (the GIN index is built regardless) and is close to free at this scale. My recommendation is to ship all three, keep `vector` as the default as specified, and make `hybrid` a one-click toggle in the UI and a parameter in the API. If it earns its place in use, promote it later.

### 13.1 The query path

```
0. Resolve the SiloScope: gateway ceiling ∩ principal grants ∩ requested silos.
   Empty scope → empty result, before any work is done.
1. mode = vector | keyword | hybrid   (default: vector)
2. vector:  embed the query with the "Instruct: …\nQuery: …" prefix (§9.1),
            then over the permitted partitions only:
              WHERE silo_id = ANY($scope) ORDER BY embedding <=> $1 LIMIT k
            Partition pruning gives one proper top-k scan per silo, then a merge;
            scores are comparable because it's one model and one metric (§6.5).
            hnsw.ef_search = 100; hnsw.iterative_scan = relaxed_order as a net.
3. keyword: ts_rank_cd over the per-partition GIN tsvector, same scope,
            websearch_to_tsquery so users can type "quoted phrases" and -negation
4. hybrid:  both of the above, fused with RRF (k = 60)
5. Filters: silo, source, path prefix, format, page range, date range,
            has_images — SQL predicates inside the already-pruned partitions
6. Collapse overlap: adjacent chunks share 300 chars (§11.8), so hits from the
   same page with overlapping or abutting char ranges are merged — best score
   kept, displayed span widened to the union, counted once toward the limit.
   Without this the top 10 is the same passage three times.
7. Assemble: chunk text + page_start/page_end + page_label + page_basis
             + char_start/char_end + heading path + document title, path,
             format and a hash-verified link to the original (§13.2)
8. Audit: one row — principal, gateway, scope, mode, hit count, latency
```

Reranking with a cross-encoder would improve precision noticeably and is unaffordable on this CPU next to the embedder. The `rerank` hook stays in the API contract, disabled, for the day an external endpoint exists.

### 13.2 What a result carries

Every hit is a chunk, and every chunk knows where it came from:

```json
{
  "chunk_id": 918273,
  "silo": "legal",
  "score": 0.81,
  "markdown": "…the indemnity shall survive termination…",
  "locator": {
    "page_start": 37,
    "page_end": 38,
    "page_label": "pp. 37–38",
    "page_basis": "exact",
    "char_start": 117000,
    "char_end": 119000,
    "char_unit": "utf16",
    "byte_start": 121483,
    "byte_end": 123604,
    "offsets_match_original": false
  },
  "heading_path": ["Schedule 3", "Indemnity"],
  "part_of": null,
  "document": {
    "id": 4471, "title": "MSA — Acme 2025.pdf", "format": "pdf",
    "path": "Legal/Contracts/MSA — Acme 2025.pdf",
    "pages": 46, "chars": 1248317,
    "original_available": true
  }
}
```

Every hit carries **both** locators, always. The page range is what a person wants when opening the original; the character range is what works everywhere — it is the only locator a `.txt` or `.md` document has, it drives highlight-on-open, and it is exact where a page number may be approximate.

Three fields exist specifically so a consumer never has to guess:

- **`page_basis`** travels with the page range, so an exact PDF page is distinguishable from a Word document's last-rendered estimate (§10.1) and from a spreadsheet's sheet index.
- **`page_label`** is the rendered form, because the right words differ by format: `p. 12`, `pp. 37–38`, `Sheet: Q3 Detail`, or absent entirely for a plain text file. Computing this once on the server stops every client inventing its own.
- **`offsets_match_original`** says whether `char_start`/`char_end` also address the original file. True for `.txt` and `.md`, false for the rest — a client deep-linking into a source file needs to know before it tries.

`original_available` is checked, not assumed — the hash is verified before the link is offered.

Both offset pairs address the **canonical Markdown** and are always present (§11.7): `char_*` in UTF-16 code units, which is what JavaScript's `.slice()` takes; `byte_*` in UTF-8 bytes, which is what every other language and the exported `.md` file take. `offsets_match_original` says whether the Markdown is byte-identical to the source file — when true, `byte_*` addresses the original too. Most clients need neither: `POST /v1/search` returns the chunk text, and the page endpoint returns a page pre-split around the highlight.

---

## 14. REST API

**Full parity is a design rule, not an aspiration:** the web front end is *a client of this API and nothing more*. It gets no private endpoints, no privileged session shortcuts, no server-rendered data the API can't return. The cheapest way to guarantee that is to build the UI against the public API from the first commit, which also means the API gets exercised constantly instead of rotting behind a UI that bypasses it.

### 14.1 Auth

```
Authorization: Bearer nrag_a7f3c1d9_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx     API key
Cookie: nrag_session=…                                                    browser
```

Both resolve to a principal (§6.2) before any handler runs, and every handler receives a `SiloScope`, never a raw principal id. Rate limits are per key; `429` carries `Retry-After`. Errors are RFC 9457 problem+json. Every list endpoint is cursor-paginated. A silo the principal cannot see returns **404, never 403** — the API does not enumerate silos for an attacker.

### 14.2 Surface

```
── search & retrieval ──────────────────────────────────── (read)
POST   /v1/search                  { query, mode?, silos?, filters?, limit?, cursor? }
POST   /v1/embed                   raw embedder access for other tools
GET    /v1/silos                   the principal's silos + its permission on each
GET    /v1/documents               list/filter within scope
GET    /v1/documents/:id           metadata, page count, page_basis, image count
GET    /v1/documents/:id/markdown  the canonical markdown file    † not search_only
GET    /v1/documents/:id/pages/:n  one page's markdown
       ?highlight=<chunk_id>       → { before, match, after } pre-split,
                                     so no client ever slices by index (§11.7)
GET    /v1/documents/:id/original  the original bytes, hash-verified † not search_only
GET    /v1/chunks/:id              chunk + neighbours for context
GET    /v1/images/:id              extracted image + its vision markdown

── ingestion ──────────────────────────────────────────── (upload)
POST   /v1/sources                 register a folder against a silo
GET    /v1/sources/:id             config + last crawl + error summary
POST   /v1/sources/:id/crawl       trigger now
POST   /v1/documents               direct upload, bypassing folder crawl
DELETE /v1/documents/:id           **purges everything** — rows, files, cache (§7.6)
POST   /v1/documents/:id/reindex   re-extract, re-chunk and re-embed one document
POST   /v1/images/:id/revision     re-run one image against the VLM
GET    /v1/jobs                    queue state; SSE at /v1/jobs/stream

── administration ─────────────────────────── (server_admin)
POST   /v1/admin/silos             creates the silo AND its partitions (DDL, §7.1)
GET    /v1/admin/principals        users and API keys
POST   /v1/admin/principals        create; key returned exactly once
POST   /v1/admin/grants
GET    /v1/admin/audit
GET    /v1/admin/health            embedder, Ollama, DB, disk, queue depth
GET/PUT /v1/admin/settings         the single settings row (§7.8)
POST   /v1/admin/builds            propose a rebuild; returns projected
                                   chunk count and hours before it starts
GET    /v1/admin/builds/:id        progress; PATCH to pause, resume or cancel
POST   /v1/admin/builds/:id/activate   the swap (§7.5)
DELETE /v1/admin/silos/:id         purges the silo, then drops its partitions
GET    /v1/admin/health            embedder, Ollama, DB, disk, queue depth
```

† Endpoints marked *not search_only* are refused for API keys with `search_only` set, which is the default (§6.3). A leaked key returns passages, not the corpus.

`GET /v1/openapi.json` is generated from the same route schemas the server validates against, so it cannot drift from the implementation.

### 14.3 MCP

`/mcp` alongside REST — same auth, same scope resolution, same audit rows — exposing `search_documents`, `get_document_page` and `list_silos` as tools. An API key's grants become the tool's reach automatically, which is the whole reason the principal model was built the way it was (§6.2). The point of a RAG database on a NAS is for an assistant to query it; this is the endpoint that makes that a five-minute setup rather than a project.

---

## 15. Web front end

A single-page app served as static files by Fastify. No SSR, no framework that needs a build server running on the NAS — the CPU budget belongs to the embedder. Preact or Svelte plus Vite, bundled at build time, shipped inside the SPK. It talks to §14 and nothing else.

### 15.1 Search — the screen that matters

The whole product is judged here, so it gets the detail:

- **One query box.** Mode is a segmented control next to it — *Meaning* / *Keyword* / *Both* — defaulting to Meaning. Plain words, not "vector" and "BM25"; the people searching their own documents should not need to know what an embedding is.
- **Silo scope as chips** above the box, showing only silos the principal can search, all selected by default. This is the single most important affordance in the app: it makes the security boundary visible instead of hidden in a settings page.
- **Results are passages, not files.** Each hit shows the matching Markdown with query terms highlighted, the document title, and the locator as a first-class element rather than a footnote. The locator is format-aware — `p. 12`, `pp. 37–38` when a chunk crosses a page break, `Sheet: Q3 Detail` for a workbook, and for a `.txt` or `.md` file the character range (`chars 117 000–119 000`) plus a percentage-through-the-document bar, which is the honest locator when there are no pages. A subtle marker appears when `page_basis` isn't exact, hover-explained. Consecutive hits from the same document group under one header instead of flooding the list.
- **Three actions per hit:** *Preview* opens a side panel at the chunk's character range with the hit highlighted and prev/next paging — a chunk spanning pages 37–38 shows the passage whole, across the break, rather than truncating at a page edge; *Open original* opens the source file deep-linked as far as the format allows (`#page=12` for PDFs, the sheet for a workbook, the character offset for text and Markdown); *Copy citation* yields title, locator and a link.
- **Filters that reflect this system:** silo, format, path prefix, date, page range, has-images, and "only pages containing tables" — which is worth surfacing precisely because the vision pipeline is what makes it possible.
- **Empty states that explain themselves.** No results in `vector` mode offers keyword; no results in any mode with a narrow scope offers to widen it; zero grants explains who to ask.

### 15.2 The rest

- **Documents** — browse a silo, see per-document ingest state, page count, page basis, image count, and `pending_vision` warnings. Per-document reindex.
- **Ingest** — sources per silo with crawl schedule and ingest window, live queue with an honest ETA from measured throughput (§9.5), and a **failures list with reasons and one-click retry**. Failed ingests are where trust is won; burying them in a log file is how a system stops being used.
- **Admin** — silos, users, API keys (grants edited as a permission matrix), audit log with filters, storage and working-set gauge (§6.8), embedder stats, Ollama config with the test button (§12.2).
- **Setup wizard** — the §4 first-run flow, same SPA, same API.

Accessibility and dark mode from the start; this is a tool people will stare at. Keyboard-first: `/` focuses search, `↑`/`↓` move through hits, `Enter` previews.

Two internationalisation details belong in this layer and only this layer (§10.4): truncate snippets with `Intl.Segmenter` at grapheme granularity, never at a raw index, or a flag or family emoji renders as broken fragments; and set `dir="auto"` on snippet containers so Arabic and Hebrew lay out correctly. A highlight span in RTL text may render visually discontiguous while being logically contiguous — that is correct, and should not be "fixed".

---

## 16. Evaluation: how you know retrieval actually works

The largest omission in this plan so far. Every tuning knob defined above — chunk size, overlap, `hnsw.ef_search`, vector versus keyword versus hybrid, whether the heading prefix helps, whether q4 is as good as q8, whether a different embedding model is worth a week of re-embedding — is **unanswerable without a way to measure retrieval quality**. Without one, tuning degrades into changing a number, running one query that looks better, and shipping. That is how RAG systems end up quietly worse after six months of well-intentioned adjustment.

This is cheap to build and it should exist before Phase 5, not after.

### 16.1 A golden set, made from the real corpus

Fifty to a hundred question→expected-passage pairs drawn from the user's own documents. Not synthetic, not from a public benchmark — the whole point is that it reflects *this* corpus, *these* file formats and *these* users' phrasing.

```
{ "id": "q014",
  "silo": "legal",
  "query": "what's the notice period for termination for convenience",
  "relevant": [ { "document": "MSA — Acme 2025.pdf", "pages": [12, 13] } ],
  "notes": "phrased the way a person asks, not the way the contract words it" }
```

Relevance is recorded at **page and document** level rather than chunk id, so the golden set survives every re-chunk. That single decision is what stops the evaluation harness from being invalidated by the change it exists to measure.

Build it in the UI: a "mark this result correct / this one wrong" control on the search screen that appends to the golden set. Fifty pairs is an afternoon of a domain expert's time, and it pays for itself the first time it prevents a bad chunk-size change.

### 16.2 Metrics that matter here

| Metric | Why this one |
|---|---|
| **Recall@10** | The retrieval question that actually matters for RAG: did the right passage make it into the context at all? |
| **MRR** | How far down the user has to look |
| **nDCG@10** | Ranking quality when several passages are relevant |
| **Zero-result rate** | The failure users report as "it doesn't work" |
| **p50 / p95 latency** | Split by mode; vector, keyword and hybrid have very different profiles |

Report per silo and per format. A number that looks fine overall often hides "PDF is good, Excel is terrible" — which is exactly the finding that would send you back to §10.8's wide-sheet rules.

### 16.3 What it's for

Run the harness on every change to extraction, chunking, embedding or search, and record the result alongside the config that produced it. That makes the decisions this document keeps deferring into measurements instead of arguments:

- **Is hybrid worth defaulting to?** §13 argues yes and defers to you. One run answers it for your corpus.
- **Is q4 good enough?** If Recall@10 is within a point of q8 and it's 1.6× faster, that's days of ingest time reclaimed (§9.5).
- **Does 2 000/300 beat 1 200/200 or 3 000/400?** Three runs, one afternoon, on chunk profiles that already version cleanly (§11.9).
- **Is the heading prefix earning its tokens?** (§11.5)
- **Is a new embedding model worth the re-embed?** This is the one that matters most later, and the one you cannot answer honestly without a baseline recorded today.

### 16.4 Regression, not just tuning

Freeze a baseline result per silo and run the harness nightly against the live index. A drop in Recall@10 with no config change means something broke upstream — an extraction regression, a half-applied re-chunk, a corrupted HNSW index, a silo whose `ts_config` changed. It is the same instinct as the locator verifier (§11.7): make the system notice its own failures rather than waiting for a user to describe them badly.

Where it fits: build the harness in **Phase 5** alongside search, use it to set the defaults, and keep it running from then on. It is perhaps two days of work and it is the difference between tuning and guessing.
---

## 17. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `onnxruntime-node` won't load on DSM's libstdc++ | **High** | Phase 0 spike #1; fall back to bundling libstdc++, then to a source build |
| 2 | Embedding is slower than users tolerate | **High** | Calibration benchmark in the wizard; q4 default; scheduling window; never re-embed unchanged content |
| 3 | PG major upgrades across NodeRag versions | **High** | §8.4 dump/restore path built in v1, not retrofitted |
| 4 | 8 GB RAM contention between PG and ONNX | Medium | Global mutex; conservative `shared_buffers`; refuse to start HNSW build during ingest |
| 5 | Synology deprecates `Node.js_v22` (they EOL'd v12 already) | Medium | Keep the option to bundle our own Node build in spksrc; the app must not use anything Synology-specific |
| 6 | DSM 7.3+ changes package APIs | Medium | Pin `os_min_ver`, test on each DSM RC, keep privilege/resource files minimal |
| 7 | Cross-compiling PG for every x86_64 platform | Medium | Lean on spksrc's existing `cross/postgresql`; build for `x86_64` generic first, add platforms on demand |
| 8 | User puts PGDATA on an ACL-enabled shared folder; PG refuses to start on the 0700 check | **High** | §5.4 permission probe before accepting any path; fall back to tablespace-only relocation |
| 9 | PGDATA on an encrypted share that mounts after the package starts | Medium | Detect and refuse encrypted shares; mount-wait in `prestart` if ever supported |
| 10 | Cloud Sync / Drive / Universal Search / Snapshot Replication operating on a live PGDATA | Medium | Prefer `@appdata` (invisible to them); warn at path-selection time |
| 11 | User points the data root at a network share | Low | Wizard validates filesystem type and refuses |
| 12 | **Cross-silo leak** — a query path that forgets its scope | **High** | §6.4: `SiloScope` as a required argument (won't compile without it), RLS backstop, partition boundaries, and a test that runs every endpoint as a zero-grant principal |
| 13 | Filtered HNSW returns near-empty results for a small silo | **High** | §6.5: LIST partitioning with a per-silo index — this is the whole reason for it; `iterative_scan = relaxed_order` as a safety net |
| 14 | RLS predicate defeats partition pruning or the HNSW scan | Medium | Benchmark with RLS on/off in Phase 4; fall back to RLS on metadata tables only |
| 15 | Ingest in one silo blocks search in another (shared, non-preemptible embedder) | **High** | §9: priority queue with batch size 1; separate query session if RAM allows; per-silo ingest windows |
| 16 | Too many/too large silos thrash the page cache; planning time grows with partitions | Medium | Working-set gauge in the admin UI; cap silos ~64; budget total chunks, not silos |
| 17 | Users expect per-silo *filesystem* isolation and don't get it | Medium | All silos run as one package user; state it plainly in the UI. Separate SPKs are the only real answer |
| 18 | Leaked API key | Medium | §6.8: `search`-only default grant, optional expiry and CIDR allow-list, per-key rate limit, `last_used`, instant revocation, audit trail |
| 19 | Runtime-created gateway ports vs the static `.sc` firewall file | Low | Declare a port range at install, cap gateways, probe before binding |
| 20 | **DOCX page numbers are unavailable or wrong** — OOXML has no page concept | **High** | §10.1: detect and record `page_basis`; never present a guess as exact; optional LibreOffice conversion on the companion host |
| 21 | Ollama host unreachable mid-ingest | Medium | §12.3: `pending_vision` state, document ingests anyway, background retry, visible count in the UI |
| 22 | Vision calls dominate ingest time or cost | Medium | §10.6 size/entropy filters, global image-hash cache, downscaling, per-silo enable, configured parallelism |
| 23 | VLM hallucinates table contents that then look authoritative in search | **High** | `temperature: 0`, JSON-schema-constrained output, transcribe-don't-interpret prompt, confidence threshold, provenance comment in the markdown so any cell can be traced back to its image |
| 24 | Table reconstruction from a PDF text layer produces plausible nonsense | Medium | §10.3: low-confidence table regions are routed to the VLM as images instead |
| 25 | Original file moved, renamed or deleted after indexing | Low | §10.7: hash-verified reference, or content-addressed copy; degrade to "searchable but not openable" with a clear message |
| 26 | Unauthenticated Ollama endpoint exposed on the LAN | Medium | §12.2: warn on plain-HTTP non-loopback with no token; state plainly that self-hosted Ollama has no auth |
| 27 | **Chunk over `max_seq_len` is silently truncated** — the tail never reaches the vector while the text still displays | **High** | §11.3: measure `token_count` on every finished chunk and split above `max_tokens`; a character rule cannot bound tokens |
| 28 | Changing chunk parameters or the model invalidates every vector in the corpus | Medium | §7.5: builds run into staging partitions and swap in, so search never goes down; projected hours shown before confirming; resumable and pausable |
| 28b | **A model swap flipped per silo rather than atomically** — two models' scores compared in one search | **High** | §7.5: same-model rebuilds may flip per silo; a model change flips every silo in one transaction |
| 29 | Overlapping chunks return the same passage repeatedly | Medium | §13.1 step 6: collapse hits with overlapping char ranges on the same page |
| 30 | CJK or code-heavy silos drift far from the intended tokens-per-chunk | Low | §11.2: lower `target_chars` per silo rather than raising `max_tokens` |
| 31 | Character offsets disagree between components — JS counts UTF-16 units, Postgres counts code points | Low *(was High)* | §11.7, structurally: the chunker is the **only** producer and Postgres never interprets offsets (CI-checkable); the unit is UTF-16 so no conversion exists anywhere; the single hard-cut edge case is surrogate-guarded; and a verifier re-slices sampled chunks nightly by **both** units, turning a silent bug into an alarm |
| 32 | Excel dates and currency indexed as raw serial numbers (`45292`, not `2024-01-01`) | **High** | §10.8: apply the cell number format and emit the formatted string — it is what the user sees and therefore what they search for |
| 33 | Workbook saved without cached formula values | Medium | §10.8: index cached values; flag the document rather than emitting zeros |
| 34 | A 200 MB workbook loaded fully into the Node heap gets the package OOM-killed | Medium | §10.8: `exceljs` streaming reader; never a full in-memory parse |
| 35 | A split table fragment retrieved without its header is meaningless noise | Medium | §11.4: repeat the header row in every part, carry the row range and `part_of` |
| 36 | Widening `overlap_chars` toward 50 % silently doubles embedding time | Medium | §11.9: DB `CHECK` caps overlap at half of target; UI shows projected redundancy and re-embed hours before saving |
| 37 | **Mis-detected `.txt` encoding indexes mojibake** — unsearchable and it pollutes the vector space | **High** | §10.4: BOM → strict UTF-8 → detector, with `encoding_confidence` surfaced in the UI for a human to eyeball |
| 38 | **NFC/NFD mismatch silently loses matches** on accented, Vietnamese or Korean text | **High** | §10.4: normalise documents *and* queries to NFC, before offsets are computed; record `normalization` per document |
| 39 | BOM stripped after offsets are computed — every offset off by one | Medium | §10.4: fixed pipeline order, decode before paginate; the §11.7 verifier catches it if it ever regresses |
| 40 | Snippet truncation splits a grapheme cluster and renders broken glyphs | Low | §15.1: `Intl.Segmenter` for display truncation only, never in the locator path |
| 41 | **PDF font with no `/ToUnicode` CMap** — extracted text is gibberish that still looks like text | **High** | §10.5: per-page extraction-confidence gate on replacement and private-use characters; failing pages route to the VLM |
| 42 | **PDF reading order wrong** on multi-column layouts — sentences interleave across columns | **High** | §10.5: reconstruct order from glyph coordinates with column detection; the largest single quality lever in PDF extraction |
| 43 | Ligatures and line-break hyphenation break keyword search (`ﬁle`, `develop-ment`) | Medium | §10.5: fold the five Latin ligatures and de-hyphenate conservatively, before offsets are computed |
| 44 | A 400-page scan silently becomes 400 vision calls | Medium | §10.5: count failing pages per document and show the projected vision cost before ingest starts |

### 17.1 What aarch64 would cost later

Not much, if the decisions above hold: spksrc already builds PG for aarch64, and `onnxruntime-node` has linux-arm64 prebuilds. The blocker is purely §9.5 — a 0.6B model on an RTD1619B is somewhere between 5× and 20× slower than the x86_64 target, which puts it past "overnight" into "never finishes." Adding ARM support realistically means adding a remote-embedding provider at the same time, which is why the build mechanism (§7.5) and the provider abstraction in §9 are worth keeping clean even though v1 is local-only.

---

## 18. Roadmap

| Phase | Goal | Exit criteria |
|---|---|---|
| **0. Spikes** | De-risk the two unknowns | `onnxruntime-node` runs one inference on the NAS; cross-built PG 17 + pgvector starts as the package user; real seconds-per-chunk number recorded |
| **1. Package skeleton** | A `.spk` that installs cleanly | Installs via Package Center, creates the package user, picks a volume, serves a "hello" page on :8787, starts/stops/uninstalls cleanly |
| **2. Database + silos + identity** | Postgres in the box, access control from day one | `initdb` on first run, migrations, schema from §7 including partitioned silos; create/delete a silo from the UI (with its partitions); users, API keys, grants, sessions, audit log; the zero-grant-principal test suite passes |
| **3. Ingest + embedding** | Content goes in | TXT/MD/PDF/DOCX/XLSX → page-scoped markdown with `page_basis` detection and sheet-per-page workbooks (§10.8); character chunker with boundary snapping, atomic units, header-repeating table splits, heading prefix and token guard (§11); dual locators (page range + code-point char range); versioned, bounded chunk profiles; model download + verify; standalone embedder with priority + fair-share queue across silos; embedding cache (§6.6); resumable ingest; calibration benchmark |
| **3b. Locator verifier** | Offsets can't drift silently | §11.7: in-transaction assertion on every chunk, astral-plane CI fixture corpus, nightly sampling verifier surfacing mismatches on the admin dashboard |
| **4. Vision** | Images become text, and so do bad PDF pages | Ollama client with schema-constrained output, config + test button, image filters and global hash cache, `pending_vision` retry sweep, markdown splicing with provenance, and the §10.5 page-level extraction gate routing failed and scanned pages through the same path |
| **5. Search + API** | Content comes out | `/v1/search` in all three modes across permitted partitions, RLS benchmark and decision, full REST surface with parity, OpenAPI generated from route schemas, gateways, MCP endpoint |
| **6. Front end** | People can use it | Search screen (§15.1), document browser and page preview, ingest console with failures and retry, admin screens, setup wizard |
| **7. Polish** | Shippable | Hyper Backup integration, log rotation, upgrade path tested 1.0→1.1, accessibility pass, docs |

---

## 19. What still needs deciding

Triaged, because the list above has grown and not all of it blocks anything. Three groups.

### 19.1 Decided

| # | Decision | Resolution |
|---|---|---|
| D1 | What ships as v1.0 | **The full system.** No deferred phases. §18 is re-ordered so a thin vertical slice works early, rather than each layer being finished in turn |
| D2 | Silos and multi-user in v1 | **Yes, both.** `silo_id` as partition key and `principal` through every query path from the first migration. The irreversible decision, taken deliberately |
| D3 | Distribution and updates | **Manual `.spk` upload.** No repo, no SynoCommunity, no auto-update. spksrc layout kept upstream-compatible so a repo stays possible |
| D5 | Delete semantics | **Both modes**, as §6.6 describes: `remove` keeps the shared caches, `purge` refcount-drops every cache row reachable only from that document. Refcounting is in the schema from migration 1 |
| D6 | Licence | **Private / internal.** Dependency licences catalogued from commit 1; no GPL runtime dependencies, so the position stays reversible |

| D7 | Scope of configuration | **System-wide.** Chunk size, overlap, model, threads, vision, search defaults live in one `settings` row (§7.8). Silos carry access control only |
| D8 | Silo permissions | **`read` and `upload`.** `upload` includes delete. `server_admin` for the rest. API keys additionally default to search-only (§6.3) |
| D9 | Delete semantics | **Always a full purge** (§7.6), superseding the earlier two-mode design |
| D10 | Rebuild mechanism | **Builds with staging-partition swap** (§7.5), covering chunk-size changes and model swaps with one mechanism |

Still open, and cheap to answer late:

| # | Decision | Notes |
|---|---|---|
| D4 | Keyword-search language | `ts_config` is now system-wide and baked into a generated column; changing it reindexes `tsv` only — minutes, not days. `'simple'` is the safe default for mixed corpora |
| D11 | Should `upload` include delete? | Currently yes (§6.3). Splitting delete into a third permission is cheap now and expensive once people rely on two levels |

### 19.2 Measure, don't decide — Phase 0, before any of the above matters

These are not questions for anyone to answer from a chair. They are a few days of work whose results change the plan.

| # | Spike | Kills the project if it fails |
|---|---|---|
| S1 | `onnxruntime-node` loads and runs one inference on the actual NAS | **Yes** — this is the highest-risk item in the document (§1.3) |
| S2 | Cross-built PostgreSQL 17 + pgvector starts as the package user under DSM 7 | **Yes** |
| S3 | Real seconds-per-chunk, q8 vs q4 vs fp16, at 512/1024 tokens, 1…N threads | No, but it sets every estimate in §9.5 and may change the default quantisation |
| S4 | The §5.4 permission probe against a real ACL-enabled shared folder | No — it decides whether PGDATA can live where you want it |
| S5 | One real page of each format end-to-end: a scanned PDF, a two-column PDF, a Word doc saved by Word, one saved by Google Docs, a messy workbook | No, but it turns §10.5 and §10.8 from reasoning into fact |
| S6 | One Ollama round trip from the NAS with a real table image, timed | No — it sets the vision cost model |

### 19.3 Facts about your environment that turn estimates into numbers

1. **The NAS model.** Sets the spksrc platform target, the thread count, and whether §9.5's estimates are optimistic or pessimistic.
2. **Volume and share layout**, and whether the shares are ACL-enabled (§5).
3. **Corpus shape** — document count, total GB, format mix. Drives everything in §10 more than any other input.
4. **The Ollama host and VLM.** A 3090 answering in 2 s and a laptop answering in 40 s are different ingest plans. Settle the model by running your own pages through candidates, not from a leaderboard.
5. **How much of the DOCX corpus was actually saved by Word** — decides whether `page_basis` is usually `rendered` or usually `none` (§10.1).
6. **How big and messy the workbooks are** (§10.8).
7. **Who queries it** — MCP client, browser, or another app. Decides whether the MCP endpoint is Phase 5 or Phase 1.
8. **Is overnight indexing acceptable?** If not, §0's local-only constraint is the thing to revisit; everything else survives unchanged.

### 19.4 Deliberately deferred

Recorded so they are not rediscovered as surprises: reranking (§13, unaffordable on this CPU); DSM SSO (§4, needs root); LibreOffice DOCX→PDF for exact pagination (§10.1, only if D-questions say Word pagination matters); aarch64 (§17.1); `.pptx`, `.html`, `.eml`, `.csv`, `.xls`; and per-user document-level ACLs finer than the silo.

---

## Companion documents

- **`IMPLEMENTATION.md`** — build order, repo layout, stack, testing strategy, CI and release. The *how* to this document's *what*.
- **`PHASE-0-RESULTS.md`** — to be written: the recorded outcomes of the six spikes in §19.2. Several numbers in §9.5 and §12 are estimates until it exists.

---

## Sources

- [Synology DSM 7 Developer Guide — Synology Package](https://help.synology.com/developer-guide/synology_package/introduction.html)
- [Synology DSM 7 Developer Guide — Breaking Changes in 7.0](https://help.synology.com/developer-guide/breaking_changes.html)
- [Synology DSM 7 Developer Guide — WIZARD_UIFILES](https://help.synology.com/developer-guide/synology_package/wizard/WIZARD_UIFILES_v2.html)
- [Synology DSM Developer Guide (PDF)](https://global.download.synology.com/download/Document/Software/DeveloperGuide/Os/DSM/All/enu/DSM_Developer_Guide_7_enu.pdf)
- [Synology Node.js v22 package](https://www.synology.com/en-global/dsm/packages/Node.js_v22)
- [Synology DSM 7 Developer Guide — Data Share resource](https://help.synology.com/developer-guide/resource_acquisition/data_share.html)
- [SynoCommunity spksrc](https://github.com/SynoCommunity/spksrc)
- [spksrc DSM 7.0 packaging notes](https://github.com/SynoCommunity/spksrc/wiki/DSM-7.0)
- [spksrc spk/postgresql Makefile](https://github.com/SynoCommunity/spksrc/blob/master/spk/postgresql/Makefile)
- [SynoCommunity PostgreSQL package docs](https://docs.synocommunity.com/packages/postgresql/)
- [pgvector](https://github.com/pgvector/pgvector) — see its *Filtering* section on post-filtering, `iterative_scan`, and list partitioning for multi-tenancy
- [Crunchy Data — HNSW indexes with Postgres and pgvector](https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector)
- [ExcelJS — streaming workbook reader](https://github.com/exceljs/exceljs)
- [Ollama — API reference](https://github.com/ollama/ollama/blob/main/docs/api.md)
- [Ollama — Vision capability](https://docs.ollama.com/capabilities/vision)
- [python-docx — `docx.text.pagebreak` (rendered page breaks)](https://python-docx.readthedocs.io/en/latest/_modules/docx/text/pagebreak.html)
- [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
- [onnx-community/Qwen3-Embedding-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX)
