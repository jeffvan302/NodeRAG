# M09 — Complete UI and First-Run Setup Checklist

Status: testbed-complete

Environment: WSL/Docker testbed, PostgreSQL 17/pgvector containers, Chromium, and non-root Linux package simulation

Recorded: 2026-09-04

## Setup and recovery

- [x] Readiness routes unconfigured, operational, maintenance, and incompatible states safely.
- [x] Setup keys are 256-bit random values with a strict format and protected `0600` file.
- [x] PostgreSQL stores only the setup-key SHA-256 verifier.
- [x] Setup keys have a bounded default 24-hour lifetime, rotate after expiry, and are consumed on success.
- [x] First administrator, default silo, password hashing, and one-time recovery-code handoff are transactional.
- [x] Only a recovery-code verifier is retained.
- [x] Durable setup step/progress and sanitized SSE events survive refresh.
- [x] Setup/token values are absent from application logs and secret-scan findings.

## Storage, model, calibration, vision, and sources

- [x] Storage preflight requires an absolute path and proves create/write/fsync/remove access.
- [x] Storage preflight reports free/total bytes and warns below 10 GiB free.
- [x] Safe Docker-testbed defaults are presented without representing them as DSM policy.
- [x] The included model manifest is checksum-pinned and the air-gapped browser preflight verifies SHA-256 without upload.
- [x] M10 owns resumable download and production server-side model import, as required by the staged plan.
- [x] Embedding calibration uses 20 representative chunks and reports characters/second and projected time.
- [x] Ollama activation reports reachability, exact model/revision, validated sample Markdown, elapsed time, and token persistence status.
- [x] Source mappings are accepted only through the API's declared-root and package-user path validation.
- [x] Input folders are clearly identified as read-only ingestion sources, not managed storage.

## Search, preview, and documents

- [x] Meaning, Keyword, and Both map to vector, keyword, and hybrid retrieval.
- [x] Visible silo chips remain a requested subset of server-authoritative scope.
- [x] UI filters cover source, path, format, created/modified, page, image, and table criteria.
- [x] Results group by document and show breadcrumbs, metadata, score, and server-qualified page/sheet/percentage labels.
- [x] Preview consumes server-prepared neighboring context and never performs locator slicing.
- [x] Citation copy includes document, qualified locator, passage, and stable IDs.
- [x] Original download uses the integrity-checked authenticated REST endpoint.
- [x] Document browser shows ingest/source state, page basis, pages, images, and locator warnings.
- [x] Source-missing review, re-index, and typed-confirmation purge are implemented.
- [x] Grapheme-aware display truncation and `dir="auto"` do not alter locator arithmetic.

## Ingest, jobs, administration, and security

- [x] File upload and source mapping use public REST endpoints.
- [x] Source scheduling and live durable queue are visible.
- [x] Job attempts/progress/failures and pause/resume/cancel/retry controls are present.
- [x] Independent read/upload/delete capability grant and revoke controls are present.
- [x] Knowledge spaces, system settings, storage, and vision have explained create/edit/test forms;
      other administration sections describe their purpose and expose their supported controls.
- [x] Vision administration includes the encrypted-key replacement path and editable 1–16
      parallel-call limit.
- [x] Color schemes expose Light, Dark, Forest green, Midnight blue, and Deep red choices and
      persist the selection per signed-in principal in the current browser.
- [x] The NodeRag `N` identity is present in navigation and as the browser/site icon.
- [x] Storage paths are editable only while unused; referenced recovery/relocation locations are
      protected from path or purpose changes.
- [x] Document purge requires `document <ID>` and silo purge requires the exact slug.
- [x] UI code contains no direct database/filesystem or privileged browser-only operation; managed
      paths are returned only through the server-administrator storage contract.
- [x] Runtime route inventory and generated OpenAPI include every UI-used endpoint.

## Accessibility, tests, and package

- [x] Keyboard-first landmarks, focus, labels, dialog semantics, five color schemes, responsive layout, and reduced motion are implemented.
- [x] The separate M09 accessibility checklist is complete.
- [x] Six Playwright journeys cover setup, refresh recovery, auth, all search modes, preview, upload, source-missing review, capabilities, jobs, and purge.
- [x] Axe reports zero WCAG A/AA findings on login and authenticated search.
- [x] Dark-mode evaluation cards have explicit readable foreground/background colors and the
      administration journey has zero automated WCAG A/AA findings.
- [x] Seven forward-only migration checksums verify with head `000007_operator_ui`.
- [x] TypeScript, lint, formatting, dependency boundaries, OpenAPI drift, licenses, and secret scanning pass.
- [x] All 22 unit files and 61 unit tests pass.
- [x] All 8 PostgreSQL integration files and 44 integration tests pass.
- [x] Production UI/server/worker/embedder builds and built-server smoke pass.
- [x] Two M09 thin-SPK builds are byte-identical and the hash is frozen in proof.
- [x] Thin-SPK archive/static checks and non-root lifecycle simulation pass.
- [x] Repository hygiene passes.

## GitHub and closure

- [x] The M09 implementation commit is pushed to `main` and all five M09 workflow jobs pass.
- [x] `m09-proof.json` freezes commit, workflow, contract, browser, database, and package evidence.
- [x] Proof-closure commit `ee56c3a8d357ab177b98410e0f3a99c569e89450` passes M09 run `33887389197` and all five jobs.
- [x] The final certification commit passes every required M09 GitHub job before tagging.
- [x] Annotated tag `m09-complete` resolves remotely to the final certification commit.

## Honest limitations and DSM deferral

- [x] Production resumable model download/import, strict `/volumeN` storage policy, and package-supervised first-run lifecycle remain M10 work.
- [x] Package Center browser launch, DSM ACL/source selection, real Synology storage/capacity warnings, UI latency, and browser/reverse-proxy integration remain deferred.
- [x] No Docker, Chromium, static archive, or package-simulator result is represented as live DSM evidence.

M10 is authorized only after the final certification workflow and remote annotated tag complete.
