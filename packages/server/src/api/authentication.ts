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

const singleForwardedHeader = (value: string | string[] | undefined): string | null => {
  if (typeof value !== 'string' || value.includes(',')) return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const isLoopbackAddress = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export const forwardedBrowserOrigin = (input: {
  readonly peerAddress: string | undefined;
  readonly forwardedHost: string | string[] | undefined;
  readonly forwardedProto: string | string[] | undefined;
}): string | null => {
  if (!isLoopbackAddress(input.peerAddress)) return null;
  const host = singleForwardedHeader(input.forwardedHost);
  const protocol = singleForwardedHeader(input.forwardedProto)?.toLowerCase() ?? null;
  if (host === null || (protocol !== 'http' && protocol !== 'https')) return null;
  if (!/^[A-Za-z0-9.[\]:-]+$/u.test(host)) return null;
  try {
    const value = new URL(`${protocol}://${host}`);
    if (
      value.username !== '' ||
      value.password !== '' ||
      value.pathname !== '/' ||
      value.search !== '' ||
      value.hash !== ''
    ) {
      return null;
    }
    return value.origin;
  } catch {
    return null;
  }
};

export const requestBrowserOrigin = (request: FastifyRequest, fallback: string): string =>
  forwardedBrowserOrigin({
    peerAddress: request.raw.socket.remoteAddress,
    forwardedHost: request.headers['x-forwarded-host'],
    forwardedProto: request.headers['x-forwarded-proto'],
  }) ?? fallback;

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

export class RequestAuthenticationError extends Error {
  constructor(
    readonly status: 403 | 429,
    readonly code: 'cidr_denied' | 'rate_limited' | 'server_admin_required',
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'RequestAuthenticationError';
  }
}

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
    const requestOrigin = requestBrowserOrigin(request, expectedOrigin);
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ') === true) {
      const result = await authenticateApiKey(
        pool,
        limiter,
        authorization.slice('Bearer '.length),
        request.ip,
      );
      if (!result.ok) {
        if (result.code === 'rate-limited')
          throw new RequestAuthenticationError(429, 'rate_limited', 60);
        if (result.code === 'cidr-denied') throw new RequestAuthenticationError(403, 'cidr_denied');
        return null;
      }
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
        browserMutationAllowed({
          expectedOrigin: requestOrigin,
          origin,
          csrfToken: candidate,
          session,
        }),
    };
  };
};
