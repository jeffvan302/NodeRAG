import type { ReadinessState } from '@noderag/shared';

export type RouteClass =
  | 'health'
  | 'readiness'
  | 'setup'
  | 'authentication'
  | 'read'
  | 'mutation'
  | 'worker_claim'
  | 'administration';

const allowedStates: Readonly<Record<RouteClass, ReadonlySet<ReadinessState>>> = {
  health: new Set([
    'unconfigured',
    'initializing',
    'operational',
    'maintenance',
    'upgrade_required',
    'database_ahead',
    'degraded',
    'unavailable',
  ]),
  readiness: new Set([
    'unconfigured',
    'initializing',
    'operational',
    'maintenance',
    'upgrade_required',
    'database_ahead',
    'degraded',
    'unavailable',
  ]),
  setup: new Set(['unconfigured', 'initializing']),
  authentication: new Set(['operational', 'maintenance', 'degraded']),
  read: new Set(['operational', 'degraded']),
  mutation: new Set(['operational']),
  worker_claim: new Set(['operational']),
  administration: new Set(['operational', 'maintenance']),
};

export const readinessPermits = (state: ReadinessState, routeClass: RouteClass): boolean =>
  allowedStates[routeClass].has(state);

export interface ReadinessFacts {
  readonly databaseReachable: boolean;
  readonly configured: boolean;
  readonly setupInitializing: boolean;
  readonly migrationHead: string | null;
  readonly expectedMigrationHead: string;
  readonly knownMigrationOrder: readonly string[];
  readonly maintenance: boolean;
  readonly degraded: boolean;
}

export const evaluateReadinessState = (facts: ReadinessFacts): ReadinessState => {
  if (!facts.databaseReachable) return 'unavailable';
  if (!facts.configured) return facts.setupInitializing ? 'initializing' : 'unconfigured';
  const currentIndex =
    facts.migrationHead === null ? -1 : facts.knownMigrationOrder.indexOf(facts.migrationHead);
  const expectedIndex = facts.knownMigrationOrder.indexOf(facts.expectedMigrationHead);
  if (expectedIndex === -1) return 'unavailable';
  if (facts.migrationHead !== null && currentIndex === -1) return 'database_ahead';
  if (currentIndex > expectedIndex) return 'database_ahead';
  if (currentIndex < expectedIndex) return 'upgrade_required';
  if (facts.maintenance) return 'maintenance';
  if (facts.degraded) return 'degraded';
  return 'operational';
};
