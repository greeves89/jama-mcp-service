import pino from 'pino';

/**
 * Zentraler Logger. Die redact-Liste ist bewusst breit: in diesem Service laufen
 * sowohl Jama-Zugangsdaten als auch API-Keys durch Objekte, die versehentlich
 * in einem Log landen koennten.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'password',
      'clientSecret',
      'client_secret',
      'access_token',
      'accessToken',
      'apiKey',
      'pin',
      'authorization',
      'cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.clientSecret',
      '*.accessToken',
      '*.apiKey',
    ],
    censor: '[redigiert]',
  },
  // Item-Inhalte aus Jama gehoeren nie ins Log — sie koennen personenbezogene
  // oder vertrauliche Spezifikationsdaten enthalten.
  base: { service: 'jama-mcp' },
});

export type Logger = typeof logger;
