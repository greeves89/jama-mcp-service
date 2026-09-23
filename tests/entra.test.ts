import { createHmac, createSign, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entraEingerichtet, leereSchluesselspeicher, pruefeToken } from '../src/auth/entra.js';
import { resetConfigCache } from '../src/shared/config.js';
import { AuthError } from '../src/shared/errors.js';
import { logger } from '../src/shared/logger.js';

/**
 * Die Tokenpruefung gegen den Firmenzugang, vollstaendig ohne Netz.
 *
 * Alle Token entstehen hier mit einem eigenen RSA-Schluesselpaar, der
 * Schluesselsatz kommt aus einem fetch-Doppelgaenger. Damit laesst sich jede
 * einzelne Pruefung gezielt scheitern lassen — und genau darum geht es: Diese
 * Datei ist der Beleg, dass keine der sechs Huerden versehentlich uebersprungen
 * werden kann, wenn jemand spaeter am Ablauf schraubt.
 *
 * Die Faelle sind bewusst einzeln gehalten. Ein Sammeltest wuerde beim ersten
 * Fehlschlag abbrechen und die uebrigen Luecken verdecken.
 */

const AUSSTELLER = 'https://login.example.com/11111111-1111-1111-1111-111111111111/v2.0';
const EMPFAENGER = 'api://22222222-2222-2222-2222-222222222222';
const BERECHTIGUNG = 'mcp.use';
const KID = 'schluessel-eins';
const FREMDES_KID = 'schluessel-zwei';
const OID = '33333333-3333-3333-3333-333333333333';
const BREMSE_IN_MS = 5 * 60 * 1000;

// Einmal erzeugt, nicht pro Test: zwei 2048er Paare kosten sonst in jedem
// einzelnen Fall spuerbar Zeit.
const eigenes = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fremdes = generateKeyPairSync('rsa', { modulusLength: 2048 });

function base64url(wert: Buffer | string): string {
  return Buffer.from(wert).toString('base64url');
}

function schluesselsatz(): unknown {
  const jwk = eigenes.publicKey.export({ format: 'jwk' });
  return { keys: [{ ...jwk, kid: KID, use: 'sig', alg: 'RS256' }] };
}

function kopf(zusatz: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: 'RS256', typ: 'JWT', kid: KID, ...zusatz };
}

function nutzlast(zusatz: Record<string, unknown> = {}): Record<string, unknown> {
  const jetzt = Math.floor(Date.now() / 1000);
  return {
    iss: AUSSTELLER,
    aud: EMPFAENGER,
    exp: jetzt + 3600,
    nbf: jetzt - 60,
    oid: OID,
    email: 'person@example.com',
    preferred_username: 'anmeldung@example.com',
    name: 'Beispielperson',
    scp: BERECHTIGUNG,
    ...zusatz,
  };
}

function baueToken(
  kopfDaten: Record<string, unknown> = kopf(),
  nutzDaten: Record<string, unknown> = nutzlast(),
  privat: KeyObject = eigenes.privateKey,
): string {
  const kopfTeil = base64url(JSON.stringify(kopfDaten));
  const nutzTeil = base64url(JSON.stringify(nutzDaten));
  const signatur = createSign('RSA-SHA256').update(`${kopfTeil}.${nutzTeil}`).sign(privat);
  return `${kopfTeil}.${nutzTeil}.${base64url(signatur)}`;
}

/** Zaehlt die Abrufe des Schluesselsatzes — die Bremse wird daran gemessen. */
let abrufe = 0;
let antwort: () => Response = () =>
  new Response(JSON.stringify(schluesselsatz()), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** Alles, was der Logger gesehen hat — geprueft wird, dass kein Token dabei ist. */
let protokoll: unknown[][] = [];

const UMGEBUNG = [
  'DATABASE_URL',
  'ENCRYPTION_KEY',
  'SESSION_SECRET',
  'ENTRA_ISSUER',
  'ENTRA_AUDIENCE',
  'ENTRA_SCOPE',
  'ENTRA_JWKS_URL',
] as const;

let vorher: Record<string, string | undefined> = {};

beforeEach(() => {
  vorher = Object.fromEntries(UMGEBUNG.map((name) => [name, process.env[name]]));

  process.env.DATABASE_URL = 'postgres://dienst@db.example.invalid:5432/test';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.SESSION_SECRET = randomBytes(32).toString('base64');
  process.env.ENTRA_ISSUER = AUSSTELLER;
  process.env.ENTRA_AUDIENCE = EMPFAENGER;
  process.env.ENTRA_SCOPE = BERECHTIGUNG;
  delete process.env.ENTRA_JWKS_URL;
  resetConfigCache();
  leereSchluesselspeicher();

  abrufe = 0;
  antwort = () =>
    new Response(JSON.stringify(schluesselsatz()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      abrufe += 1;
      return antwort();
    }),
  );

  protokoll = [];
  vi.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]): void => {
    protokoll.push(args);
  }) as unknown as typeof logger.warn);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const name of UMGEBUNG) {
    const wert = vorher[name];
    if (wert === undefined) delete process.env[name];
    else process.env[name] = wert;
  }
  resetConfigCache();
  leereSchluesselspeicher();
});

describe('gueltiges Token', () => {
  it('liefert die Person aus den Angaben des Ausstellers', async () => {
    const person = await pruefeToken(baueToken());

    expect(person.kennung).toBe(OID);
    expect(person.email).toBe('person@example.com');
    expect(person.anmeldename).toBe('anmeldung@example.com');
    expect(person.name).toBe('Beispielperson');
  });

  it('holt den Schluesselsatz an der aus dem Aussteller abgeleiteten Adresse', async () => {
    await pruefeToken(baueToken());

    const adresse = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    // Der Aussteller endet auf /v2.0, der Satz liegt eine Ebene darueber.
    expect(adresse).toBe(
      'https://login.example.com/11111111-1111-1111-1111-111111111111/discovery/v2.0/keys',
    );
  });
});

describe('Verfahren', () => {
  /**
   * Alle drei Faelle pruefen zusaetzlich, dass kein Schluesselsatz geholt
   * wurde. Das ist der eigentliche Nachweis: Faellt die Entscheidung ueber das
   * Verfahren wirklich vor allem anderen, kann der Dienst das Token noch gar
   * nicht angefasst haben. Ohne diese Zusatzpruefung wuerden die Faelle auch
   * dann gruen bleiben, wenn die Verfahrenspruefung fehlt und erst die
   * Signatur scheitert — und genau darauf darf man sich nicht verlassen.
   */
  it('weist alg: none ab, ohne den Schluesselsatz zu holen', async () => {
    // Bewusst MIT Signaturabschnitt: Ein leerer Abschnitt wuerde schon am
    // Aufbau scheitern und die Verfahrenspruefung verdecken.
    const kopfTeil = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }));
    const nutzTeil = base64url(JSON.stringify(nutzlast()));

    await expect(pruefeToken(`${kopfTeil}.${nutzTeil}.AAAA`)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });

  it('weist auch alg: none ohne Signaturabschnitt ab', async () => {
    const kopfTeil = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }));
    const nutzTeil = base64url(JSON.stringify(nutzlast()));

    await expect(pruefeToken(`${kopfTeil}.${nutzTeil}.`)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });

  it('weist HS256 ab, auch wenn mit dem oeffentlichen Schluessel unterschrieben wurde', async () => {
    // Der klassische Angriff: Der oeffentliche Schluessel steht im JWKS und
    // waere als HMAC-Geheimnis jedem bekannt.
    const geheimnis = eigenes.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const kopfTeil = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: KID }));
    const nutzTeil = base64url(JSON.stringify(nutzlast()));
    const signatur = createHmac('sha256', geheimnis).update(`${kopfTeil}.${nutzTeil}`).digest();

    await expect(pruefeToken(`${kopfTeil}.${nutzTeil}.${base64url(signatur)}`)).rejects.toThrow(
      AuthError,
    );
    expect(abrufe).toBe(0);
  });

  it('weist ein anderes asymmetrisches Verfahren ab', async () => {
    // PS256 nutzt denselben Schluessel mit anderer Polsterung. Erlaubt ist
    // ausdruecklich nur RS256.
    const token = baueToken(kopf({ alg: 'PS256' }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });
});

describe('Signatur', () => {
  it('weist ein Token ab, das mit einem anderen Schluessel unterschrieben wurde', async () => {
    const token = baueToken(kopf(), nutzlast(), fremdes.privateKey);

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('weist ab, wenn die Nutzlast nach dem Unterschreiben veraendert wurde', async () => {
    const [kopfTeil, , signaturTeil] = baueToken().split('.');
    const getauscht = base64url(JSON.stringify(nutzlast({ oid: 'fremde-kennung' })));

    await expect(pruefeToken(`${kopfTeil}.${getauscht}.${signaturTeil}`)).rejects.toThrow(
      AuthError,
    );
  });
});

describe('Aussteller', () => {
  it('weist einen fremden Aussteller ab', async () => {
    const token = baueToken(kopf(), nutzlast({ iss: 'https://login.example.com/fremd/v2.0' }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('vergleicht exakt und nicht als Praefix', async () => {
    const token = baueToken(kopf(), nutzlast({ iss: `${AUSSTELLER}.angriff.example.com` }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });
});

describe('Empfaenger', () => {
  it('weist einen fremden Empfaenger ab', async () => {
    const token = baueToken(kopf(), nutzlast({ aud: 'api://ein-anderer-dienst' }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('weist ein Feld mit mehreren Werten ab, das den eigenen nicht enthaelt', async () => {
    const token = baueToken(
      kopf(),
      nutzlast({ aud: ['api://ein-anderer-dienst', 'api://noch-ein-dienst'] }),
    );

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('nimmt ein Feld mit mehreren Werten an, das den eigenen enthaelt', async () => {
    const token = baueToken(kopf(), nutzlast({ aud: ['api://ein-anderer-dienst', EMPFAENGER] }));

    await expect(pruefeToken(token)).resolves.toMatchObject({ kennung: OID });
  });

  it('weist ein Token ohne Empfaenger ab', async () => {
    const token = baueToken(kopf(), nutzlast({ aud: undefined }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });
});

describe('Laufzeit', () => {
  it('weist ein abgelaufenes Token ab', async () => {
    const jetzt = Math.floor(Date.now() / 1000);
    const token = baueToken(kopf(), nutzlast({ exp: jetzt - 120 }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('nimmt ein Token an, das erst innerhalb der Toleranz abgelaufen ist', async () => {
    const jetzt = Math.floor(Date.now() / 1000);
    const token = baueToken(kopf(), nutzlast({ exp: jetzt - 30 }));

    await expect(pruefeToken(token)).resolves.toMatchObject({ kennung: OID });
  });

  it('weist ein noch nicht gueltiges Token ab', async () => {
    const jetzt = Math.floor(Date.now() / 1000);
    const token = baueToken(kopf(), nutzlast({ nbf: jetzt + 120 }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('nimmt ein Token an, dessen Beginn innerhalb der Toleranz liegt', async () => {
    const jetzt = Math.floor(Date.now() / 1000);
    const token = baueToken(kopf(), nutzlast({ nbf: jetzt + 30 }));

    await expect(pruefeToken(token)).resolves.toMatchObject({ kennung: OID });
  });

  it('weist ein Token ohne Ablauf ab', async () => {
    // Ohne exp liefe das Token nie ab — ein einmal entwendeter Schluessel auf
    // Dauer.
    const token = baueToken(kopf(), nutzlast({ exp: undefined }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });
});

describe('Berechtigung', () => {
  it('weist ab, wenn sie weder in scp noch in roles steht', async () => {
    const token = baueToken(
      kopf(),
      nutzlast({ scp: 'andere.berechtigung', roles: ['noch.eine'] }),
    );

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('weist ab, wenn beide Felder fehlen', async () => {
    const token = baueToken(kopf(), nutzlast({ scp: undefined }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('nimmt sie aus scp an, auch neben anderen Eintraegen', async () => {
    const token = baueToken(kopf(), nutzlast({ scp: `andere.berechtigung ${BERECHTIGUNG}` }));

    await expect(pruefeToken(token)).resolves.toMatchObject({ kennung: OID });
  });

  it('nimmt sie aus roles an, wenn scp fehlt', async () => {
    const token = baueToken(
      kopf(),
      nutzlast({ scp: undefined, roles: ['andere.berechtigung', BERECHTIGUNG] }),
    );

    await expect(pruefeToken(token)).resolves.toMatchObject({ kennung: OID });
  });
});

describe('Kennung der Person', () => {
  it('weist ein Token ohne oid ab', async () => {
    // Ohne oid gaebe es keine Kennung, die einen Namens- oder Adresswechsel
    // ueberlebt — jede Zuordnung haengt daran.
    const token = baueToken(kopf(), nutzlast({ oid: undefined }));

    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
  });

  it('nutzt den Anmeldenamen als Adresse, wenn email fehlt', async () => {
    const token = baueToken(kopf(), nutzlast({ email: undefined }));

    await expect(pruefeToken(token)).resolves.toMatchObject({
      anmeldename: 'anmeldung@example.com',
      email: 'anmeldung@example.com',
    });
  });
});

describe('verstuemmelte Token', () => {
  it('weist ein Token mit zwei Teilen ab', async () => {
    const [kopfTeil, nutzTeil] = baueToken().split('.');

    await expect(pruefeToken(`${kopfTeil}.${nutzTeil}`)).rejects.toThrow(AuthError);
  });

  it('weist ein Token mit vier Teilen ab', async () => {
    await expect(pruefeToken(`${baueToken()}.zusatz`)).rejects.toThrow(AuthError);
  });

  it('weist ein leeres Token ab', async () => {
    await expect(pruefeToken('')).rejects.toThrow(AuthError);
  });

  it('weist Abschnitte ab, die kein base64url sind', async () => {
    // Buffer.from ueberliest ungueltige Zeichen stillschweigend — ohne eigene
    // Pruefung kaeme hier irgendein Ergebnis heraus statt einer Ablehnung.
    await expect(pruefeToken('kein base64!.auch nicht!.erst recht nicht!')).rejects.toThrow(
      AuthError,
    );
  });

  it('laesst einen Signaturabschnitt mit fremden Zeichen nicht durchgehen', async () => {
    // Buffer.from wirft die ungueltigen Zeichen weg und erhaelt dieselben
    // Bytes — ohne eigene Zeichenpruefung waere ein und dieselbe Unterschrift
    // also in beliebig vielen Schreibweisen gueltig. Das macht ein Token
    // formbar und jede Wiedererkennung am Tokentext wertlos.
    await expect(pruefeToken(`${baueToken()}!!`)).rejects.toThrow(AuthError);
  });

  it('weist ein uebermaessig langes Token ab, ohne es zu dekodieren', async () => {
    await expect(pruefeToken('a'.repeat(20_000))).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });
});

describe('Bremse beim Nachladen des Schluesselsatzes', () => {
  it('holt bei unbekanntem kid hoechstens alle fuenf Minuten neu', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));

    // Der erste gueltige Aufruf fuellt den Speicher.
    await expect(pruefeToken(baueToken())).resolves.toMatchObject({ kennung: OID });
    expect(abrufe).toBe(1);

    // Unbekanntes kid innerhalb der Bremse: kein weiterer Abruf.
    const unbekannt = baueToken(kopf({ kid: FREMDES_KID }));
    await expect(pruefeToken(unbekannt)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(1);

    // Nach fuenf Minuten genau ein weiterer Abruf — und danach wieder keiner.
    vi.advanceTimersByTime(BREMSE_IN_MS + 1000);
    await expect(pruefeToken(unbekannt)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(2);

    await expect(pruefeToken(unbekannt)).rejects.toThrow(AuthError);
    await expect(pruefeToken(unbekannt)).rejects.toThrow(AuthError);
    expect(abrufe).toBe(2);
  });

  it('weist ein gueltiges Token ab, wenn der Schluesselsatz nicht erreichbar ist', async () => {
    antwort = () => new Response('kaputt', { status: 500 });

    await expect(pruefeToken(baueToken())).rejects.toThrow(AuthError);
  });

  it('holt den Schluesselsatz nie ueber Klartext', async () => {
    process.env.ENTRA_JWKS_URL = 'http://schluessel.example.com/keys';
    resetConfigCache();

    await expect(pruefeToken(baueToken())).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });
});


describe('ohne Konfiguration', () => {
  beforeEach(() => {
    delete process.env.ENTRA_ISSUER;
    delete process.env.ENTRA_AUDIENCE;
    resetConfigCache();
  });

  it('meldet den Weg als nicht eingerichtet', () => {
    expect(entraEingerichtet()).toBe(false);
  });

  it('weist jedes Token ab', async () => {
    await expect(pruefeToken(baueToken())).rejects.toThrow(AuthError);
    expect(abrufe).toBe(0);
  });
});

describe('Auskunft nach aussen', () => {
  it('nennt nie, welche Pruefung gescheitert ist', async () => {
    const gruende = [
      baueToken(kopf(), nutzlast({ iss: 'https://login.example.com/fremd/v2.0' })),
      baueToken(kopf(), nutzlast({ aud: 'api://ein-anderer-dienst' })),
      baueToken(kopf(), nutzlast({ exp: Math.floor(Date.now() / 1000) - 600 })),
      baueToken(kopf(), nutzlast({ scp: 'andere.berechtigung' })),
    ];

    const meldungen: string[] = [];
    for (const token of gruende) {
      await expect(pruefeToken(token)).rejects.toThrow(AuthError);
      const fehler = await pruefeToken(token).catch((wert: unknown) => wert as AuthError);
      meldungen.push((fehler as AuthError).message);
    }

    expect(new Set(meldungen).size).toBe(1);
    expect(meldungen[0]).toContain('ungültig');
  });

  it('bringt kein Tokenmaterial ins Protokoll', async () => {
    const token = baueToken(kopf(), nutzlast({ iss: 'https://login.example.com/fremd/v2.0' }));
    await expect(pruefeToken(token)).rejects.toThrow(AuthError);
    await expect(pruefeToken('kein base64!.auch nicht!.!')).rejects.toThrow(AuthError);

    const geschrieben = JSON.stringify(protokoll);
    expect(protokoll.length).toBeGreaterThan(0);
    for (const teil of token.split('.')) {
      expect(geschrieben).not.toContain(teil);
    }
  });
});
