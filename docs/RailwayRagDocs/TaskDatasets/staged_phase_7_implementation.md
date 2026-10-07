# Staged Extraction Phase 7 Implementation

## Outcome

Stage 7 makes the staged Template cache measurable. A Task run now explains
whether it reused old document work, how much new source processing occurred,
how much model work was dispatched, whether Swarm capacity delayed it, and how
long the complete run took.

The proof is available while a run is active and after it reaches a terminal
state. It is exposed by the Task-run APIs, the main Task-run dialog, and the API
tester. This lets an operator compare three equivalent runs over an unchanged
corpus and distinguish a working warm cache from a broken cache key.

## Persistence Boundary

Stage 7 uses the existing `extraction_task_run_items.progress` JSONB column. It
does not add another migration.

Each staged Template item stores one versioned `stagedExecutionProof` object.
The snapshot is rewritten at meaningful phase boundaries and Swarm admission
events. It survives a process retry and is loaded when the same run item
resumes. A failed item keeps the last snapshot because failure settlement does
not replace item progress.

The proof is observability data, not a cache identity and not a correctness
boundary. Dataset generations, compiled-plan digests, manifest revisions,
requirement digests, definition digests, and stable document IDs retain the
Stage 6 responsibilities.

## Recorded Signals

### Requirement coverage

Every exact compiled requirement records:

- requirement digest, key, and display name;
- initially covered sources after durable checkpoint restoration;
- initially uncovered sources;
- final covered and uncovered sources;
- restored source checkpoints;
- newly processed sources; and
- extraction rounds.

`covered` includes committed or explicitly not-applicable sources plus sealed
current-run sources. `uncovered` includes pending, claimed, processing, and
failed sources. Removed sources are not counted as extraction demand.

The initial boundary is recorded before new source extraction. That makes its
reuse rate meaningful:

```text
reuse rate = initial covered / (initial covered + initial uncovered)
```

A first cold run should normally begin near zero reuse. An unchanged second or
third run should begin near complete reuse. A new document should increase only
the uncovered and newly processed counts for the requirements whose source
scope includes it.

### Swarm and model work

Every staged Swarm dispatch contributes:

- workers dispatched, succeeded, failed, and cancelled;
- provider calls, reported as model turns;
- worker tool calls;
- requested and granted slots;
- cumulative slot wait time and wait observations;
- temporary ledger-unavailable observations; and
- current and peak queue position.

The dispatch count is recorded before slot acquisition. The remaining
telemetry is merged in a `finally` boundary so failed worker batches remain
visible. A resumed item hydrates the previous snapshot before adding later
work.

### Gap checks and time

A gap check counts as fired only when assembly leaves at least one binding
outstanding and the bounded gap worker pass is actually needed. The proof stores
both the number of firings and the number of binding IDs requested.

Elapsed time begins at the durable run-item `started_at` timestamp, not at the
latest process attempt. This keeps wall-clock reporting correct across worker
recovery.

## Run-Level Aggregation

`GET /api/v1/task-runs` and `GET /api/v1/task-runs/{runId}` return a
`stagedExecutionProof` summary when at least one item has staged proof data.

Workers, turns, tools, slots, waits, gap checks, and elapsed time aggregate
across staged items. Requirement coverage is keyed by requirement digest. When
several Template steps share an exact-compatible requirement, the run summary
keeps the first initial boundary and the last final boundary. It therefore does
not claim a false cache hit merely because a later report step consumes data
prepared by an earlier no-output step in the same run.

The response includes:

```json
{
  "stagedExecutionProof": {
    "elapsedMs": 184210,
    "phase": "complete",
    "stagedItemCount": 2,
    "completedItemCount": 2,
    "sources": {
      "initialCovered": 18,
      "initialUncovered": 1,
      "finalCovered": 19,
      "finalUncovered": 0,
      "restoredSources": 0,
      "extractedSources": 1,
      "reuseRate": 0.9474
    },
    "swarm": {
      "workersDispatched": 7,
      "modelTurns": 15,
      "slotWaitMs": 2200,
      "slotWaitCount": 1,
      "slotsRequested": 7,
      "slotsGranted": 7,
      "currentQueuePosition": null
    },
    "gapCheckFirings": 0,
    "requirements": []
  }
}
```

## Operator Views

The API tester Task Runs panel shows:

- initial cache coverage and reuse percentage;
- newly processed and still-uncovered sources;
- workers and model turns;
- granted versus requested slots and cumulative wait;
- elapsed wall clock and current phase; and
- gap-check count.

The per-requirement disclosure shows reused, processed, and uncovered sources
plus extraction rounds. The main Task-run dialog uses the same component.

When Swarm admission is waiting, both views show `Waiting for Swarm slots — Nth
in queue` and the time waiting began. The Stage 6 bug that read a nonexistent
`position` event field is fixed; the UI now uses the slot ledger's actual
`queuePosition` field.

## Three-Run Acceptance Procedure

For a real Template Task on `dev`:

1. clear/rebuild its Task Dataset Group and run the Task once;
2. run the identical Task again without changing documents or Template pins;
3. run it a third time, again without changing the source scope;
4. compare `stagedExecutionProof` in the API tester or Task-run API; and
5. retain the three run IDs with the release evidence.

Expected evidence:

- run one has meaningful `initialUncovered`, `extractedSources`, and extraction
  workers;
- runs two and three approach complete initial coverage;
- unchanged warm runs have zero newly processed source documents;
- warm-run model turns exclude source-extraction work but still include
  deterministic assembly workers for file-producing steps;
- repeated gap-check firings identify an incomplete Template manifest;
- high slot wait with a healthy queue position identifies capacity pressure,
  not a cache failure; and
- a queue position that remains unchanged for an abnormal period directs the
  operator to inspect lease expiry and the slot ledger.

## Verification

Automated proof tests cover cold-run accounting, process-resume hydration,
queue-position visibility, and run-level requirement deduplication. The normal
web suite, type check, production build, API documentation verification, and
staging health check remain release gates.

Stage 7 changes no Task Dataset publication or cleanup behavior. The emergency
legacy Template fallback remains available at installation level while the
three-run evidence is collected on representative Templates.
