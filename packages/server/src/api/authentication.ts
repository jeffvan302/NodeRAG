import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { ApiKeyRateLimiter, authenticateApiKey } from '../identity/api-keys.js';
import { browserMutationAllowed, validateSession } from '../identity/sessions.js';

const parseCookie = (request: FastifyRequest, name: string): string | null => {
  const header = request.headers.cookie;
  if (header === undefined) return null;
  for (const item of header.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
};

export interface AuthenticatedPrincipal {
  readonly principalId: number;
  readonly serverAdmin: boolean;
  readonly searchOnly: boolean;
  readonly sessionToken: string | null;
  readonly csrfAllowed: (candidate: string | undefined, origin: string | undefined) => boolean;
}

export type RequestAuthenticator = (
  request: FastifyRequest,
) => Promise<AuthenticatedPrincipal | null>;

export const createRequestAuthenticator = (
  pool: Pool,
  expectedOrigin: string,
): RequestAuthenticator => {
  const limiter = new ApiKeyRateLimiter();
  const principalDetails = async (
    principalId: number,
  ): Promise<{ serverAdmin: boolean; username: string | null } | null> => {
    const result = await pool.query<{
      server_admin: boolean | null;
      username: string | null;
    }>(
      `SELECT u.server_admin, u.username FROM noderag.principal p
       LEFT JOIN noderag.app_user u ON u.principal_id = p.id
       WHERE p.id = $1 AND NOT p.disabled AND p.deleted_at IS NULL`,
      [principalId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : { serverAdmin: row.server_admin ?? false, username: row.username };
  };

  return async (request) => {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') === true) {
      const result = await authenticateApiKey(
        pool,
        limiter,
        authorization.slice('Bearer '.length),
        request.ip,
      );
      if (!result.ok) return null;
      const details = await principalDetails(result.principalId);
      if (details === null) return null;
      return {
        principalId: result.principalId,
        serverAdmin: false,
        searchOnly: result.searchOnly,
        sessionToken: null,
        csrfAllowed: () => true,
      };
    }
    const sessionToken = parseCookie(request, 'noderag_session');
    if (sessionToken === null) return null;
    const session = await validateSession(pool, sessionToken);
    if (session === null) return null;
    const details = await principalDetails(session.principalId);
    if (details === null) return null;
    return {
      principalId: session.principalId,
      serverAdmin: details.serverAdmin,
      searchOnly: false,
      sessionToken,
      csrfAllowed: (candidate, origin) =>
        browserMutationAllowed({ expectedOrigin, origin, csrfToken: candidate, session }),
    };
  };
};
