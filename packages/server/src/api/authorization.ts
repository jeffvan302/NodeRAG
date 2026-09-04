import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { siloActionSchema } from '@noderag/shared';
import { z } from 'zod';
import type { RouteClass } from '../application/readiness-policy.js';
import type { SiloScope } from '../identity/scope.js';

const routePolicySchema = z.object({
  method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
  path: z.string().startsWith('/'),
  scope: z.enum(['public', 'authenticated', 'silo', 'server_admin']),
  action: siloActionSchema.optional(),
  emptyBehavior: z.enum(['empty_result', 'not_found']).optional(),
  routeClass: z.enum([
    'health',
    'readiness',
    'setup',
    'authentication',
    'read',
    'mutation',
    'worker_claim',
    'administration',
  ]),
  csrfBrowser: z.boolean(),
  idempotency: z.boolean(),
  searchOnlyAllowed: z.boolean(),
});

const inventorySchema = z.object({
  version: z.literal(1),
  routes: z.array(routePolicySchema).min(1),
});

export type RoutePolicy = z.infer<typeof routePolicySchema> & { readonly routeClass: RouteClass };

export const loadAuthorizationInventory = async (): Promise<readonly RoutePolicy[]> => {
  const path = resolve(
    process.env['NODERAG_ROUTE_AUTHORIZATION'] ?? 'platform/route-authorization.v1.json',
  );
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const inventory = inventorySchema.parse(parsed);
  const keys = inventory.routes.map(({ method, path: routePath }) => `${method} ${routePath}`);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate route authorization entry.');
  for (const route of inventory.routes) {
    if (route.scope === 'silo' && route.action === undefined) {
      throw new Error(`Silo route has no action: ${route.method} ${route.path}`);
    }
    if (route.scope !== 'silo' && route.action !== undefined) {
      throw new Error(`Non-silo route declares an action: ${route.method} ${route.path}`);
    }
    if (
      route.routeClass === 'mutation' &&
      route.scope !== 'public' &&
      !route.idempotency &&
      route.path !== '/v1/auth/logout'
    ) {
      throw new Error(
        `Persistent mutation has no idempotency policy: ${route.method} ${route.path}`,
      );
    }
  }
  return inventory.routes;
};

export interface AuthorizationContext {
  readonly authenticated: boolean;
  readonly serverAdmin: boolean;
  readonly searchOnlyCredential: boolean;
  readonly scope?: SiloScope;
  readonly resourceSiloId?: number;
}

export type AuthorizationDecision =
  | { readonly allowed: true; readonly emptyResult: boolean }
  | { readonly allowed: false; readonly status: 401 | 403 | 404; readonly code: string };

export const authorizeRoute = (
  route: RoutePolicy,
  context: AuthorizationContext,
): AuthorizationDecision => {
  if (route.scope === 'public') return { allowed: true, emptyResult: false };
  if (!context.authenticated)
    return { allowed: false, status: 401, code: 'authentication_required' };
  if (context.searchOnlyCredential && !route.searchOnlyAllowed) {
    return { allowed: false, status: 404, code: 'not_found' };
  }
  if (route.scope === 'server_admin') {
    return context.serverAdmin
      ? { allowed: true, emptyResult: false }
      : { allowed: false, status: 403, code: 'server_admin_required' };
  }
  if (route.scope === 'authenticated') return { allowed: true, emptyResult: false };
  if (context.scope === undefined)
    throw new Error('Silo route authorization requires a SiloScope.');
  if (context.resourceSiloId !== undefined) {
    return context.scope.includes(context.resourceSiloId)
      ? { allowed: true, emptyResult: false }
      : { allowed: false, status: 404, code: 'not_found' };
  }
  if (context.scope.siloIds.length === 0 && route.emptyBehavior === 'empty_result') {
    return { allowed: true, emptyResult: true };
  }
  if (context.scope.siloIds.length === 0) {
    return { allowed: false, status: 404, code: 'not_found' };
  }
  return { allowed: true, emptyResult: false };
};
