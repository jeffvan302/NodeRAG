# NodeRag — Implementation Strategy

**How to build what `ARCHITECTURE.md` describes, in what order, and how to know each step worked.**

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-09-04 |
| Companion | `ARCHITECTURE.md` — the *what*. This is the *how* |
| Scope | v1.0 = the full system: silos, identity, five formats, vision, search, API, UI |
| Distribution | Manual `.spk` install. Private / internal |

---

## 1. The one thing that shapes everything else

**You cannot iterate on a NAS.**

The deploy cycle is build the SPK → upload through Package Center → install → watch a log. Minutes per iteration, no debugger, no hot reload, and a mistake in `start-stop-status` means uninstalling by hand. A project that treats the NAS as its development environment will move at a tenth of the speed it should.

So the governing rule of this whole plan:

> **Roughly 95 % of development happens on an ordinary Linux workstation against an ordinary PostgreSQL. The NAS is an integration checkpoint, not a development environment.**

Everything below follows from that. It means DSM-specific behaviour lives behind one thin adapter rather than being sprinkled through the codebase; it means a `docker compose` dev stack that mirrors the runtime closely enough to trust; and it means the SPK build is a CI artefact you install a few times a week, not a thing you wait for.

The corollary is a discipline: **anything that can only be tested on the NAS is a risk, so keep that list short and known.** Today it is exactly four things — `onnxruntime-node` loading against DSM's C++ runtime, the cross-built PostgreSQL starting as the package user, the DSM package lifecycle itself, and real embedding throughput. Those four are §3's spikes precisely because they are the ones the workstation cannot answer.

---

## 2. Stack

Chosen for boring reasons; each line is a decision, not a default.

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 22** (Synology `Node.js_v22`) | Fixed by the platform (`ARCHITECTURE.md` §1.3) |
| Language | **TypeScript**, `strict`, `noUncheckedIndexedAccess` | The `SiloScope` invariant (§5.2 below) is enforced by the type system or not at all |
| HTTP | **Fastify** + `@fastify/*` | Schema-first routing gives request validation and the OpenAPI document from the same declaration — §14's "cannot drift" property |
| Validation | **Zod**, with `zod-to-json-schema` for Fastify | One schema for TS types, runtime validation and OpenAPI |
| DB driver | **`pg`** (node-postgres), no ORM | The schema is partition- and index-shaped in ways ORMs fight. Queries are written and reviewed as SQL |
| Migrations | **`node-pg-migrate`**, forward-only | Plain SQL up/down, no magic, runs in-process at package start |
| Embedding | **`onnxruntime-node`** + `@huggingface/transformers` tokenizer only | §9.2 — the pipeline abstraction is avoided, the tokenizer is not |
| PDF | **`pdfjs-dist`** (legacy build) | Per-page text with coordinates plus operator lists for images (§10.5). MuPDF is the fallback if reading-order reconstruction proves inadequate |
| DOCX | Direct OOXML walk over **`unzipper`** + **`fast-xml-parser`** | §10.3 — converters lose `w:lastRenderedPageBreak`, which is the whole page-number story |
| XLSX | **`exceljs`** streaming reader | §10.8 — a 200 MB workbook must never be fully resident |
| Front end | **Preact** + **Vite**, no SSR | §15. Built at package time, served as static files |
| Tests | **Vitest** + **Testcontainers** (Postgres) | One runner for unit and integration |
| Bundling | **esbuild** to a small set of CJS bundles | No `npm install` on the NAS, ever |
| Package build | **spksrc**, vendored | §3.2 — `cross/postgresql` and `cross/pgvector` are the reason |
| Monorepo | **pnpm workspaces**, three packages | Below |

**No ORM, no GraphQL, no message queue, no Redis, no Docker at runtime.** Every one of those would be a second thing to install, supervise and back up on a box whose whole appeal is that it is one package.

---

## 3. Milestone 0 — the spikes, before anything else

Non-negotiable, and unaffected by the decision to build the full system. Two of these can end the project, and both are cheap to run. Building for three months and *then* discovering that ONNX Runtime will not load on DSM is the single worst outcome available.

| Spike | Question | Pass looks like | If it fails |
|---|---|---|---|
| **S1** | Does `onnxruntime-node` load and infer on the NAS? | `require()` succeeds, one forward pass returns a 1024-vector | (a) ship `libstdc++.so.6` in `target/lib` + `LD_LIBRARY_PATH`; (b) build ORT from source in the spksrc toolchain; (c) **re-open the local-only embedding decision** |
| **S2** | Does cross-built PG 17 + pgvector start as the package user? | `initdb`, start on a unix socket, `CREATE EXTENSION vector`, insert and query a `halfvec(1024)` | Fall back to the SynoCommunity PostgreSQL package as a dependency — a different install story, not a dead end |
| **S3** | How fast is embedding, really? | Seconds/chunk recorded for q8 / q4 / fp16 × 512 / 1024 tokens × 1…N threads | Not a failure mode; it sets every estimate and may change the default quantisation |
| **S4** | Can PGDATA live where the user wants it? | The §5.4 probe against a real ACL-enabled share: `chmod 0700` sticks, or it doesn't | Tablespace-only relocation; PGDATA stays in `@appdata` |
| **S5** | Do the five formats survive one real page each? | A scanned PDF, a two-column PDF, a Word-saved DOCX, a Google-Docs-saved DOCX, a messy workbook — through a throwaway extractor | Turns §10.5 and §10.8 from reasoning into fact; may reorder the extractor work |
| **S6** | What does one vision call cost from the NAS? | A real table image round-tripped to Ollama, timed | Sets the vision cost model and the default parallelism |

**Do S1 and S2 first, on the real hardware, before writing a line of product code.** They are perhaps two days together. Everything after this document assumes they passed.

Record every result in `docs/planning/PHASE-0-RESULTS.md`. The numbers from S3 and S6 become the constants the ETA calculations and the UI benchmarks are built on.

---

## 4. Repository layout

```
NodeRag/
├── docs/planning/          ARCHITECTURE.md, IMPLEMENTATION.md, PHASE-0-RESULTS.md
├── packages/
│   ├── shared/             types, the locator core, chunking rules, Zod schemas
│   ├── server/             Fastify app, ingest worker, embedder, vision client, store
│   └── ui/                 Preact SPA (Vite)
├── spk/                    spksrc package definition
│   ├── vendor/spksrc/      vendored upstream, pinned commit
│   └── noderag/            Makefile, conf/, scripts/, WIZARD_UIFILES/
├── fixtures/               the format corpus + the astral-plane text corpus
├── eval/                   golden set + harness (§16 of ARCHITECTURE.md)
└── docker-compose.dev.yml  PostgreSQL 17 + pgvector, matching the runtime
```

**Why `shared` exists.** The browser needs the same locator arithmetic as the chunker — a highlight is `text.slice(char_start - page.char_start, …)` — and the same types the API returns. Duplicating either is how a UTF-16 offset bug gets reintroduced on one side only. `shared` has **no dependencies** beyond TypeScript, so it is trivially importable from both a Node bundle and a browser bundle.

**Why spksrc is vendored, not a submodule.** It is a build toolchain whose upstream moves independently; a pinned vendored copy means a checkout from a year from now still builds. Since the project is private, the fork is not published back.

### 4.1 `packages/server` internals

```
server/src/
├── adapters/dsm/        the ONLY module that knows about DSM.
│                        paths, package user, volume selection, synopkg,
│                        the .sc port file. A `local` sibling backs dev mode.
├── store/               pg pool, migrations, query modules (one per aggregate)
├── identity/            principals, sessions, API keys, grants, SiloScope
├── ingest/
│   ├── crawl/           folder walking, change detection
│   ├── decode/          encoding detection, BOM, NFC   (§10.4)
│   ├── extract/         pdf/ docx/ xlsx/ text/ → page markdown
│   ├── chunk/           thin wrapper over shared/chunking
│   ├── build/           staging partitions, populate, swap  (§7.5)
│   └── worker.ts        the job loop, round-robin across documents
├── files/               the document store: originals + markdown by id (§7.1),
│                        write-then-commit, delete-then-unlink, orphan sweeper
├── embed/               ONNX session, tokenizer, the embedder process
├── vision/              Ollama client, JSON-schema output, semaphore, cache
├── search/              query planning, RRF fusion, overlap collapse
├── api/                 Fastify routes, one file per resource
└── main.ts              supervisor: starts postgres, embedder, worker, api
```

The dependency rule is one-directional and checked in CI with `dependency-cruiser`:

```
api → search → store          api → identity → store
ingest → {extract, chunk, embed, vision} → store
adapters/dsm ← everything that needs a path, nothing else
shared ← everyone, and shared imports nothing
```

`store` never imports from `api`. `extract` never imports from `search`. If those hold, the ingest worker can be run headless in a test without standing up an HTTP server, which is what makes the extraction work fast to iterate on.

---

## 5. Invariants the code must enforce, not remember

Three properties in `ARCHITECTURE.md` are load-bearing and would otherwise decay into "be careful." Each gets a mechanism.

### 5.1 The offset producer is singular

Only `shared/locator` computes `char_start`, `char_end`, `byte_start`, `byte_end`. Nothing else constructs them.

```ts
// shared/locator/types.ts
declare const brand: unique symbol;
export type Utf16Offset = number & { readonly [brand]: 'utf16' };
export type Utf8Offset  = number & { readonly [brand]: 'utf8'  };
```

Branded types mean a raw `number` cannot be passed where an offset is expected, and a UTF-8 offset cannot be passed where a UTF-16 one is. The only functions that mint them live in that module. This costs nothing at runtime and makes the §11.7 mixing bug a compile error.

Paired with two CI checks: no `substring(`/`substr(` over a markdown column anywhere in `store/`, and the fixture corpus in §6.1.

### 5.2 `SiloScope` is a required argument, not a filter

```ts
// identity/scope.ts
export class SiloScope {
  private constructor(readonly siloIds: readonly number[],
                      readonly permission: Permission) {}
  static async resolve(principalId: number, gateway: Gateway | null,
                       requested?: number[]): Promise<SiloScope> { … }
}

// store/chunks.ts — no overload without a scope exists
export function searchChunks(scope: SiloScope, q: Query): Promise<Hit[]>
```

Every store function that touches silo-partitioned data takes `SiloScope` as its **first parameter**. There is no variant that omits it, so a handler that forgets one does not compile. `SiloScope` has a private constructor, so it can only come from `resolve()` — a handler cannot fabricate one.

The test that proves it: a suite that calls **every** route with a principal holding zero grants and asserts an empty result or a 404, never a 403 and never a row. It runs on every commit and it fails loudly when someone adds a route.

### 5.3 Extraction is a pure function of bytes

`extract(bytes, format, options) → Page[]` — no database, no clock, no network except the vision client, which is injected. That makes the whole extraction layer testable against `fixtures/` with no infrastructure, which matters because extraction is where the most iteration will happen and it is the slowest thing to test if it needs a NAS or a database.

---

## 6. Testing

### 6.1 The two fixture corpora, built in Milestone 0

**`fixtures/formats/`** — one small real file per case, each with a hand-checked expected Markdown:

```
pdf/two-column.pdf          reading order (§10.5)
pdf/no-tounicode.pdf        must fail the extraction gate, not emit gibberish
pdf/scanned.pdf             zero text layer → vision path
pdf/ligatures.pdf           ﬁ ﬂ folding
pdf/hyphenated.pdf          develop-\nment
docx/word-saved.docx        page_basis = 'rendered'
docx/gdocs-export.docx      page_basis = 'none' — and must say so
docx/tables.docx            exact table structure
xlsx/multi-table-sheet.xlsx region detection (§10.8)
xlsx/dates-currency.xlsx    number formats — 2024-01-01, not 45292
xlsx/wide-90-col.xlsx       record-oriented fallback
xlsx/5000-rows.xlsx         header-repeating table split
txt/utf16-no-bom.txt        the §10.4 null-byte heuristic
txt/shift-jis.txt           legacy detection
md/nfd-accents.md           NFC normalisation
md/astral.md                emoji, CJK ext-B, ZWJ family, combining marks, RTL
```

**`fixtures/golden/`** — the §16 evaluation set. Empty until there is a real corpus; the harness ships before the data.

The astral fixture is the one that pays for itself: every chunker and locator test runs against it, so the UTF-16 boundary case is exercised on every commit rather than in production.

### 6.2 Layers

| Layer | What | Infrastructure |
|---|---|---|
| **Unit** | Chunker, locator, snapping, encoding detection, NFC, extractors | None. Milliseconds |
| **Property** | For random text: `slice(char_start, char_end) === text` by **both** units, chunks reassemble the page, overlap is exactly `overlap_chars` | None |
| **Integration** | Migrations, partition creation, RLS, search, the job queue | Testcontainers PostgreSQL 17 + pgvector |
| **Security** | Zero-grant principal against every route; gateway narrowing; expired and revoked keys | Testcontainers |
| **Contract** | Generated OpenAPI matches the routes; every response validates against its schema | None |
| **Eval** | §16 harness against the golden set | A seeded index |
| **Smoke (NAS)** | Install, first-run wizard, ingest one document, search it, uninstall | The real device |

The NAS smoke test is a written checklist, run at each milestone, not automated. Automating DSM package installation is a project of its own and would not pay for itself here.

### 6.3 A deterministic fake for the vision model

The Ollama client is an interface with two implementations: the real one, and a fake that returns canned Markdown keyed by image hash. Every ingest test uses the fake. The real one is exercised by one integration test, marked, run manually. Otherwise the test suite becomes dependent on a GPU box being awake — and non-deterministic, since a VLM does not return identical output twice.

---

## 7. Build order

Re-ordered from `ARCHITECTURE.md` §18 to reach a **working vertical slice early**, because "full system" was chosen and the risk of that choice is a long stretch with nothing runnable. Each milestone ends in something demonstrable.

| M | Milestone | Exit criterion — a thing you can actually check |
|---|---|---|
| **0** | Spikes (§3) | S1–S6 recorded in `PHASE-0-RESULTS.md`. S1 and S2 green |
| **1** | Skeleton + dev stack | `docker compose up` gives PG 17 + pgvector; `pnpm dev` serves a page; migrations run; CI is green on an empty project |
| **2** | Schema + identity | Every table from §7; partitions created and dropped by silo; `settings` singleton; principals, keys, grants (`read`/`upload`), sessions, audit. **The zero-grant test suite passes** |
| **3** | **Vertical slice** | A `.md` file on disk → crawl → chunk → embed → `POST /v1/search` returns it with correct page and character locators. One format, one silo, no UI. **This is the milestone that proves the architecture** |
| **4** | Locator verifier + purge | In-transaction assertion, astral fixtures green, nightly sampler, both offset units verified. **Delete a document and prove nothing survives**: no rows, no files, no unreachable cache entries (§7.6) |
| **5** | Formats | TXT, PDF, DOCX, XLSX against the whole fixture corpus, including encoding detection and `page_basis` |
| **6** | Vision | Ollama client, schema-constrained output, image filters, hash cache, `pending_vision` retry, the §10.5 page-level extraction gate |
| **7** | Search + full API | Three modes, RRF, overlap collapse, the whole REST surface, generated OpenAPI, gateways, MCP |
| **8** | Front end | Search screen, document browser, page preview, ingest console with failures, admin screens |
| **9** | Packaging | The real SPK: bundled PG, lifecycle scripts, setup wizard, volume selection, `.sc` ports. Installs and uninstalls cleanly on the NAS |
| **9b** | Rebuilds | §7.5 end-to-end: change the chunk size, watch staging partitions populate while search keeps serving, swap in. Then a model swap, flipping every silo in one transaction. **Rehearsed on a real corpus before it is ever needed** |
| **10** | Evaluation | Golden set built from the real corpus; harness runs; defaults set from measurements rather than argument |
| **11** | Hardening | RLS benchmark and decision, backup/restore, 1.0→1.1 upgrade rehearsal, log rotation, accessibility, CPU-budget tuning |

**M3 is the one to protect.** It is deliberately thin — one format, no UI, no vision — and it exercises every architectural seam at once: the partition boundary, the `SiloScope` choke point, the offset producer, the embedder process, the job queue. If something in this design is wrong, M3 is where it shows, and it is far cheaper to find out there than at M8.

**M9 is deliberately late.** Packaging is well understood after the spikes and does not need to block product work. The one caveat: run the NAS smoke test at M3, M5 and M7 anyway, so packaging drift is caught in hours rather than at the end.

---

## 8. Development environment

```yaml
# docker-compose.dev.yml
services:
  db:
    image: pgvector/pgvector:pg17
    environment: [ POSTGRES_PASSWORD=dev, POSTGRES_DB=noderag ]
    ports: [ "5433:5432" ]          # 5433 to match the runtime's habits
    command: >
      postgres -c shared_buffers=1GB -c maintenance_work_mem=1GB
               -c max_connections=24
```

Same major version, same extension, same tuning shape as §8.3 — so a query plan seen in development is the plan the NAS will use. The one thing it cannot mirror is the CPU, so §9.5's timings only ever come from the device.

`pnpm dev` runs the API with `tsx watch`, the UI with Vite, and the ingest worker as a separate process, all against `docker compose`. Local folders stand in for shared folders; `adapters/local` supplies the paths that `adapters/dsm` would.

**One CI job builds inside a container matching DSM's glibc and libstdc++** and does nothing but `require('onnxruntime-node')` and run one inference. That converts S1 from a one-off spike into a continuously verified property, and it catches the day a dependency upgrade quietly bumps the C++ runtime requirement.

---

## 9. CI

On every push: typecheck → lint → `dependency-cruiser` → unit + property → integration (Testcontainers) → security suite → contract → the DSM-compat container job. Nightly: eval harness, licence audit.

The licence audit matters because the project is private and redistributes bundled binaries: `license-checker` with an allowlist, failing on any GPL/AGPL runtime dependency, plus a `THIRD-PARTY.md` regenerated on each release. Cheap now, genuinely painful to reconstruct later.

---

## 10. Versioning and release

`MAJOR.MINOR.PATCH`, with the PostgreSQL major pinned per NodeRag major (§8.4). The SPK's `INFO` version is derived from `package.json`, so there is one source of truth.

A release is: tag → CI builds the SPK for each target platform → artefacts attached to the tag → manual install. Since distribution is manual, the release notes carry the upgrade instructions, and **every release that changes the schema is rehearsed against a copy of a real installation before it ships.** With no auto-update and no repo, a bad upgrade is a phone call, not a hotfix.

---

## 11. What this plan is betting on

Worth stating so it can be checked later rather than discovered:

1. **ONNX Runtime works on DSM** (S1). Everything else is recoverable; this is the one that reopens a locked decision.
2. **Cross-building PostgreSQL is a solved problem** because spksrc already does it (S2). If its `cross/postgresql` does not build for the target platform, the bundled-PG decision reverts to a package dependency.
3. **Extraction quality is achievable in TypeScript.** The Python ecosystem is stronger here. If PDF reading-order reconstruction proves genuinely inadequate with `pdfjs-dist` and MuPDF, the fallback is routing more pages to the vision model (§10.5) — which works, and costs money and time.
4. **8 GB is enough** for PostgreSQL, one ONNX session and the page cache (§6.8). S3 tests the CPU half; the memory half is only proven at real corpus size, which is M10.
5. **A rebuild is a background operation, not an outage.** §7.5's staging-partition swap is the mechanism the whole "change the model later" promise rests on. M9b exists to prove it on real data before it is needed in anger.
6. **The full-system scope survives contact with M3.** If the vertical slice takes materially longer than planned, the deferral discussed and rejected in §19.1 — silos now, identity later — is still available, and M2 is the last moment it is cheap.
