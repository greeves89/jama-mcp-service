import { z } from 'zod';

/**
 * Zentrale, validierte Konfiguration. Faellt der Prozess hier aus, startet der
 * Service gar nicht erst — besser als ein halb konfigurierter Betrieb, bei dem
 * etwa der ENCRYPTION_KEY fehlt und Credentials unlesbar werden.
 */

const base64Key32 = z
  .string()
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'muss 32 Byte base64-kodiert sein (z. B. via "npm run secrets")' },
  );

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) =>
    typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()),
  );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8081'),

  /**
   * Anzahl der Proxys vor diesem Dienst.
   *
   * Die Anmeldesperre zaehlt Fehlversuche pro Client-Adresse, und diese Adresse
   * stammt aus X-Forwarded-For. Wuerde dem gesamten Header vertraut, koennte
   * ein Angreifer eine beliebige Adresse voranstellen und sich fuer jeden
   * Rateversuch eine neue ausdenken — die Sperre liefe ins Leere. Mit einer
   * festen Zahl wertet Fastify nur die Eintraege aus, die die eigenen Proxys
   * angehaengt haben.
   *
   * 1 ist der Normalfall (ein nginx oder ein Traefik davor). Steht zusaetzlich
   * ein CDN oder ein weiterer Proxy davor, entsprechend erhoehen — sonst sehen
   * alle Anfragen wie von derselben Adresse aus.
   *
   * Vorausgesetzt ist dabei, dass der Dienst NUR ueber den Proxy erreichbar ist.
   * Beide Compose-Dateien nutzen dafuer ausschliesslich "expose". Wuerde der
   * Port direkt nach aussen gemappt, koennte sich jeder direkt verbindende
   * Client selbst als der eine vertraute Proxy ausgeben — die Einstellung hier
   * waere dann wirkungslos.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),

  ENCRYPTION_KEY: base64Key32,
  SESSION_SECRET: base64Key32,
  ADMIN_INITIAL_PIN: z
    .string()
    .regex(/^\d{8,}$/, 'PIN muss aus mindestens 8 Ziffern bestehen')
    .optional(),

  JAMA_RATE_LIMIT_RPS: z.coerce.number().min(0.5).max(10).default(6),
  JAMA_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(4),
  MCP_RESPONSE_TOKEN_BUDGET: z.coerce.number().int().min(1000).max(200_000).default(15_000),
  USAGE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180),

  GLOBAL_READ_ONLY: booleanish.default(false),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Konfiguration ungueltig:\n${details}`);
  }
  return parsed.data;
}

export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Nur fuer Tests: erzwingt ein Neuladen beim naechsten getConfig(). */
export function resetConfigCache(): void {
  cached = undefined;
}
