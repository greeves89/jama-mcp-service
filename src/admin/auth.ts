import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { adminSessions, loginAttempts } from '../db/schema.js';
import { generateSessionToken, hashSessionToken } from '../shared/crypto.js';
import { getSetting } from '../service/settings.js';
import { getConfig } from '../shared/config.js';
import { AuthError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { settings } from '../db/schema.js';

/**
 * PIN-Authentifizierung fuer das Admin-Dashboard.
 *
 * Ein PIN ist als Geheimnis schwach — acht Ziffern sind in Sekunden
 * durchprobiert. Tragfaehig wird er erst durch die Kombination aus einem
 * langsamen Hash und einer harten Sperre pro IP: Argon2id macht jeden einzelnen
 * Versuch teuer, die Sperre begrenzt ihre Zahl. Beides zusammen, nicht eines
 * davon allein.
 */

const PIN_SETTING_KEY = 'adminPinHash';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Fenster und Grenze der Sperre. */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_THRESHOLD = 5;

// Bewusst hoch angesetzt: der PIN hat wenig Entropie, also muss der Hash die
// Arbeit leisten. Rund 64 MB und drei Durchgaenge kosten pro Versuch spuerbar
// Zeit, sind fuer eine Anmeldung pro Sitzung aber unmerklich.
const ARGON_OPTIONS = { memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export async function isPinConfigured(): Promise<boolean> {
  return (await getSetting(PIN_SETTING_KEY)) !== undefined;
}

/**
 * Uebernimmt beim ersten Start den PIN aus der Umgebung in die Datenbank —
 * als Hash. Danach kann ADMIN_INITIAL_PIN aus der .env entfernt werden.
 */
export async function ensureInitialPin(): Promise<void> {
  if (await isPinConfigured()) return;

  const initial = getConfig().ADMIN_INITIAL_PIN;
  if (!initial) {
    logger.warn(
      'Es ist kein Admin-PIN gesetzt und ADMIN_INITIAL_PIN fehlt. Das Dashboard ist bis zur Vergabe eines PINs nicht nutzbar.',
    );
    return;
  }

  await setPin(initial, 'system');
  logger.info('Admin-PIN aus ADMIN_INITIAL_PIN uebernommen. Die Variable kann nun entfernt werden.');
}

export async function setPin(pin: string, updatedBy: string): Promise<void> {
  if (!/^\d{8,}$/.test(pin)) {
    throw new AuthError('VALIDATION', 'Der PIN muss aus mindestens acht Ziffern bestehen.', 400);
  }
  const hashed = await argonHash(pin, ARGON_OPTIONS);
  await getDb()
    .insert(settings)
    .values({ key: PIN_SETTING_KEY, value: hashed, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: hashed, updatedBy, updatedAt: new Date() },
    });
}

export interface LockoutState {
  gesperrt: boolean;
  fehlversuche: number;
  verbleibendeVersuche: number;
  gesperrtBisMs?: number;
}

/**
 * Zaehlt die Fehlversuche einer IP im Zeitfenster. Erfolgreiche Anmeldungen
 * setzen den Zaehler nicht zurueck — sonst liesse sich die Sperre durch einen
 * bekannten gueltigen Zugang aushebeln.
 */
export async function checkLockout(ip: string): Promise<LockoutState> {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);

  const rows = await getDb()
    .select({
      fehler: sql<number>`count(*)::int`,
      letzter: sql<Date | null>`max(${loginAttempts.ts})`,
    })
    .from(loginAttempts)
    .where(
      and(eq(loginAttempts.ip, ip), eq(loginAttempts.success, false), gte(loginAttempts.ts, since)),
    );

  const fehlversuche = rows[0]?.fehler ?? 0;
  const gesperrt = fehlversuche >= LOCKOUT_THRESHOLD;
  const letzter = rows[0]?.letzter;

  return {
    gesperrt,
    fehlversuche,
    verbleibendeVersuche: Math.max(0, LOCKOUT_THRESHOLD - fehlversuche),
    gesperrtBisMs:
      gesperrt && letzter ? new Date(letzter).getTime() + LOCKOUT_WINDOW_MS : undefined,
  };
}

async function recordAttempt(ip: string, success: boolean): Promise<void> {
  await getDb().insert(loginAttempts).values({ ip, success });
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
}

export async function login(
  pin: string,
  ip: string,
  userAgent?: string,
): Promise<LoginResult> {
  const lockout = await checkLockout(ip);
  if (lockout.gesperrt) {
    const restMinuten = lockout.gesperrtBisMs
      ? Math.ceil((lockout.gesperrtBisMs - Date.now()) / 60_000)
      : 15;
    throw new AuthError(
      'AUTH_DISABLED',
      `Zu viele Fehlversuche. Der Zugang von dieser Adresse ist noch etwa ${restMinuten} Minuten gesperrt.`,
      429,
    );
  }

  const stored = await getSetting(PIN_SETTING_KEY);
  if (typeof stored !== 'string') {
    throw new AuthError('AUTH_INVALID', 'Es ist kein Admin-PIN eingerichtet.', 403);
  }

  let ok = false;
  try {
    ok = await argonVerify(stored, pin);
  } catch {
    ok = false;
  }

  if (!ok) {
    await recordAttempt(ip, false);
    const danach = await checkLockout(ip);
    throw new AuthError(
      'AUTH_INVALID',
      danach.verbleibendeVersuche > 0
        ? `PIN falsch. Noch ${danach.verbleibendeVersuche} Versuche vor der Sperre.`
        : 'PIN falsch. Der Zugang von dieser Adresse ist nun gesperrt.',
    );
  }

  await recordAttempt(ip, true);

  const { token, hash } = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await getDb().insert(adminSessions).values({
    tokenHash: hash,
    expiresAt,
    ip,
    userAgent: userAgent ?? null,
  });

  return { token, expiresAt };
}

export interface AdminSessionInfo {
  id: string;
  expiresAt: Date;
}

export async function validateSession(token: string | undefined): Promise<AdminSessionInfo> {
  if (!token) {
    throw new AuthError('AUTH_MISSING', 'Keine Anmeldung vorhanden.');
  }

  const hash = hashSessionToken(token);
  const rows = await getDb()
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, hash))
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw new AuthError('AUTH_INVALID', 'Die Sitzung ist unbekannt.');
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    await getDb().delete(adminSessions).where(eq(adminSessions.id, session.id));
    throw new AuthError('AUTH_EXPIRED', 'Die Sitzung ist abgelaufen. Bitte erneut anmelden.');
  }

  await getDb()
    .update(adminSessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(adminSessions.id, session.id));

  return { id: session.id, expiresAt: session.expiresAt };
}

export async function logout(token: string | undefined): Promise<void> {
  if (!token) return;
  await getDb().delete(adminSessions).where(eq(adminSessions.tokenHash, hashSessionToken(token)));
}

/** Beendet alle Sitzungen — etwa nach einer PIN-Aenderung. */
export async function logoutAll(): Promise<void> {
  await getDb().delete(adminSessions);
}

export async function activeSessions() {
  return getDb()
    .select()
    .from(adminSessions)
    .where(gte(adminSessions.expiresAt, new Date()))
    .orderBy(desc(adminSessions.lastSeenAt));
}

/** Raeumt abgelaufene Sitzungen und alte Anmeldeversuche auf. */
export async function pruneAuthTables(): Promise<void> {
  await getDb().delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  await getDb()
    .delete(loginAttempts)
    .where(lt(loginAttempts.ts, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
}
