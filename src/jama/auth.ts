import { z } from 'zod';
import { JamaApiError, ServiceError, explainJamaError } from '../shared/errors.js';

/**
 * Beschafft Authorization-Header fuer Jama.
 *
 * OAuth 2.0 Client Credentials ist der Primaerweg: es funktioniert auch in
 * SAML/SSO-Umgebungen, in denen Basic Auth grundsaetzlich scheitert. Basic Auth
 * bleibt als Fallback fuer Instanzen ohne OAuth-Unterstuetzung.
 */

export const oauthCredentialsSchema = z.object({
  type: z.literal('oauth'),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export const basicCredentialsSchema = z.object({
  type: z.literal('basic'),
  username: z.string().min(1),
  password: z.string().min(1),
});

export const jamaCredentialsSchema = z.discriminatedUnion('type', [
  oauthCredentialsSchema,
  basicCredentialsSchema,
]);

export type JamaCredentials = z.infer<typeof jamaCredentialsSchema>;

interface CachedToken {
  header: string;
  expiresAt: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
});

/**
 * Token-Cache je (Instanz + Client-ID). Der Schluessel enthaelt bewusst NICHT
 * das Secret, aber die Client-ID reicht zur Unterscheidung, weil pro Person
 * eigene Credentials hinterlegt werden.
 */
const tokenCache = new Map<string, CachedToken>();

function tokenCacheKey(baseUrl: string, credentials: JamaCredentials): string {
  return credentials.type === 'oauth'
    ? `${baseUrl}|oauth|${credentials.clientId}`
    : `${baseUrl}|basic|${credentials.username}`;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Liefert einen gueltigen Authorization-Header. Bei OAuth wird das Token
 * gecacht und 60 Sekunden vor Ablauf erneuert, damit ein laufender Aufruf nicht
 * mitten in der Verarbeitung ungueltig wird.
 */
export async function getAuthHeader(
  baseUrl: string,
  credentials: JamaCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (credentials.type === 'basic') {
    return basicAuthHeader(credentials.username, credentials.password);
  }

  const key = tokenCacheKey(baseUrl, credentials);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.header;
  }

  const header = await requestOAuthToken(baseUrl, credentials, fetchImpl);
  tokenCache.set(key, header);
  return header.header;
}

async function requestOAuthToken(
  baseUrl: string,
  credentials: z.infer<typeof oauthCredentialsSchema>,
  fetchImpl: typeof fetch,
): Promise<CachedToken> {
  const url = new URL('/rest/oauth/token', baseUrl).toString();
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(credentials.clientId, credentials.clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new ServiceError(
      'JAMA_UNAVAILABLE',
      `Jama unter ${baseUrl} nicht erreichbar: ${cause instanceof Error ? cause.message : String(cause)}`,
      502,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new JamaApiError(response.status, explainJamaError(response.status, text));
  }

  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new ServiceError(
      'JAMA_UNEXPECTED',
      'Die Token-Antwort von Jama enthielt kein access_token',
      502,
    );
  }

  // Ohne expires_in gilt die von Jama dokumentierte Standardlaufzeit von einer Stunde.
  const lifetimeSeconds = parsed.data.expires_in ?? 3600;
  const safetyMarginSeconds = 60;

  return {
    header: `Bearer ${parsed.data.access_token}`,
    expiresAt: Date.now() + Math.max(30, lifetimeSeconds - safetyMarginSeconds) * 1000,
  };
}

/** Verwirft ein zwischengespeichertes Token, etwa nach einem 401. */
export function invalidateToken(baseUrl: string, credentials: JamaCredentials): void {
  tokenCache.delete(tokenCacheKey(baseUrl, credentials));
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
