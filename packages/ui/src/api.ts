export interface ProblemDetail {
  readonly status: number;
  readonly code: string;
  readonly title?: string;
  readonly requestId?: string;
}

export interface SetupStatus {
  readonly state: string;
  readonly tokenIssued: boolean;
  readonly tokenExpiresAt: string | null;
  readonly step: string;
  readonly progress: number;
}

export interface Principal {
  readonly principalId: number;
  readonly username: string | null;
  readonly serverAdmin: boolean;
  readonly searchOnly: boolean;
}

export interface Silo {
  readonly id: number;
  readonly slug: string;
  readonly displayName: string;
}

export type JsonRecord = Record<string, unknown>;

const csrfKey = 'noderag.csrf';
let csrfToken = sessionStorage.getItem(csrfKey);

export class ApiProblem extends Error {
  readonly detail: ProblemDetail;

  constructor(detail: ProblemDetail) {
    super(detail.title ?? detail.code.replaceAll('_', ' '));
    this.name = 'ApiProblem';
    this.detail = detail;
  }
}

const parseFailure = async (response: Response): Promise<ProblemDetail> => {
  const fallback = { status: response.status, code: `request_failed_${String(response.status)}` };
  try {
    const body = (await response.json()) as Partial<ProblemDetail>;
    return {
      status: typeof body.status === 'number' ? body.status : response.status,
      code: typeof body.code === 'string' ? body.code : fallback.code,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.requestId === 'string' ? { requestId: body.requestId } : {}),
    };
  } catch {
    return fallback;
  }
};

export const api = async <T>(
  path: string,
  init: RequestInit & { readonly idempotent?: boolean } = {},
): Promise<T> => {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken !== null) {
    headers.set('x-csrf-token', csrfToken);
  }
  if (init.idempotent === true && !headers.has('idempotency-key')) {
    headers.set('idempotency-key', crypto.randomUUID());
  }
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!response.ok) throw new ApiProblem(await parseFailure(response));
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get('content-type') ?? '';
  return (contentType.includes('json') ? await response.json() : await response.text()) as T;
};

export const postJson = <T>(
  path: string,
  body: unknown,
  options: { readonly idempotent?: boolean; readonly method?: 'POST' | 'PUT' | 'PATCH' } = {},
): Promise<T> =>
  api<T>(path, {
    method: options.method ?? 'POST',
    body: JSON.stringify(body),
    ...(options.idempotent === undefined ? {} : { idempotent: options.idempotent }),
  });

export const signIn = async (username: string, password: string): Promise<void> => {
  const session = await postJson<{ readonly csrfToken: string }>('/v1/auth/login', {
    username,
    password,
  });
  csrfToken = session.csrfToken;
  sessionStorage.setItem(csrfKey, session.csrfToken);
};

export const signOut = async (): Promise<void> => {
  await api<undefined>('/v1/auth/logout', { method: 'POST' });
  csrfToken = null;
  sessionStorage.removeItem(csrfKey);
};

export const forgetSession = (): void => {
  csrfToken = null;
  sessionStorage.removeItem(csrfKey);
};

export const displayError = (error: unknown): string => {
  if (error instanceof ApiProblem) {
    const friendly: Record<string, string> = {
      authentication_required: 'Please sign in again.',
      csrf_rejected: 'Your session needs to be refreshed. Please sign in again.',
      invalid_request: 'Some information is missing or invalid.',
      mutation_not_ready: 'NodeRag is not ready to make changes yet.',
      read_not_ready: 'Search is temporarily unavailable while NodeRag starts.',
      storage_probe_failed: 'NodeRag could not write to that folder.',
      service_not_operational: 'Finish the first-time setup before signing in.',
    };
    return friendly[error.detail.code] ?? error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
};

export const formatBytes = (value: unknown): string => {
  const bytes = typeof value === 'bigint' ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
};

export const truncateGraphemes = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  if (typeof Intl.Segmenter === 'undefined') return `${value.slice(0, maximum)}…`;
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  return segments.length <= maximum
    ? value
    : `${segments
        .slice(0, maximum)
        .map((entry) => entry.segment)
        .join('')}…`;
};
