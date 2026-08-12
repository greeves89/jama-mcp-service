import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Zwei getrennte Geheimnis-Arten, die nie verwechselt werden duerfen:
 *
 *  1. Jama-Zugangsdaten — muessen im Klartext rekonstruierbar sein, weil wir uns
 *     damit gegen Jama authentifizieren. Daher symmetrische Verschluesselung
 *     (AES-256-GCM) mit dem ENCRYPTION_KEY.
 *
 *  2. MCP-API-Keys — muessen NIE rekonstruierbar sein. Wir vergleichen nur
 *     Hashes. Da der Key selbst 256 Bit Entropie aus dem CSPRNG traegt, ist
 *     SHA-256 hier ausreichend; ein langsamer Passwort-Hash brauchte es nur bei
 *     ratbaren Geheimnissen (dafuer siehe admin/pin.ts mit Argon2id).
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM-Standard
const TAG_LENGTH = 16;
const ENVELOPE_VERSION = 'v1';

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

function keyBuffer(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY muss 32 Byte lang sein (base64-kodiert)');
  }
  return key;
}

/**
 * Verschluesselt beliebigen Text. Ergebnis ist ein selbstbeschreibender String
 * "v1:<iv>:<tag>:<ciphertext>", damit ein spaeterer Schluesselwechsel oder
 * Algorithmuswechsel migrierbar bleibt.
 */
export function encryptSecret(plaintext: string, base64Key: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(envelope: string, base64Key: string): string {
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new DecryptionError('Unbekanntes Format des verschluesselten Werts');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new DecryptionError('IV oder Auth-Tag haben eine unerwartete Laenge');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, keyBuffer(base64Key), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    // Haeufigste Ursache: der ENCRYPTION_KEY wurde geaendert.
    throw new DecryptionError(
      'Entschluesselung fehlgeschlagen — vermutlich wurde der ENCRYPTION_KEY geaendert',
      { cause },
    );
  }
}

export interface GeneratedApiKey {
  /** Vollstaendiger Key. Wird dem Nutzer genau einmal angezeigt. */
  plaintext: string;
  /** Nicht geheimes Praefix zur Wiedererkennung in Listen und Logs. */
  prefix: string;
  /** Was in der Datenbank landet. */
  hash: string;
}

const KEY_NAMESPACE = 'jama_mcp';

/**
 * Erzeugt einen API-Key der Form  jama_mcp_<prefix>_<secret>.
 * Das Praefix identifiziert den Key eindeutig, ohne das Geheimnis preiszugeben —
 * so bleiben Logs und Fehlermeldungen aussagekraeftig und trotzdem sicher.
 *
 * Das Praefix ist bewusst hexadezimal: base64url erzeugt auch Unterstriche, und
 * die wuerden beim Zerlegen des Keys mit der Trennung zwischen den Bestandteilen
 * kollidieren.
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString('hex'); // 12 Zeichen, nur 0-9a-f
  const secret = randomBytes(32).toString('base64url'); // 43 Zeichen, 256 Bit
  const plaintext = `${KEY_NAMESPACE}_${prefix}_${secret}`;
  return { plaintext, prefix, hash: hashApiKey(plaintext) };
}

const KEY_PATTERN = /^jama_mcp_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/;

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Zerlegt einen praesentierten Key, ohne dabei zu verraten, ob er existiert.
 * Das Secret enthaelt selbst Unterstriche, deshalb wird ueber ein Muster
 * getrennt und nicht ueber split().
 */
export function parseApiKey(presented: string): { prefix: string } | undefined {
  const match = KEY_PATTERN.exec(presented);
  return match?.[1] ? { prefix: match[1] } : undefined;
}

/** Laufzeitkonstanter Vergleich zweier Hex-Hashes. */
export function safeCompareHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Opaker Sessiontoken fuer das Admin-Dashboard. */
export function generateSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
