import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Anmeldung ueber den Firmenzugang, soweit sie ohne Netz und ohne Datenbank
 * pruefbar ist: die Weiche zwischen Token und Zugangsschluessel, und die Form
 * des Entdeckungsdokuments.
 *
 * Beides sind die Stellen, an denen ein Fehler still bleibt. Raet die Weiche
 * falsch, landet ein Zugangsschluessel in der Tokenpruefung und ein bisher
 * funktionierender Client faellt aus. Stimmt das Entdeckungsdokument nicht,
 * sucht ein Client den Anmeldedienst an der falschen Stelle — und die
 * Fehlermeldung entsteht dann in Open WebUI, nicht hier.
 */

const zustand = vi.hoisted(() => ({ eingerichtet: false }));

// Der Firmenzugang selbst wird hier nicht geprueft; er braucht Netz und liegt
// in src/auth/entra.ts. Gebraucht wird nur seine Auskunft, ob er eingerichtet
// ist — genau daran haengt, ob es das Entdeckungsdokument ueberhaupt gibt.
vi.mock('../src/auth/entra.js', () => ({
  entraEingerichtet: () => zustand.eingerichtet,
  pruefeToken: () =>
    Promise.reject(new Error('Die Tokenpruefung gehoert nicht in diesen Test.')),
}));

const { registriereEntdeckung } = await import('../src/server.js');
const { siehtNachTokenAus } = await import('../src/mcp/http-route.js');
const { resetConfigCache } = await import('../src/shared/config.js');

/**
 * Eine gerade ausreichende Umgebung. Die Werte sind erfunden und muessen es
 * bleiben: echte Adressen oder Schluessel haben in einem Test nichts verloren.
 */
const UMGEBUNG: Record<string, string> = {
  DATABASE_URL: 'postgres://dienst:geheim@datenbank.example.com:5432/test',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SESSION_SECRET: Buffer.alloc(32, 9).toString('base64'),
  PUBLIC_BASE_URL: 'https://mcp.example.com',
  ENTRA_ISSUER: 'https://anmeldung.example.com/mandant/v2.0',
  ENTRA_AUDIENCE: 'api://jama-mcp',
  ENTRA_SCOPE: 'mcp.use',
};

const gesichert = new Map<string, string | undefined>();

beforeEach(() => {
  for (const [name, wert] of Object.entries(UMGEBUNG)) {
    gesichert.set(name, process.env[name]);
    process.env[name] = wert;
  }
  resetConfigCache();
});

afterEach(() => {
  for (const [name, wert] of gesichert) {
    if (wert === undefined) delete process.env[name];
    else process.env[name] = wert;
  }
  gesichert.clear();
  resetConfigCache();
  zustand.eingerichtet = false;
});

async function frageEntdeckungAb() {
  const app = Fastify({ logger: false });
  registriereEntdeckung(app);

  const antwort = await app.inject({
    method: 'GET',
    url: '/.well-known/oauth-protected-resource',
  });

  await app.close();
  return antwort;
}

describe('Form des vorgelegten Bearer-Werts', () => {
  it('erkennt ein Token an drei Teilen mit "eyJ" am Anfang', () => {
    // Der erste Teil eines Tokens ist base64url-kodiertes JSON und beginnt
    // deshalb immer mit "eyJ".
    expect(siehtNachTokenAus('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXI')).toBe(true);
  });

  it('haelt zwei Teile nicht fuer ein Token', () => {
    expect(siehtNachTokenAus('eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0')).toBe(false);
  });

  it('haelt einen Zugangsschluessel dieses Dienstes nicht fuer ein Token', () => {
    // Form aus src/shared/crypto.ts: jama_mcp_<12 Hexzeichen>_<Geheimnis>.
    // Er enthaelt keine Punkte und kann damit nie als Token durchgehen.
    expect(siehtNachTokenAus('jama_mcp_0123456789ab_Ab-cdefghijklmnopqrstuvwxyz0123456789_XyZ')).toBe(
      false,
    );
  });

  it('haelt einen leeren Wert nicht fuer ein Token', () => {
    expect(siehtNachTokenAus('')).toBe(false);
  });

  it('haelt drei Teile ohne "eyJ" nicht fuer ein Token', () => {
    expect(siehtNachTokenAus('abc.def.ghi')).toBe(false);
  });

  it('haelt einen Wert mit Leerzeichen nicht fuer ein Token', () => {
    // Leerraum kommt in base64url nicht vor. Wer hier grosszuegig waere,
    // reichte eine falsch zusammengesetzte Kopfzeile an die Tokenpruefung
    // weiter, statt sie als das zu behandeln, was sie ist.
    expect(siehtNachTokenAus('eyJhbGciOiJSUzI1NiJ9. eyJzdWIiOiIxIn0.c2ln')).toBe(false);
    expect(siehtNachTokenAus('Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln')).toBe(false);
  });
});

describe('Entdeckungsdokument', () => {
  it('antwortet mit 404, solange der Firmenzugang nicht eingerichtet ist', async () => {
    zustand.eingerichtet = false;

    const antwort = await frageEntdeckungAb();

    // Ein Dokument, das auf einen leeren Aussteller verweist, schickt Clients
    // in eine Anmeldung, die es nicht gibt.
    expect(antwort.statusCode).toBe(404);
  });

  it('nennt Ressource, Anmeldedienst und Berechtigung', async () => {
    zustand.eingerichtet = true;

    const antwort = await frageEntdeckungAb();

    expect(antwort.statusCode).toBe(200);
    expect(antwort.json()).toEqual({
      resource: UMGEBUNG.ENTRA_AUDIENCE,
      authorization_servers: [UMGEBUNG.ENTRA_ISSUER],
      scopes_supported: [UMGEBUNG.ENTRA_SCOPE],
      bearer_methods_supported: ['header'],
    });
  });

  it('verlangt keine Anmeldung', async () => {
    zustand.eingerichtet = true;

    // Ohne Authorization-Kopfzeile abgefragt: Erst hier erfaehrt ein Client,
    // wo er ein Token bekommt. Eine Anmeldung zu verlangen, machte die
    // Entdeckung unmoeglich.
    const antwort = await frageEntdeckungAb();

    expect(antwort.statusCode).toBe(200);
  });
});
