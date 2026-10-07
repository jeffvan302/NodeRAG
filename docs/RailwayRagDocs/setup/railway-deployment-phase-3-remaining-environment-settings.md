# Phase 3: The Second Settings Migration

Last reviewed: 2026-08-06.

Phase 3 moves operational settings out of Railway variables and into Supabase
(roadmap section 8.2). Thirty-eight were migrated in a first pass; the remaining
fifteen followed in a second. **Fifty are now stored in the database and edited under
Configuration → Environment variables.** Three of the fifteen were returned to
the environment; see [Three That Came Back](#three-that-came-back).

This document exists because the second pass required a decision per setting
rather than a mechanical conversion. Those decisions are recorded here so the
reasoning is available later, and because four of them changed observable
behaviour.

## Why There Were Two Passes

The first thirty-eight shared one shape:

```ts
clampInteger(Number(process.env.X ?? default), min, max, fallback);
```

That could be extracted with its real bounds directly from the worker source,
which is how the schema was built without transcribing thirty-eight definitions
by hand.

The remaining fifteen used shapes that extraction did not match: chained
fallbacks between two variable names, a string enum, a duration string, a
byte-size expression, a default that referenced another setting, and two read
before any job exists to snapshot against. Each needed its own choice of type
and bounds.

## Decisions

### Chained and inherited defaults were flattened

| Setting                      | Was                                                  | Now                        |
| ---------------------------- | ---------------------------------------------------- | -------------------------- |
| `pdfMinExtractedImagePixels` | `PDF_MIN_EXTRACTED_IMAGE_PIXELS ?? PDF_MIN_IMAGE_ANALYSIS_PIXELS ?? 4096` | Independent, default 4096. |
| `docxMinImageAnalysisPixels` | Whatever `pdfMinImageAnalysisPixels` resolved to      | Independent, default 4096. |

**This is a behaviour change, and it is deliberate.** An inherited default is
defensible in an environment file, where the reader can see the expression. It
is indefensible in a settings screen: an operator changing the PDF threshold
would silently move the DOCX one, with nothing in the interface to explain it.

Nothing is lost on an existing installation. `RUNTIME_SETTING_ENV_ALIASES`
preserves the old chaining for the one-time environment adoption, so a
deployment that set `PDF_MIN_IMAGE_ANALYSIS_PIXELS` and relied on it applying to
both still gets both values imported. After that, the two move independently.
Both help definitions say so.

### Timeouts got bounds they never had

`OLLAMA_TIMEOUT_MS`, `OPENAI_VISION_TIMEOUT_MS`, `OPENAI_EMBEDDING_TIMEOUT_MS`
and `SUPABASE_EMBEDDING_TIMEOUT_MS` were read with a bare `Number(...)` and no
clamp, so a typo could set a timeout of two milliseconds or twenty-eight days.
All five provider timeouts now share a five-second floor and a thirty-minute
ceiling, except the Ollama embedding timeout, which keeps its higher floor of
thirty seconds because a cold local model is slow on its first call.

### The enum and the duration string are validated by shape

`pdfVisionMode` is `auto | all | none`, which the settings screen renders as a
list rather than a text field.

`ollamaEmbeddingKeepAlive` accepts a duration such as `10m`, `0` to unload
immediately, or `-1` to keep the model loaded. It is validated on save rather
than left as free text: a value Ollama cannot parse would otherwise surface at
the point of an embedding call, long after the edit that caused it.

### The two idle-path settings turned out to be fine

`WORKER_POLL_INTERVAL_MS` and `WORKER_MAX_JOBS_PER_RUN` govern the loop that
decides whether to claim a job at all, so they are read before any job snapshot
exists. That was the reason they were deferred, and the concern was that moving
them to Supabase would make every idle poll perform a database read.

It does, and it does not matter. The poll already queries the database every few
seconds looking for work, and the settings snapshot is served from a
fifteen-second cache, so the added cost is at most one small read per cache
expiry alongside a query that was happening anyway.

They are refreshed by `refreshPollingSettings`, which applies only those two
values. Taking the whole snapshot there would blur the line between settings a
running job is pinned to and settings the loop reads between jobs.

### `API_REMOTE_UPLOAD_MAX_BYTES` moved to the caller

The limit bounds a request before the handler reaches Supabase, so
`downloadRemoteFile` cannot read it for itself. The two upload routes now pass
it in from the settings snapshot.

Its previous environment read was broken and had been for some time:

```ts
options.maxBytes ?? Number(process.env.API_REMOTE_UPLOAD_MAX_BYTES) ?? DEFAULT;
```

`Number(undefined)` is `NaN`, and `??` only replaces `null` or `undefined`, so
the default was never reached through that chain — it was restored further down
by `positiveInteger`. The variable did work when set; the fallback expression
was simply doing nothing.

### `OLLAMA_VISION_MODEL` is the one variable still read

It has two unrelated uses. The worker consulted it as a last-resort vision model
beneath the Vision model task and the active model configuration; that is now the
`ollamaVisionModelFallback` setting, seeded from the variable during adoption.

Web still reads the raw variable, but only to pre-fill the provider form during
first-run setup. That is a bootstrap seed rather than runtime behaviour, so the
variable stays classified `live` with a description saying exactly that.

The fallback could reasonably be deleted rather than kept — the Vision model task
supersedes it for any configured installation. It was retained because removing
it would change behaviour for a deployment that has no vision model configured
anywhere else, and that is not a change to make silently.

## Three That Came Back

`WORKER_QUEUE_ENABLED`, `WORKER_EMBEDDING_SERVER_PORT` and
`OLLAMA_EMBEDDING_KEEP_ALIVE` were migrated in the second pass and then returned
to the environment. Migrating them was a category error, and the first one was a
live defect.

A settings snapshot is applied by `applySettingsSnapshot`, which runs only inside
`claimNextJob`. The dedicated embeddings service never claims a job, so it never
applies a snapshot: every migrated setting sits at its release default there,
permanently, whatever the database says.

- **`WORKER_QUEUE_ENABLED`** is read in `main()` before any snapshot could exist,
  and it is what distinguishes the ingestion worker from the embeddings service,
  which run the same image. Two deployments need different values from one
  database, which a per-tenant row cannot express. While it was a database
  setting, `WORKER_QUEUE_ENABLED=false` on the embeddings service was ignored and
  that container would have started claiming ingestion jobs.
- **`WORKER_EMBEDDING_SERVER_PORT`** is bound at startup and has to match the
  `PORT` the service is health-checked on.
- **`OLLAMA_EMBEDDING_KEEP_ALIVE`** is used on the embedding call path, which is
  exactly the path that runs on the service with no snapshot.

All three are service topology, which roadmap section 8.1 already exempts from
the migration, and which the Phase 3 gate names as staying in the environment.
The test to apply to any future candidate: if two deployments of the same image
need different values, or if it is read before a job is claimed, it belongs in
the environment.

## Environment Adoption

Removing the environment reads would otherwise revert any value an operator had
tuned in Railway. `adoptEnvironmentSettingsOnce` imports them, at most once per
installation, guarded by `environment_adopted_at`.

It runs in two places, because a fresh installation and an upgraded one reach
the settings by different routes:

- **First-admin creation**, for a new installation. A failure there is logged and
  ignored rather than blocking setup; losing access to a fresh installation would
  be far worse than falling back to defaults.
- **The first load of `/api/platform-settings`**, for an installation that
  upgraded into this release and will never run first-admin setup again. Without
  it, that operator would be shown release defaults for a deployment that had
  tuned them, and saving that view would erase the tuning.

A value outside the release bounds is skipped rather than clamped, so the
operator sees the default and re-enters it deliberately.

## What Governs Each Setting Now

`packages/rag-core/src/index.ts` holds four tables that must agree, and a test
proves they do:

| Table                         | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `PlatformRuntimeSettingsSchema` | Validates a save. The authority on what is legal. |
| `RUNTIME_SETTING_FIELDS`      | Type, bounds and options, for rendering an editor.  |
| `RUNTIME_SETTING_ENV_NAMES`   | The Railway variable each was read from.            |
| `RUNTIME_SETTING_GROUPS`      | Where each appears on the settings screen.          |

The field table is written separately from the schema rather than read out of
Zod's internals, which are not part of its public surface. A test probes each
boundary — minimum accepted, minimum minus one rejected, and the same at the top
— so the interface cannot offer a range that a save would reject. Another test
requires every setting to appear in exactly one group and to have a reviewed
help definition.
