import type { FastifyReply } from 'fastify';

export interface ProblemDetail {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance: string;
  readonly code: string;
  readonly requestId: string;
}

export const problemDetail = (
  status: number,
  code: string,
  requestId: string,
  detail?: string,
): ProblemDetail => ({
  type: `https://noderag.local/problems/${code}`,
  title: code.replaceAll('_', ' '),
  status,
  ...(detail === undefined ? {} : { detail }),
  instance: `urn:noderag:request:${requestId}`,
  code,
  requestId,
});

export const sendProblem = (
  reply: FastifyReply,
  status: number,
  code: string,
  requestId: string,
  detail?: string,
) =>
  reply
    .code(status)
    .type('application/problem+json')
    .send(problemDetail(status, code, requestId, detail));
