# NodeRag — Implementation Strategy

**How to build what `ARCHITECTURE.md` describes, in what order, and how to know each step worked.**

| | |
|---|---|
| Status | Draft v0.2 — WSL/Docker-first execution amendment |
| Date | 2026-09-04 |
| Companion | `ARCHITECTURE.md` — the *what*. This is the *how* |
| Scope | v1.0 = the full system: silos, identity, five formats, vision, search, API, UI |
| Distribution | Manual `.spk` install. Private / internal |

---

## 1. The one thing that shapes everything else

**You should not iterate on a NAS.**

The deploy cycle is build the SPK → upload through Package Center → install → watch a log. Minutes per iteration, no debugger, no hot reload, and a mistake in `start-stop-status` means uninstalling by hand. A project that treats the NAS as its development environment will move at a tenth of the speed it should.

So the governing rule of this whole plan:

> **Milestones 0–14 execute in the repository-owned WSL/Docker testbed. The NAS is the final certification target, not a development environment or a recurring milestone dependency.**

Everything below follows from that. DSM-specific behaviour lives behind one thin adapter rather than being sprinkled through the codebase; `docker-testbed/` owns a Compose stack that mirrors every platform-independent behavior; and the SPK is built, unpacked, inspected, and exercised under a non-root package-user simulator throughout implementation.

The corollary is a discipline: **anything that can only be tested on the NAS is a deferred release risk, so keep that list explicit and never claim Docker proved it.** The principal live-only risks are `onnxruntime-node` loading against DSM's C++ runtime, cross-built PostgreSQL starting as the DSM-created package user, DSM package/resource/ACL/lifecycle behavior, and real embedding/resource performance. They are collected in the staged plan's final DSM certification note and block `v1.0.0`, but they do not block M0–M14 implementation.

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

## 3. Milestone 0 — WSL/Docker testbed, before anything else

Milestone 0 establishes the repository-owned environment used by every later milestone. Its authoritative code and detailed plan live under `docker-testbed/`.

The M0 gate requires:

1. recorded Windows, WSL, Docker Engine, Compose, CPU, RAM, and disk inventory;
2. healthy PostgreSQL 17 plus pgvector on an isolated Compose network;
3. loopback-only database exposure and a generated Git-ignored secret;
4. an immutable accepted database image digest;
5. a real `halfvec` insert and similarity query;
6. safe bootstrap, start, verify, stop, and confirmation-guarded reset scripts;
7. fixture, secret, artifact, model, backup, and runtime-state hygiene;
8. a clean-checkout CI path and `m00` checklist/proof.

See `docker-testbed/README.md`, `docker-testbed/TEST-PLAN.md`, and `docs/Implementation/staged implementation.md` for the execution contract.

### 3.1 Deferred DSM certification risks

The following probes are not performed during M0–M14. Each is simulated or statically validated where possible, kept in the deferred DSM register, and executed against the exact immutable M14 candidate during final certification.

| Spike | Question | Pass looks like | If it fails |
|---|---|---|---|
| **S1** | Does `onnxruntime-node` load and infer on the NAS? | `require()` succeeds, one forward pass returns a 1024-vector | (a) ship a compatible `libstdc++.so.6` where licensing/support permits; (b) build ORT from source in spksrc; (c) reopen the local-only embedding decision |
| **S2** | Does cross-built PG 17 + pgvector start as the package user? | `initdb`, start on a unix socket, `CREATE EXTENSION vector`, insert and query a `halfvec(1024)` | Fall back to the SynoCommunity PostgreSQL package as a dependency — a different install story, not a dead end |
| **S3** | How fast is embedding, really? | Seconds/chunk recorded for q8 / q4 / fp16 × 512 / 1024 tokens × 1…N threads | Not a failure mode; it sets every estimate and may change the default quantisation |
| **S4** | Can PGDATA live where the user wants it? | The §5.4 probe against a real ACL-enabled share: `chmod 0700` sticks, or it doesn't | Tablespace-only relocation; PGDATA stays in `@appdata` |
| **S5** | Do the five formats survive one real page each? | A scanned PDF, a two-column PDF, a Word-saved DOCX, a Google-Docs-saved DOCX, a messy workbook — through a throwaway extractor | Turns §10.5 and §10.8 from reasoning into fact; may reorder the extractor work |
| **S6** | What does one vision call cost from the NAS? | A real table image round-tripped to Ollama, timed | Sets the vision cost model and the default parallelism |

Run S1–S6 only after M14 passes. Record them in `docs/Implementation/proofs/dsm-final-proof.json`; S3 and S6 replace the provisional Docker values used by ETA, capacity, and UI estimates. Any failure reopens the owning milestone and requires a new immutable candidate before retesting.

---

## 4. Repository layout

```
NodeRag/
├── docs/planning/          ARCHITECTURE.md, IMPLEMENTATION.md
├── docs/Implementation/    staged plan, checklists, milestone and DSM proofs
├── packages/
│   ├── shared/             types, the locator core, chunking rules, Zod schemas
│   ├── server/             Fastify app, ingest worker, embedder, vision client, store
│   └── ui/                 Preact SPA (Vite)
├── spk/                    spksrc package definition
│   ├── vendor/spksrc/      vendored upstream, pinned commit
│   └── noderag/            Makefile, conf/, scripts/, WIZARD_UIFILES/
├── fixtures/               the format corpus + the astral-plane text corpus
├── eval/                   golden set + harness (§16 of ARCHITECTURE.md)
└── docker-testbed/         Compose, scripts, fixture policy, artifacts, testbed plan
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

### 6.1 The two fixture corpora, governed from Milestone 0 and populated by their owning milestones

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
| **Package simulation** | Archive, metadata, lifecycle scripts, package-user restrictions, setup, ingest, search, uninstall | WSL/Docker |
| **DSM final** | Install, setup, ingest, search, reboot, upgrade, backup, restore, uninstall, soak | The real device, after M14 only |

The final DSM test is a written, release-blocking checklist run once the immutable M14 candidate exists. M0–M14 record DSM-only cases in a deferred register and must not represent package simulation as live-device evidence.

### 6.3 A deterministic fake for the vision model

The Ollama client is an interface with two implementations: the real one, and a fake that returns canned Markdown keyed by image hash. Every ingest test uses the fake. The real one is exercised by one integration test, marked, run manually. Otherwise the test suite becomes dependent on a GPU box being awake — and non-deterministic, since a VLM does not return identical output twice.

---

## 7. Build order

Re-ordered from `ARCHITECTURE.md` §18 to reach a **working vertical slice early**, because "full system" was chosen and the risk of that choice is a long stretch with nothing runnable. Each milestone ends in something demonstrable.

| M | Milestone | Exit criterion — a thing you can actually check |
|---|---|---|
| **0** | WSL/Docker testbed | Clean checkout starts healthy PG 17 + pgvector and passes the halfvec probe |
| **1** | Contracts + testbed feasibility | Linux Node/ONNX, PG/pgvector, Argon2, extraction and Ollama probes pass; DSM register complete |
| **2** | Repository + thin SPK | Workspace, migrations, UI/server skeleton, CI and simulated thin-package lifecycle pass |
| **3** | Schema + identity | Partitions, RLS, identity, independent capabilities, readiness, audit and zero-grant suites pass |
| **4** | Markdown vertical slice | Upload → durable job → chunk → embed → scoped search returns exact dual-unit locators |
| **5** | Durable ingestion + purge | Crash recovery, watched-source retention, locator verifier and complete purge pass |
| **6** | Five formats | TXT, Markdown, PDF, DOCX and XLSX fixture corpus passes in production-bundle simulation |
| **7** | Vision | Schema-constrained Ollama client, deterministic fake, image cache and bad-PDF recovery pass |
| **8** | Retrieval + API | Three search modes, REST, gateways, MCP and evaluation harness pass scope/contract matrices |
| **9** | Complete UI | Setup, search, documents, ingest, administration, E2E and accessibility pass |
| **10** | Production SPK simulation | Bundled artifacts, storage probe, supervision and lifecycle pass under package-user simulation |
| **11** | Rebuilds | Chunk/model rebuild and rollback work under active search without mixed model spaces |
| **12** | Evaluation | Quality gates pass; Docker latency/resource values are frozen as provisional |
| **13** | Recovery + hardening | Backup, blank restore, upgrade/rollback, fault, security, SBOM and license gates pass |
| **14** | Immutable candidate | Clean-room build, full regression and 24-hour Docker soak produce the tagged candidate |

**M4 is the one to protect.** It is deliberately thin — one format, no UI, no vision — and it exercises every architectural seam at once: the partition boundary, the `SiloScope` choke point, the offset producer, the embedder process, and the job queue. If something in this design is wrong, M4 is where it shows, and it is far cheaper to find out there than at M9.

**M10 is deliberately late.** Thin-package archive and lifecycle simulation begins in M2, while the full production package waits until the application behavior is stable. The final live DSM test occurs only after M14 and uses the exact tagged candidate.

---

## 8. Development environment

The authoritative environment is `docker-testbed/compose.yaml`; do not create a second root Compose file. Bootstrap and validate it from WSL with `docker-testbed/scripts/up.sh`. It begins with PostgreSQL 17 + pgvector, an isolated network, loopback-only port, health check, persistent volume, generated secret, and real halfvec probe. Later services are added only by their owning milestone.

The same PostgreSQL major, extension, schema, and tuning shape make local query behavior useful, but Docker cannot certify DSM CPU, C++ runtime, ACL, filesystem, package manager, or resource behavior. Those values remain provisional until final certification.

`pnpm dev` runs the API with `tsx watch`, the UI with Vite, and the ingest worker as a separate process, all against `docker compose`. Local folders stand in for shared folders; `adapters/local` supplies the paths that `adapters/dsm` would.

**One CI job builds inside the documented Linux x86_64 compatibility container** and does nothing but `require('onnxruntime-node')` and run one inference. It continuously verifies the Linux baseline and catches dependency ABI changes. It must not be named or interpreted as proof of the DSM runtime.

---

## 9. CI

On every push: Compose validation → typecheck → lint → `dependency-cruiser` → unit + property → integration (Testcontainers) → security suite → contract → Linux compatibility → package simulation. Nightly: eval harness, licence audit, and applicable soak/fault slices.

The licence audit matters because the project is private and redistributes bundled binaries: `license-checker` with an allowlist, failing on any GPL/AGPL runtime dependency, plus a `THIRD-PARTY.md` regenerated on each release. Cheap now, genuinely painful to reconstruct later.

---

## 10. Versioning and release

`MAJOR.MINOR.PATCH`, with the PostgreSQL major pinned per NodeRag major (§8.4). The SPK's `INFO` version is derived from `package.json`, so there is one source of truth.

A candidate is: clean CI build → `v1.0.0-rc.N` tag → checksummed SPK and proof bundle → clean testbed verification. A release is: final DSM certification of that exact candidate → `dsm-final-proof.json` → `v1.0.0` tag on the certified commit → private GitHub release. Since distribution is manual, release notes carry upgrade instructions, and every schema-changing release is rehearsed against a recovery copy before it ships.

---

## 11. What this plan is betting on

Worth stating so it can be checked later rather than discovered:

1. **ONNX Runtime works on DSM** (S1). This bet is intentionally deferred to final certification; failure blocks v1.0.0 and reopens a locked decision.
2. **Cross-building PostgreSQL is a solved problem** because spksrc already does it (S2). The build is continuously verified in WSL/CI, but startup on DSM remains a final release gate.
3. **Extraction quality is achievable in TypeScript.** The Python ecosystem is stronger here. If PDF reading-order reconstruction proves genuinely inadequate with `pdfjs-dist` and MuPDF, the fallback is routing more pages to the vision model (§10.5) — which works, and costs money and time.
4. **8 GB is enough** for PostgreSQL, one ONNX session and the page cache (§6.8). Docker establishes provisional behavior; only final DSM certification proves the hardware claim.
5. **A rebuild is a background operation, not an outage.** §7.5's staging-partition swap is the mechanism the whole "change the model later" promise rests on. M11 exists to prove it on real data before it is needed in anger.
6. **The full-system scope survives contact with M4.** If the vertical slice takes materially longer than planned, the deferral discussed and rejected in §19.1 — silos now, identity later — is still available, and M3 is the last moment it is cheap.
