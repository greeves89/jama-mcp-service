import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  safeCompareHex,
} from '../src/shared/crypto.js';

const schluessel = randomBytes(32).toString('base64');

describe('Verschluesselung der Jama-Zugangsdaten', () => {
  it('stellt den Klartext wieder her', () => {
    const geheim = JSON.stringify({ type: 'oauth', clientId: 'abc', clientSecret: 'xyz' });
    expect(decryptSecret(encryptSecret(geheim, schluessel), schluessel)).toBe(geheim);
  });

  it('erzeugt bei gleichem Klartext unterschiedliche Chiffrate', () => {
    // Ohne zufaelligen IV waere an gleichen Chiffraten ablesbar, welche Zugaenge
    // dieselben Zugangsdaten benutzen.
    const a = encryptSecret('gleich', schluessel);
    const b = encryptSecret('gleich', schluessel);
    expect(a).not.toBe(b);
  });

  it('scheitert mit einem falschen Schluessel, statt Unsinn zu liefern', () => {
    const chiffrat = encryptSecret('geheim', schluessel);
    const andererSchluessel = randomBytes(32).toString('base64');
    expect(() => decryptSecret(chiffrat, andererSchluessel)).toThrow(DecryptionError);
  });

  it('erkennt Manipulation am Chiffrat', () => {
    const chiffrat = encryptSecret('geheim', schluessel);
    const teile = chiffrat.split(':');
    const verfaelscht = Buffer.from(teile[3]!, 'base64');
    verfaelscht[0] = (verfaelscht[0]! + 1) % 256;
    teile[3] = verfaelscht.toString('base64');

    // GCM erkennt die Aenderung ueber den Auth-Tag.
    expect(() => decryptSecret(teile.join(':'), schluessel)).toThrow(DecryptionError);
  });

  it('weist ein unbekanntes Format zurueck', () => {
    expect(() => decryptSecret('v9:a:b:c', schluessel)).toThrow(DecryptionError);
    expect(() => decryptSecret('kein-umschlag', schluessel)).toThrow(DecryptionError);
  });

  it('verlangt einen 32 Byte langen Schluessel', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow();
  });

  it('erklaert bei einem Schluesselwechsel die vermutliche Ursache', () => {
    const chiffrat = encryptSecret('geheim', schluessel);
    try {
      decryptSecret(chiffrat, randomBytes(32).toString('base64'));
      expect.unreachable('haette werfen muessen');
    } catch (error) {
      expect((error as Error).message).toContain('ENCRYPTION_KEY');
    }
  });
});

describe('API-Keys', () => {
  it('erzeugt Keys mit erkennbarem Aufbau und eindeutigem Praefix', () => {
    const a = generateApiKey();
    const b = generateApiKey();

    expect(a.plaintext).toMatch(/^jama_mcp_[\w-]+_[\w-]+$/);
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.hash).not.toBe(b.hash);
  });

  it('speichert den Key nie im Klartext, sondern nur als Hash', () => {
    const key = generateApiKey();
    expect(key.hash).toBe(hashApiKey(key.plaintext));
    expect(key.hash).not.toContain(key.plaintext);
    expect(key.hash).toHaveLength(64);
  });

  it('liest das Praefix aus einem praesentierten Key', () => {
    const key = generateApiKey();
    expect(parseApiKey(key.plaintext)?.prefix).toBe(key.prefix);
  });

  it('weist Keys mit falschem Aufbau zurueck', () => {
    expect(parseApiKey('nonsens')).toBeUndefined();
    expect(parseApiKey('jama_mcp_nurdrei')).toBeUndefined();
    expect(parseApiKey('fremd_mcp_abc_def')).toBeUndefined();
    expect(parseApiKey('jama_mcp__leer')).toBeUndefined();
  });
});

describe('Laufzeitkonstanter Vergleich', () => {
  it('erkennt gleiche Hashes', () => {
    const hash = hashApiKey('beliebig');
    expect(safeCompareHex(hash, hash)).toBe(true);
  });

  it('erkennt verschiedene Hashes', () => {
    expect(safeCompareHex(hashApiKey('a'), hashApiKey('b'))).toBe(false);
  });

  it('meldet false statt zu werfen, wenn die Laengen abweichen', () => {
    // Der Vergleich laeuft auch gegen den Platzhalter-Hash unbekannter Keys —
    // ein Wurf wuerde dort verraten, dass der Key nicht existiert.
    expect(safeCompareHex('abcd', hashApiKey('x'))).toBe(false);
    expect(safeCompareHex('', hashApiKey('x'))).toBe(false);
  });
});
