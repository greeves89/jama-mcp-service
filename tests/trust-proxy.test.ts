import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

/**
 * Ermittlung der Client-Adresse hinter einem Reverse-Proxy.
 *
 * Die Anmeldesperre des Dashboards zaehlt Fehlversuche pro Adresse. Stammt
 * diese Adresse aus einem Header, den der Client selbst mitschicken kann, ist
 * die Sperre wertlos: Ein Angreifer denkt sich fuer jeden Rateversuch eine neue
 * Adresse aus und raet die PIN unbegrenzt weiter.
 *
 * Genau das passierte mit trustProxy: true. Fastify vertraut dann der ganzen
 * Kette und nimmt deren linkesten Eintrag — und links steht, was der Client
 * geschickt hat. Mit einer festen Anzahl eigener Proxys zaehlt Fastify von
 * rechts und nimmt nur, was diese Proxys selbst angehaengt haben.
 */

const ECHTE_ADRESSE = '203.0.113.9';
const ERFUNDENE_ADRESSE = '6.6.6.6';
const PROXY = '172.18.0.5';

async function ermittelteAdresse(
  trustProxy: boolean | ((adresse: string, sprung: number) => boolean),
  weitergeleitet: string,
): Promise<string> {
  const app = Fastify({ trustProxy });
  app.get('/', async (request) => ({ ip: request.ip }));

  const antwort = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'x-forwarded-for': weitergeleitet },
    remoteAddress: PROXY,
  });

  await app.close();
  return (antwort.json() as { ip: string }).ip;
}

// Ein Proxy davor — der Normalfall dieses Dienstes.
const einProxy = (_adresse: string, sprung: number) => sprung < 1;

describe('Client-Adresse hinter dem Reverse-Proxy', () => {
  it('faellt bei trustProxy: true auf einen gefaelschten Header herein', async () => {
    // Der Client schickt eine erfundene Adresse, der Proxy haengt die echte an.
    const kette = `${ERFUNDENE_ADRESSE}, ${ECHTE_ADRESSE}`;

    // Dokumentiert das alte Verhalten: die Erfindung des Angreifers gewinnt.
    expect(await ermittelteAdresse(true, kette)).toBe(ERFUNDENE_ADRESSE);
  });

  it('nimmt mit fester Proxy-Anzahl die echte Adresse', async () => {
    const kette = `${ERFUNDENE_ADRESSE}, ${ECHTE_ADRESSE}`;

    // Der vorangestellte Wert wird ignoriert; gezaehlt wird von rechts.
    expect(await ermittelteAdresse(einProxy, kette)).toBe(ECHTE_ADRESSE);
  });

  it('liefert dieselbe Adresse, egal wie viel der Angreifer voranstellt', async () => {
    // Sonst genuegte eine laengere Kette, um die Sperre wieder auszuhebeln.
    const kurz = await ermittelteAdresse(einProxy, `1.1.1.1, ${ECHTE_ADRESSE}`);
    const lang = await ermittelteAdresse(
      einProxy,
      `1.1.1.1, 2.2.2.2, 3.3.3.3, 4.4.4.4, ${ECHTE_ADRESSE}`,
    );

    expect(kurz).toBe(ECHTE_ADRESSE);
    expect(lang).toBe(ECHTE_ADRESSE);
  });

  it('verwirft eine blosse Zahl, statt sie als Anzahl zu deuten', async () => {
    // Die naheliegende "Vereinfachung" trustProxy: 1 waere ein stiller Ausfall.
    // Fastify wertet eine Zahl nicht als Hop-Zaehler aus, sondern traut dann
    // gar keinem Eintrag mehr: request.ip liefert immer die Adresse des Proxys.
    // Alle Anwender landeten damit in einem gemeinsamen Sperr-Topf, und ein
    // einziger Fehlversuch sperrte saemtliche Admins aus.
    const app = Fastify({ trustProxy: 1 as unknown as boolean });
    app.get('/', async (request) => ({ ip: request.ip }));
    const antwort = await app.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-forwarded-for': ECHTE_ADRESSE },
      remoteAddress: PROXY,
    });
    await app.close();

    expect((antwort.json() as { ip: string }).ip).toBe(PROXY);
    // Die Funktionsform liefert an derselben Stelle die richtige Adresse.
    expect(await ermittelteAdresse(einProxy, ECHTE_ADRESSE)).toBe(ECHTE_ADRESSE);
  });

  it('nimmt ohne weitergeleiteten Header die Adresse der Verbindung', async () => {
    const app = Fastify({ trustProxy: einProxy });
    app.get('/', async (request) => ({ ip: request.ip }));
    const antwort = await app.inject({ method: 'GET', url: '/', remoteAddress: PROXY });
    await app.close();

    expect((antwort.json() as { ip: string }).ip).toBe(PROXY);
  });
});
