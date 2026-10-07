import { statfs } from 'node:fs/promises';
import type { Pool } from 'pg';
import { readSealedChatEventLog } from './log-store.js';

const number = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('chat_health_value_invalid');
  return parsed;
};

const metric = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('chat_health_metric_invalid');
  return Math.round(parsed * 100) / 100;
};

const groupedCounts = (
  rows: readonly Record<string, unknown>[],
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    rows.map((row) => [String(row['state'] ?? row['status']), number(row['count'])]),
  );

export interface ChatHealthReport {
  readonly contract: 'chat-health.v1';
  readonly generatedAt: string;
  readonly providers: readonly Record<string, unknown>[];
  readonly runs: {
    readonly counts: Readonly<Record<string, number>>;
    readonly active: readonly Record<string, unknown>[];
    readonly failedLast24Hours: number;
  };
  readonly capacity: Readonly<Record<string, number>>;
  readonly context: {
    readonly jobs: Readonly<Record<string, number>>;
    readonly snapshots: number;
    readonly foldedMessages: number;
    readonly exactPins: number;
    readonly staleLeases: number;
  };
  readonly storage: {
    readonly configured: boolean;
    readonly state: 'healthy' | 'unavailable';
    readonly freeBytes: string | null;
    readonly recordedBytes: string;
  };
  readonly archives: {
    readonly segments: Readonly<Record<string, number>>;
    readonly unlinkedFoldedMessages: number;
    readonly unlinkedSnapshots: number;
    readonly verifiedSample: number;
    readonly failedSample: number;
    readonly sampleLimit: number;
  };
  readonly reconciliation: {
    readonly operations: Readonly<Record<string, number>>;
    readonly quarantinedConflicts: number;
    readonly latest: Record<string, unknown> | null;
  };
  readonly performance: {
    readonly sampleLimit: number;
    readonly timeToFirstTokenMs: Readonly<Record<string, number | null>>;
    readonly eventCommitLatencyMs: Readonly<Record<string, number | null>>;
    readonly toolCallLatencyMs: Readonly<Record<string, number | null>>;
    readonly contextInputTokens: Readonly<Record<string, number | null>>;
    readonly compressionRatio: Readonly<Record<string, number | null>>;
    readonly runtimeMemory: { readonly rssBytes: string; readonly heapUsedBytes: string };
  };
  readonly quotas: Record<string, unknown>;
  readonly errorsLast24Hours: readonly Record<string, unknown>[];
}

export const loadChatHealth = async (pool: Pool): Promise<ChatHealthReport> => {
  const [
    providers,
    runCounts,
    activeRuns,
    failedRuns,
    capacity,
    contextJobs,
    contextCounts,
    archiveCounts,
    archiveLinks,
    archiveSample,
    reconciliationCounts,
    reconciliationConflicts,
    latestReconciliation,
    settings,
    recordedBytes,
    errors,
    performance,
  ] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT connection.provider_kind,connection.enabled,connection.generation_model,
              jsonb_object_agg(capability.capability,capability.status ORDER BY capability.capability)
                AS capabilities,
              max(capability.tested_at) AS last_tested_at
       FROM noderag.chat_provider_connection AS connection
       JOIN noderag.chat_provider_capability AS capability
         ON capability.connection_id=connection.id
       GROUP BY connection.id,connection.provider_kind,connection.enabled,connection.generation_model
       ORDER BY connection.provider_kind`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT status,count(*)::integer AS count FROM noderag.chat_run GROUP BY status`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT run.id,run.status,run.provider_kind,run.model,run.attempts,run.maximum_attempts,
              run.queued_at,run.started_at,run.heartbeat_at,run.leased_until,
              conversation.name,principal.label AS owner
       FROM noderag.chat_run AS run
       JOIN noderag.chat_conversation AS conversation ON conversation.id=run.conversation_id
       JOIN noderag.principal AS principal ON principal.id=conversation.owner_principal_id
       WHERE run.status IN ('queued','running','cancelling')
       ORDER BY run.queued_at LIMIT 100`,
    ),
    pool.query<{ count: unknown }>(
      `SELECT count(*)::integer AS count FROM noderag.chat_run
       WHERE status='failed' AND updated_at>=now()-interval '24 hours'`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT count(*)::integer AS profiles,
              count(*) FILTER (WHERE COALESCE(administrator_context_tokens,runtime_context_tokens,
                configured_context_tokens,advertised_context_tokens) IS NOT NULL)::integer AS known,
              count(*) FILTER (WHERE COALESCE(administrator_context_tokens,runtime_context_tokens,
                configured_context_tokens,advertised_context_tokens) IS NULL)::integer AS unknown,
              count(*) FILTER (WHERE COALESCE((provider_metadata->>'catalogStale')::boolean,false))::integer
                AS stale
       FROM noderag.chat_model_profile`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT state,count(*)::integer AS count FROM noderag.chat_context_compression_job GROUP BY state`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT (SELECT count(*) FROM noderag.chat_context_snapshot)::integer AS snapshots,
              (SELECT count(*) FROM noderag.chat_message WHERE context_state='folded')::integer
                AS folded_messages,
              (SELECT count(*) FROM noderag.chat_message WHERE pinned)::integer AS exact_pins,
              (SELECT count(*) FROM noderag.chat_context_compression_job
               WHERE state IN ('running','cancelling') AND leased_until<=now())::integer AS stale_leases`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT state,count(*)::integer AS count FROM noderag.chat_log_segment GROUP BY state`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT (SELECT count(*) FROM noderag.chat_message
               WHERE context_state='folded' AND archived_segment_id IS NULL)::integer
                AS unlinked_folded_messages,
              (SELECT count(*) FROM noderag.chat_context_snapshot
               WHERE log_segment_id IS NULL)::integer AS unlinked_snapshots`,
    ),
    pool.query<{ conversation_id: string; segment_number: unknown }>(
      `SELECT conversation_id,segment_number FROM noderag.chat_log_segment
       WHERE state='sealed' ORDER BY sealed_at DESC NULLS LAST,conversation_id,segment_number
       LIMIT 20`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT state,count(*)::integer AS count FROM noderag.chat_import_operation GROUP BY state`,
    ),
    pool.query<{ count: unknown }>(
      `SELECT count(*)::integer AS count FROM noderag.chat_import_conflict`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT id,state,safe_error_code,created_at,finished_at,diagnostics
       FROM noderag.chat_import_operation ORDER BY created_at DESC LIMIT 1`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT settings.storage_resolved_path,settings.daily_run_quota,
              settings.daily_input_token_quota,settings.daily_output_token_quota,
              settings.artifact_chat_quota_bytes,settings.retention_days,settings.archive_after_days,
              COALESCE(usage.runs,0)::integer AS runs_today,
              COALESCE(usage.input_tokens,0)::bigint AS input_tokens_today,
              COALESCE(usage.output_tokens,0)::bigint AS output_tokens_today
       FROM noderag.chat_configuration_current AS current
       JOIN noderag.chat_settings_revision AS settings ON settings.id=current.settings_revision_id
       LEFT JOIN LATERAL (
         SELECT sum(run_count) AS runs,sum(input_tokens) AS input_tokens,
                sum(output_tokens) AS output_tokens
         FROM noderag.chat_usage_daily WHERE usage_date=CURRENT_DATE
       ) AS usage ON true
       WHERE current.singleton=true`,
    ),
    pool.query<{ bytes: unknown }>(
      `SELECT (
         COALESCE((SELECT sum(byte_length) FROM noderag.chat_log_segment),0) +
         COALESCE((SELECT sum(byte_length) FROM noderag.chat_artifact_revision),0) +
         COALESCE((SELECT sum(byte_length) FROM noderag.chat_file WHERE state='active'),0) +
         COALESCE((SELECT sum(output_bytes) FROM noderag.chat_export_job WHERE state='succeeded'),0)
       )::bigint AS bytes`,
    ),
    pool.query<Record<string, unknown>>(
      `SELECT source,safe_error_code,count(*)::integer AS count,max(occurred_at) AS last_seen_at
       FROM (
         SELECT 'run'::text AS source,safe_error_code,updated_at AS occurred_at
         FROM noderag.chat_run WHERE safe_error_code IS NOT NULL AND updated_at>=now()-interval '24 hours'
         UNION ALL
         SELECT 'compression',safe_error_code,updated_at
         FROM noderag.chat_context_compression_job
         WHERE safe_error_code IS NOT NULL AND updated_at>=now()-interval '24 hours'
         UNION ALL
         SELECT 'export',error_code AS safe_error_code,updated_at
         FROM noderag.chat_export_job
         WHERE error_code IS NOT NULL AND updated_at>=now()-interval '24 hours'
         UNION ALL
         SELECT 'reconciliation',safe_error_code,COALESCE(finished_at,created_at)
         FROM noderag.chat_import_operation
         WHERE safe_error_code IS NOT NULL AND created_at>=now()-interval '24 hours'
       ) AS failure
       GROUP BY source,safe_error_code ORDER BY max(occurred_at) DESC,source,safe_error_code LIMIT 100`,
    ),
    pool.query<Record<string, unknown>>(
      `WITH ttft_sample AS (
         SELECT GREATEST(0,EXTRACT(EPOCH FROM (first_output.at-run.started_at))*1000) AS value
         FROM noderag.chat_run run
         CROSS JOIN LATERAL (
           SELECT min(event.occurred_at) AS at FROM noderag.chat_event event
           WHERE event.run_id=run.id AND event.event_type='response.output_text.delta'
         ) first_output
         WHERE run.started_at IS NOT NULL AND first_output.at IS NOT NULL
         ORDER BY run.finished_at DESC NULLS LAST LIMIT 10000
       ), event_sample AS (
         SELECT GREATEST(0,EXTRACT(EPOCH FROM (committed_at-occurred_at))*1000) AS value
         FROM noderag.chat_event ORDER BY committed_at DESC LIMIT 10000
       ), tool_sample AS (
         SELECT GREATEST(0,COALESCE(duration_ms,
           EXTRACT(EPOCH FROM (finished_at-started_at))*1000)) AS value
         FROM noderag.chat_tool_call WHERE finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 10000
       ), context_sample AS (
         SELECT estimated_input_tokens::numeric AS value FROM noderag.chat_run
         WHERE estimated_input_tokens>0 ORDER BY updated_at DESC LIMIT 10000
       ), compression_sample AS (
         SELECT snapshot.context_tokens::numeric / NULLIF(
                  CEIL(SUM(length(message.content))::numeric/4),0
                ) AS value
         FROM noderag.chat_context_snapshot snapshot
         JOIN noderag.chat_message message
           ON message.conversation_id=snapshot.conversation_id
          AND message.sequence<=snapshot.fold_through_sequence
         GROUP BY snapshot.id,snapshot.context_tokens,snapshot.created_at
         ORDER BY snapshot.created_at DESC LIMIT 10000
       ) SELECT
         (SELECT count(*) FROM ttft_sample)::integer AS ttft_samples,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FROM ttft_sample) AS ttft_p50,
         (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FROM ttft_sample) AS ttft_p95,
         (SELECT count(*) FROM event_sample)::integer AS event_samples,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FROM event_sample) AS event_p50,
         (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FROM event_sample) AS event_p95,
         (SELECT count(*) FROM tool_sample)::integer AS tool_samples,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY value) FROM tool_sample) AS tool_p50,
         (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FROM tool_sample) AS tool_p95,
         (SELECT count(*) FROM context_sample)::integer AS context_samples,
         (SELECT avg(value) FROM context_sample) AS context_average,
         (SELECT max(value) FROM context_sample) AS context_maximum,
         (SELECT count(*) FROM compression_sample)::integer AS compression_samples,
         (SELECT avg(value) FROM compression_sample) AS compression_average`,
    ),
  ]);
  const setting = settings.rows[0] ?? {};
  const root =
    typeof setting['storage_resolved_path'] === 'string' ? setting['storage_resolved_path'] : null;
  let freeBytes: string | null = null;
  let storageState: 'healthy' | 'unavailable' = 'unavailable';
  if (root !== null) {
    try {
      const information = await statfs(root, { bigint: true });
      freeBytes = (information.bavail * information.bsize).toString();
      storageState = 'healthy';
    } catch {
      // An unavailable configured root is returned as state, never as a raw filesystem exception.
    }
  }
  let verifiedSample = 0;
  let failedSample = 0;
  if (root !== null) {
    for (const segment of archiveSample.rows) {
      try {
        await readSealedChatEventLog(
          pool,
          root,
          segment.conversation_id,
          number(segment.segment_number),
        );
        verifiedSample += 1;
      } catch {
        failedSample += 1;
      }
    }
  } else {
    failedSample = archiveSample.rows.length;
  }
  const capacityRow = capacity.rows[0] ?? {};
  const contextRow = contextCounts.rows[0] ?? {};
  const archiveLinkRow = archiveLinks.rows[0] ?? {};
  const performanceRow = performance.rows[0] ?? {};
  const memory = process.memoryUsage();
  return {
    contract: 'chat-health.v1',
    generatedAt: new Date().toISOString(),
    providers: providers.rows.map((row) => ({
      provider: row['provider_kind'],
      serviceRoot: row['provider_kind'] === 'ollama_cloud' ? 'https://ollama.com' : null,
      enabled: row['enabled'],
      generationModel: row['generation_model'],
      capabilities: row['capabilities'],
      lastTestedAt:
        row['last_tested_at'] instanceof Date ? row['last_tested_at'].toISOString() : null,
    })),
    runs: {
      counts: groupedCounts(runCounts.rows),
      active: activeRuns.rows.map((row) => ({
        id: row['id'],
        status: row['status'],
        provider: row['provider_kind'],
        model: row['model'],
        attempts: number(row['attempts']),
        maximumAttempts: number(row['maximum_attempts']),
        queuedAt: row['queued_at'],
        startedAt: row['started_at'],
        heartbeatAt: row['heartbeat_at'],
        leasedUntil: row['leased_until'],
        chat: row['name'],
        owner: row['owner'],
      })),
      failedLast24Hours: number(failedRuns.rows[0]?.count),
    },
    capacity: {
      profiles: number(capacityRow['profiles']),
      known: number(capacityRow['known']),
      unknown: number(capacityRow['unknown']),
      stale: number(capacityRow['stale']),
    },
    context: {
      jobs: groupedCounts(contextJobs.rows),
      snapshots: number(contextRow['snapshots']),
      foldedMessages: number(contextRow['folded_messages']),
      exactPins: number(contextRow['exact_pins']),
      staleLeases: number(contextRow['stale_leases']),
    },
    storage: {
      configured: root !== null,
      state: storageState,
      freeBytes,
      recordedBytes: String(recordedBytes.rows[0]?.bytes ?? '0'),
    },
    archives: {
      segments: groupedCounts(archiveCounts.rows),
      unlinkedFoldedMessages: number(archiveLinkRow['unlinked_folded_messages']),
      unlinkedSnapshots: number(archiveLinkRow['unlinked_snapshots']),
      verifiedSample,
      failedSample,
      sampleLimit: 20,
    },
    reconciliation: {
      operations: groupedCounts(reconciliationCounts.rows),
      quarantinedConflicts: number(reconciliationConflicts.rows[0]?.count),
      latest: latestReconciliation.rows[0] ?? null,
    },
    performance: {
      sampleLimit: 10_000,
      timeToFirstTokenMs: {
        samples: number(performanceRow['ttft_samples']),
        p50: metric(performanceRow['ttft_p50']),
        p95: metric(performanceRow['ttft_p95']),
      },
      eventCommitLatencyMs: {
        samples: number(performanceRow['event_samples']),
        p50: metric(performanceRow['event_p50']),
        p95: metric(performanceRow['event_p95']),
      },
      toolCallLatencyMs: {
        samples: number(performanceRow['tool_samples']),
        p50: metric(performanceRow['tool_p50']),
        p95: metric(performanceRow['tool_p95']),
      },
      contextInputTokens: {
        samples: number(performanceRow['context_samples']),
        average: metric(performanceRow['context_average']),
        maximum: metric(performanceRow['context_maximum']),
      },
      compressionRatio: {
        samples: number(performanceRow['compression_samples']),
        average: metric(performanceRow['compression_average']),
      },
      runtimeMemory: {
        rssBytes: String(memory.rss),
        heapUsedBytes: String(memory.heapUsed),
      },
    },
    quotas: {
      dailyRunLimit: setting['daily_run_quota'],
      dailyInputTokenLimit: setting['daily_input_token_quota'],
      dailyOutputTokenLimit: setting['daily_output_token_quota'],
      artifactBytesPerChat: setting['artifact_chat_quota_bytes'],
      runsToday: number(setting['runs_today']),
      inputTokensToday: String(setting['input_tokens_today'] ?? '0'),
      outputTokensToday: String(setting['output_tokens_today'] ?? '0'),
      retentionDays: number(setting['retention_days']),
      archiveAfterDays: number(setting['archive_after_days']),
    },
    errorsLast24Hours: errors.rows.map((row) => ({
      source: row['source'],
      code: row['safe_error_code'],
      count: number(row['count']),
      lastSeenAt: row['last_seen_at'],
    })),
  };
};
