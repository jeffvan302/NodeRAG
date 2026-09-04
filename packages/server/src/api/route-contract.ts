import type { FastifyInstance } from 'fastify';
import type { RoutePolicy } from './authorization.js';

const routes = new WeakMap<FastifyInstance, Set<string>>();

const methodValues = (method: string | readonly string[]): readonly string[] =>
  typeof method === 'string' ? [method] : method;

export const captureRegisteredRoutes = (app: FastifyInstance): void => {
  const found = new Set<string>();
  routes.set(app, found);
  app.addHook('onRoute', (route) => {
    for (const method of methodValues(route.method)) {
      if (method === 'HEAD' || route.url === '/*') continue;
      found.add(`${method} ${route.url}`);
    }
  });
};

export const registeredRoutes = (app: FastifyInstance): readonly string[] =>
  [...(routes.get(app) ?? [])].sort();

export const assertRouteParity = (
  app: FastifyInstance,
  inventory: readonly RoutePolicy[],
): void => {
  const actual = new Set(registeredRoutes(app));
  const expected = new Set(inventory.map(({ method, path }) => `${method} ${path}`));
  const undocumented = [...actual].filter((key) => !expected.has(key)).sort();
  const unimplemented = [...expected].filter((key) => !actual.has(key)).sort();
  if (undocumented.length > 0 || unimplemented.length > 0) {
    throw new Error(
      `Route contract drift. Undocumented: ${undocumented.join(', ') || 'none'}. ` +
        `Unimplemented: ${unimplemented.join(', ') || 'none'}.`,
    );
  }
};
