# Railway Deployment Phase 7: Disaster Recovery And Release Automation

Last reviewed: 2026-08-09.

Phase 7 is the last one. It turns backup and restore from operations an
administrator can run into guarantees a release cannot ship without.

**Status.** Implemented in the repository for logical dumps, sleeping services,
scheduled backups, retention, and worker wake sweeps. The release helper now
deploys and monitors maintenance plus the scheduler alongside web and worker;
the live staging deployment is the final proof for this commit.

## 7.1 The Logical Dump

The portable archive carries records and stored files, which is what moves an
installation into a new project. It does not carry the schema, the extensions,
the row-level security policies or the functions — the migrations rebuild those,
and only if the migrations still run.

The logical dump is the other half: a `pg_dump` of the database itself, for the
case where the project is gone and rebuilding from migrations is not on the
table. Ask for it by taking a backup in `disaster_recovery` mode; `portable`
remains the default and is unchanged.

### It sits beside the archive, not inside it

A tar entry needs its length written into the header before its body, and a
dump's length is unknowable until it ends. Putting the dump inside the archive
would therefore mean spooling the whole database to disk or memory first, which
is the exact property the streaming export was built to avoid.

So the dump is its own volume-split object in the same backup folder:

```text
bubble-rag/<backup-id>/bubble-rag-20260807T0100Z.bragbackup.0001   the archive
bubble-rag/<backup-id>/bubble-rag-20260807T0100Z.bragdump.0001     the dump
bubble-rag/<backup-id>/manifest.json
bubble-rag/<backup-id>/dump.json
```

`manifest.database.dumpPath` names it, and `dump.json` carries its digest,
volume list and the `pg_restore` line that reads it.

It is taken while the maintenance barrier still holds, so the archive and the
dump describe the same instant. That is the only thing that makes the two halves
one backup rather than two.

### The version trap

`pg_dump` refuses to read a server newer than itself, and the maintenance image
installs whatever `postgresql-client` Debian packages — routinely a major
version behind what Supabase runs. Left unchecked that produces a failure at the
last step of a long export, with the platform quiesced the whole time.

So the versions are compared **before the barrier goes up**, and the refusal
names both numbers and the fix:

> pg_dump is version 15 and the database is version 17. pg_dump refuses to read
> a newer server, so this dump would be incomplete. Rebuild the maintenance
> image with postgresql-client-17.

### Two decisions worth stating

**`--no-owner --no-privileges`.** A restore lands in a different Supabase
project whose roles have different names. Keeping the source's ownership would
fail every statement naming a role the target has never heard of.

**Supabase's own schemas are excluded** — `auth`, `storage`, `realtime`,
`vault`, `extensions` and the rest. Supabase manages them, and a restore that
tried to recreate them would collide with what the target project already has.

**The connection goes through the environment, not the argument list.**
`pg_dump` accepts a connection string as an argument, but arguments are readable
by anything that can see the process table and this one carries the database
password. The libpq variables say the same thing without that.

### Verification

```powershell
pnpm test
```

Eleven dump tests cover the version guard in both directions, a missing
`pg_dump`, the ownership and schema exclusions, the password staying out of
argv, TLS defaulting to required, and the failure path reporting what `pg_dump`
said rather than only its exit code. Nothing shells out: the process runner is
injected.

## 7.2a Letting Services Sleep

Railway sleeps a service after ten minutes with **no outbound traffic**. Inbound
is explicitly excluded, and it wakes on inbound from the internet or the private
network. That rule decides everything here: a worker polling Supabase every five
seconds can never sleep, whatever the Railway setting says.

So the worker has two states. It polls while it has a reason — a job claimed, a
wake ping from web, or work visible in the queue — and when none of those has
happened for `workerIdleAfterMs` it stops polling and waits on a promise with no
timer and no outbound call. Anything periodic, even a heartbeat, would keep it
awake and defeat the point.

The windows add up: five minutes idle here, then Railway's own ten, so the
service sleeps about **fifteen minutes** after the last job and only the first
five cost database queries.

### Maintenance needed no code

The worker needed a state machine because it _polls_: it generates outbound
traffic of its own accord, so nothing but a code change could ever make it
quiet. Maintenance is the opposite. It is purely reactive — it acts only when
web or the cron calls it, holds no background timer, and ends its Postgres
client on every path. Idle, it already makes no outbound calls at all.

So the only thing keeping it awake was `sleepApplication: false`, which this
document's author set in Phase 3 out of a worry that it might be slept
part-way through a promotion. That worry was misplaced: a running promotion or
backup is continuous traffic with Postgres and S3, and Railway decides on
outbound silence. A busy maintenance service cannot be slept, and an idle one
should be.

No ping is needed to _wake_ it: inbound traffic does that, and every call
maintenance receives is inbound by definition.

One is needed to keep it awake, though, and the reasoning that said otherwise
was wrong. Most of what maintenance does is chatty enough to be safe — draining
polls every two seconds, an export queries page after page, an upload pushes
parts to S3. A migration is not. It runs as a **single statement** under a
fifteen minute timeout: the query goes out once and the process then waits,
sending nothing. `create index ... using hnsw` on a large embeddings table is
exactly that shape and is the slowest statement in this repository. Fifteen
minutes of silence against a ten minute threshold means Railway could stop the
container half-way through applying schema.

TCP keep-alive does not rescue it either. node-postgres enables `SO_KEEPALIVE`
but leaves the delay at the system default, which on Linux is two hours.

So while a migration, backup or restore is in flight, maintenance makes a cheap
outbound request once a minute. It does not call another service — waking web to
keep maintenance alive would trade one bill for two — and it does not open a
second database connection, which during a migration is the last thing worth
adding. A `HEAD` against the Supabase REST root is enough: the packets are what
matter, not the answer.

The hold is reference counted and released in a `finally` on every path. A hold
that outlived its operation would keep the service awake forever, which costs
more than never sleeping at all, because nobody would notice.

One consequence had to be handled: a slept service answers its first request
slowly or with a 502. Health reads therefore retry once with a longer timeout,
because otherwise the service panel would report maintenance unreachable and
turn red every time nobody had used the application for a while — the false
alarm the panel exists to avoid.

### The failure this can produce, and what catches it

A ping that never lands leaves a job queued with nobody to claim it. Three
things now stand between that and a document nobody notices:

1. **The ping retries** three times with backoff. The likeliest moment for it to
   fail is while the worker is waking or restarting, which is exactly when a
   single attempt would be refused.
2. **The queue depth is reported** beside the service versions, so a job waiting
   ten minutes on an unreachable worker turns the badge red and says so on every
   page.
3. **The worker reclaims stale jobs on startup** before claiming new work, so a
   worker replacement cannot strand a job in `running` forever. Queue depth is
   still the alert if every web wake retry was refused.

Three prerequisites had to be true and each was checked rather than assumed: the
code stops polling, `workerIdleSleepEnabled` is on, and the service's Railway
config allows sleeping. The third was false — the worker deploys from
`railway.worker-cron.json`, which had `sleepApplication: false`, so it would
have gone silent and stayed awake anyway.

## 7.2b Scheduled Backups And Retention

The installation has one schedule in `backup_schedules`. The row stores the
business schedule (daily or weekly UTC time), the next concrete `next_run_at`,
the retention policy, the most recent backup id, and the last scheduler result.
When an administrator saves it, web asks maintenance to write the exact cron to
Railway with the retained, scoped Railway connection. Disabling the schedule
removes the cron entirely. A late or skipped execution remains recoverable
because `next_run_at` stays due until the next actual scheduler start.

The scheduler takes a Postgres advisory lock before doing anything. While it
owns the lock, it queues due backups, starts any queued scheduler-created
backup, applies retention to succeeded backups, and wakes the private worker if
ingestion jobs are queued. The existing `backup_jobs_single_active_idx` partial
unique index still prevents two backups for the same tenant from running at the
same time.

Retention deletes both sides of a backup: every S3 object under the backup id
prefix, including `.bragbackup`, `.bragdump`, `manifest.json`, `volumes.json`,
and `dump.json`, and then the succeeded `backup_jobs` row. It never deletes a
running, failed, or cancelled backup, and it always keeps the configured minimum
number of succeeded archives.

## Release Gate

The repository gate for this phase is:

```powershell
pnpm docs:check
pnpm typecheck
pnpm test
pnpm build
```

`scripts/update-and-deploy.ps1` runs those local gates, pushes the expected
branch, waits for the GitHub Tests workflow, deploys changed Railway services,
and then runs post-deployment smoke checks. For staging, `dev` is the expected
branch and the staging Supabase workflow is the migration gate.

## Remaining Live Proof

- The staging rollout must create or bind the `scheduler` Railway service with
  `/railway.maintenance-scheduler.json`.
- A full backup/restore drill should still be recorded against a disposable
  staging target before production treats scheduled archives as proven recovery
  points.
