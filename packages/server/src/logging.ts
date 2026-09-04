import type { FastifyServerOptions } from 'fastify';

export const loggerOptions: Exclude<FastifyServerOptions['logger'], boolean | undefined> = {
  level: process.env['NODERAG_LOG_LEVEL'] ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body',
      'res.headers.set-cookie',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.setupToken',
      '*.sessionToken',
      '*.csrfToken',
      '*.apiKey',
      '*.ciphertext',
      '*.authTag',
      '*.secretRoot',
      '*.databaseUrl',
    ],
    censor: '[REDACTED]',
  },
};
