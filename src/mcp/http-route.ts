import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';
import {
  buildToolContext,
  markKeyUsed,
  resolveApiKey,
  ruesteZugangAus,
  type ResolvedKey,
} from '../service/keys.js';
import { recordAudit, recordUsage } from '../service/usage.js';
import { AuthError, toServiceError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { aufruferAusAnfrage, aufruferText, type Aufrufer } from './aufrufer.js';
import { findeJamaBenutzerId, ladeZuordnung } from '../service/personen.js';
import { entraEingerichtet, pruefeToken } from '../auth/entra.js';
import { getDb } from '../db/client.js';
import { apiKeys, type ApiKey } from '../db/schema.js';
import { getConfig } from '../shared/config.js';
import type { Personenlage, Rechtelage } from './rechte.js';

/**
 * MCP ueber Streamable HTTP.
 *
 * Bewusst zustandslos: pro Anfrage wird ein frischer Server samt Transport
 * aufgebaut. Das kostet wenig und bringt zwei Dinge, die hier schwerer wiegen
 * als eingesparte Millisekunden — der Dienst laesst sich ohne Sitzungsspeicher
 * betreiben, und jede Anfrage traegt die aktuellen Rechte des Keys, sodass eine
 * Sperrung oder Rechteaenderung sofort greift statt erst beim naechsten
 * Verbindungsaufbau.
 *
 * Hier liegt ausserdem die Anmeldung. Es gibt genau zwei Wege herein, und beide
 * muenden in dieselbe Rechtelage:
 *
 *   1. Zugangsschluessel dieses Dienstes — wie bisher. Dienstkonten, der
 *      Einzelplatzbetrieb und Clients ohne OAuth brauchen ihn weiterhin.
 *   2. Token aus dem Firmenzugang — die Person ist damit nachgewiesen statt
 *      behauptet. Siehe docs/ERWEITERUNG-ANMELDUNG.md.
 */

/** Lage einer Person, die nicht zugeordnet werden konnte. */
const UNBEKANNTE_PERSON: Personenlage = {
  aktiv: true,
  erkannt: false,
  grundstufe: 'keine',
  lesen: [],
  schreiben: [],
};

/**
 * Baut die Rechtelage fuer genau diese Anfrage.
 *
 * Sperrliste und Schalter kommen aus dem Zugang, die Person aus den Kopfzeilen
 * des Aufrufs. Das Nachschlagen selbst steht bewusst nicht hier, sondern in
 * src/service/personen.ts: Diese Datei verdrahtet, sie kennt keine Tabellen.
 *
 * Ist die Matrix fuer den Zugang nicht eingeschaltet, wird gar nicht erst
 * nachgeschlagen. Zugaenge, die die Matrix nicht nutzen, bezahlen sie sonst mit
 * zwei zusaetzlichen Datenbankabfragen je Werkzeugaufruf.
 */
async function baueRechtelage(
  resolved: ResolvedKey,
  basis: { allowedProjectIds: number[]; readOnly: boolean },
  aufrufer: Aufrufer | undefined,
  nachgewiesen: number | undefined,
): Promise<Rechtelage> {
  const lage: Rechtelage = {
    gesperrteProjektIds: resolved.key.gesperrteProjektIds ?? [],
    allowedProjectIds: basis.allowedProjectIds,
    readOnly: basis.readOnly,
    person: { aktiv: false, erkannt: false, grundstufe: 'keine', lesen: [], schreiben: [] },
    // Vorgabe "nur_lesen", weil die Benutzer-Kopfzeilen nicht von jedem Client
    // ankommen (siehe src/mcp/aufrufer.ts). Mit "ablehnen" wuerde das
    // Scharfschalten der Matrix den laufenden Betrieb lahmlegen.
    beiUnbekannt: 'nur_lesen',
  };

  if (!resolved.key.personenrechteAktiv) return lage;

  try {
    // Steht die Nummer aus dem Firmenzugang bereits fest, wird sie genommen:
    // Sie stammt aus einem geprueften Token und ist damit belegt. Ein zweites
    // Nachschlagen ueber Kopfzeilen koennte sie nur noch verschlechtern.
    //
    // Sonst bleiben die Kopfzeilenwerte. Schickt der Client statt des
    // Anmeldenamens einen Anzeigenamen, findet der Abgleich schlicht nichts —
    // die Person gilt dann als unbekannt und darf hoechstens lesen. Das ist der
    // gewuenschte Ausgang; geraten wird an dieser Stelle nicht.
    const jamaUserId =
      nachgewiesen ??
      (await findeJamaBenutzerId({
        email: aufrufer?.email,
        anmeldename: aufrufer?.name,
      }));
    if (jamaUserId === null) return { ...lage, person: UNBEKANNTE_PERSON };

    const zuordnung = await ladeZuordnung(jamaUserId);
    return {
      ...lage,
      person: {
        aktiv: true,
        erkannt: true,
        grundstufe: zuordnung.grundstufe,
        lesen: zuordnung.lesen,
        schreiben: zuordnung.schreiben,
      },
    };
  } catch (error) {
    // Faellt das Nachschlagen aus, gilt die Person als unbekannt. Das ist die
    // engere Auslegung: Lesen im Rahmen der Zugangsfreigabe bleibt moeglich,
    // Aenderungen sind gesperrt. Die Alternative — die Anfrage scheitern zu
    // lassen — wuerde eine Stoerung der Datenbank zu einem Ausfall der ganzen
    // Anbindung machen.
    logger.warn(
      { err: error, apiKeyId: resolved.key.id },
      'Personenzuordnung nicht ermittelbar — Aufruf gilt als nicht zugeordnet',
    );
    return { ...lage, person: UNBEKANNTE_PERSON };
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? header.trim();
}

/** Kopfzeile, mit der ein per Token angemeldeter Aufruf seinen Zugang benennt. */
const ZUGANG_KOPFZEILE = 'x-jama-zugang';

/**
 * Eine einzige Meldung fuer jeden Fall, in dem der Zugang unklar bleibt.
 *
 * Sie nennt weder die vorhandenen Zugaenge noch, ob ein genanntes Praefix
 * existiert. Beides waere eine Auskunft ueber den Zuschnitt der Anlage an
 * jemanden, der hier noch gar keinen Zugang hat — und ein Unterschied in der
 * Antwort waere ein Weg, vorhandene Zugaenge abzuklopfen.
 *
 * Abgelehnt wird mit 403 und nicht mit 401: Das Token war in Ordnung, es fehlt
 * die Wahl des Zugangs. Ein 401 wuerde den Client in eine neue Anmeldung
 * schicken, die an derselben Stelle wieder endet — eine Schleife statt einer
 * Meldung, die jemand liest.
 */
const ZUGANG_UNKLAR =
  'Der Zugang ließ sich nicht bestimmen. Ein Token weist die Person nach, nicht den Zugang — gib ihn in der Kopfzeile "X-Jama-Zugang" an.';

/**
 * Unterscheidet ein Token des Firmenzugangs von einem Zugangsschluessel dieses
 * Dienstes.
 *
 * Entschieden wird an der Form: Ein Token besteht aus drei durch Punkte
 * getrennten Teilen, und sein erster Teil ist ein base64url-kodiertes
 * JSON-Objekt, das deshalb immer mit "eyJ" beginnt. Ein Zugangsschluessel
 * dieses Dienstes hat die Form jama_mcp_<praefix>_<geheimnis> und enthaelt
 * weder Punkte noch diesen Anfang.
 *
 * Raten ist hier zulaessig, weil beide Wege anschliessend vollstaendig
 * geprueft werden: das Token gegen Signatur, Aussteller, Empfaenger und
 * Laufzeit, der Schluessel gegen seinen gespeicherten Hash. Ein falsch
 * geratener Weg endet deshalb in einer Ablehnung, nie in einem Zugang.
 *
 * Exportiert, damit diese Weiche ohne Netz und ohne Datenbank pruefbar bleibt
 * (tests/entdeckung.test.ts).
 */
export function siehtNachTokenAus(wert: string): boolean {
  // Leerraum kommt in base64url nicht vor. Ein Wert mit Leerzeichen ist kein
  // Token, sondern eine falsch zusammengesetzte Kopfzeile.
  if (/\s/.test(wert)) return false;

  const teile = wert.split('.');
  if (teile.length !== 3) return false;
  return teile[0]?.startsWith('eyJ') === true;
}

/**
 * Verweist auf das Entdeckungsdokument nach RFC 9728.
 *
 * Ohne diesen Kopf findet ein Client den Anmeldedienst nie: Er ist der
 * Einstieg in die ganze Kette und keine Hoeflichkeit. Das Dokument selbst
 * liegt in src/server.ts.
 */
function hinweisAufAnmeldung(): string {
  const basis = getConfig().PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `Bearer resource_metadata="${basis}/.well-known/oauth-protected-resource"`;
}

/**
 * Liest das Zugangspraefix aus der Kopfzeile.
 *
 * Die Form wird geprueft, bevor gesucht wird: Ein Praefix besteht aus zwoelf
 * hexadezimalen Zeichen (siehe generateApiKey in src/shared/crypto.ts).
 *
 * Eine gesetzte, aber unbrauchbare Kopfzeile wird abgelehnt statt uebergangen.
 * Auf die Regel "es gibt nur einen Zugang" auszuweichen hiesse, die
 * ausdrueckliche Wahl des Aufrufs stillschweigend durch eine andere zu
 * ersetzen — genau das Raten, das hier nicht stattfinden soll.
 */
function zugangPraefix(request: FastifyRequest): string | undefined {
  const roh = request.headers[ZUGANG_KOPFZEILE];
  const wert = Array.isArray(roh) ? roh[0] : roh;
  if (wert === undefined) return undefined;

  const sauber = wert.trim().toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(sauber)) throw new AuthError('AUTH_INVALID', ZUGANG_UNKLAR, 403);
  return sauber;
}

/**
 * Waehlt den Zugang, unter dem ein per Token angemeldeter Aufruf laeuft.
 *
 * Ein Token sagt, wer fragt, nicht ueber welchen Zugang. Deshalb wird hier
 * nicht geraten: Entweder benennt der Aufruf den Zugang selbst, oder es gibt
 * genau einen mit eingeschalteter Personenmatrix. Trifft beides nicht zu, wird
 * abgelehnt. Ein beliebig gewaehlter Zugang braechte fremde Jama-Zugangsdaten
 * und eine fremde Projektfreigabe mit — die Mandantengrenze haengt daran.
 *
 * Deaktivierte Zugaenge bleiben bei der Zaehlung aussen vor. Sonst koennte ein
 * laengst abgeschalteter Zugang die Regel "genau einer" kippen und damit einen
 * laufenden Betrieb lahmlegen.
 */
async function waehleZugang(praefix: string | undefined): Promise<ApiKey> {
  const db = getDb();

  if (praefix !== undefined) {
    const zeilen = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, praefix))
      .limit(1);
    const zugang = zeilen[0];
    if (!zugang) throw new AuthError('AUTH_INVALID', ZUGANG_UNKLAR, 403);
    return pruefeZugangNutzbar(zugang);
  }

  // Bewusst ohne Obergrenze: Die Tabelle der Zugaenge ist klein, und eine
  // Grenze koennte die Zaehlung verfaelschen, sobald abgelaufene Eintraege
  // dazwischenliegen.
  const kandidaten = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.personenrechteAktiv, true), isNull(apiKeys.disabledAt)));

  const nutzbar = kandidaten.filter((zugang) => !istAbgelaufen(zugang));
  const einziger = nutzbar.length === 1 ? nutzbar[0] : undefined;
  if (!einziger) throw new AuthError('AUTH_INVALID', ZUGANG_UNKLAR, 403);
  return einziger;
}

function istAbgelaufen(zugang: ApiKey): boolean {
  return zugang.expiresAt !== null && zugang.expiresAt.getTime() <= Date.now();
}

/**
 * Dieselben Schranken wie beim Zugangsschluessel.
 *
 * Wer den Zugang ausdruecklich benennt, bekommt hier den konkreten Grund. Das
 * ist keine Auskunft an Unbekannte: Die Person hat sich ueber den
 * Firmenzugang bereits nachgewiesen und den Zugang selbst genannt.
 */
function pruefeZugangNutzbar(zugang: ApiKey): ApiKey {
  if (zugang.disabledAt) {
    throw new AuthError('AUTH_DISABLED', 'Dieser Zugang wurde deaktiviert.', 403);
  }
  if (istAbgelaufen(zugang)) {
    throw new AuthError(
      'AUTH_EXPIRED',
      `Dieser Zugang ist am ${zugang.expiresAt?.toISOString().slice(0, 10)} abgelaufen.`,
      403,
    );
  }
  return zugang;
}


/** Was eine Anfrage nach der Anmeldung mitbringt. */
interface Anmeldung {
  resolved: ResolvedKey;
  aufrufer: Aufrufer | undefined;
  /** Ueber den Firmenzugang nachgewiesene Jama-Benutzernummer. */
  nachgewiesen?: number;
}

/**
 * Der Weg ueber den Firmenzugang.
 *
 * Reihenfolge mit Absicht: erst das Token, dann die Person, dann der Zugang.
 * Wer einen Zugang waehlen darf, muss vorher nachgewiesen haben, wer er ist.
 */
async function meldeUeberFirmenzugang(
  token: string,
  request: FastifyRequest,
): Promise<Anmeldung> {
  const person = await pruefeToken(token);

  const jamaUserId = await findeJamaBenutzerId({
    email: person.email,
    anmeldename: person.anmeldename,
  });

  // Ein gueltiges Token ohne Entsprechung in Jama faellt ausdruecklich NICHT
  // auf die Behandlung fuer Unbekannte zurueck. Sonst waere die Anmeldung eine
  // Verschlechterung gegenueber gar keiner: Wer sich nachweislich angemeldet
  // hat, bekaeme dieselbe Stufe wie ein voellig anonymer Aufruf.
  if (jamaUserId === null) {
    throw new AuthError(
      'AUTH_INVALID',
      'Die Anmeldung hat geklappt, aber zu diesem Konto gibt es in Jama keine Entsprechung. Vor dem Zugriff ist ein Abgleich der Jama-Benutzer nötig.',
      403,
    );
  }

  const zugang = await waehleZugang(zugangPraefix(request));

  return {
    resolved: await ruesteZugangAus(zugang),
    // Die nachgewiesene Identitaet schlaegt die Kopfzeilen: Was im Token
    // steht, ist belegt — was in einer Kopfzeile steht, ist behauptet.
    aufrufer: {
      name: person.name ?? person.anmeldename,
      email: person.email,
      id: person.kennung,
    },
    nachgewiesen: jamaUserId,
  };
}

/**
 * Die Weiche zwischen beiden Anmeldearten.
 *
 * Ist der Firmenzugang nicht eingerichtet, bleibt alles wie bisher: Ein
 * tokenfoermiger Wert laeuft dann in die Pruefung des Zugangsschluessels und
 * wird dort als ungueltig abgewiesen.
 */
async function melde(request: FastifyRequest): Promise<Anmeldung> {
  const vorgelegt = bearerToken(request);

  if (vorgelegt !== undefined && entraEingerichtet() && siehtNachTokenAus(vorgelegt)) {
    return meldeUeberFirmenzugang(vorgelegt, request);
  }

  return {
    resolved: await resolveApiKey(vorgelegt),
    aufrufer: aufruferAusAnfrage(request),
  };
}

export function registerMcpRoute(app: FastifyInstance): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    let anmeldung: Anmeldung;
    try {
      anmeldung = await melde(request);
    } catch (error) {
      const serviceError = toServiceError(error);
      // Bewusst nur Code und Adresse: Weder das Token noch eine Kopfzeile
      // gehoert ins Protokoll, auch nicht gekuerzt.
      logger.warn({ code: serviceError.code, ip: request.ip }, 'MCP-Zugriff abgelehnt');

      // Der Verweis auf das Entdeckungsdokument ist der Einstieg in die
      // Anmeldung — ohne ihn findet ein Client den Anmeldedienst nie. Nur
      // gesetzt, wenn der Firmenzugang eingerichtet ist: sonst zeigte der Kopf
      // auf ein Dokument, das dieser Dienst selbst mit 404 beantwortet, und
      // schickte den Client in eine Anmeldung, die es nicht gibt.
      if (entraEingerichtet()) {
        reply.header('www-authenticate', hinweisAufAnmeldung());
      }

      // Die Antwort folgt der JSON-RPC-Form, damit MCP-Clients sie auswerten
      // koennen, statt an einem nackten HTTP-Fehler zu scheitern.
      return reply.status(serviceError.httpStatus).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: serviceError.message, data: { code: serviceError.code } },
        id: null,
      });
    }

    const { resolved, aufrufer } = anmeldung;
    const basis = await buildToolContext(resolved);
    const context = {
      ...basis,
      aufrufer,
      rechte: await baueRechtelage(resolved, basis, aufrufer, anmeldung.nachgewiesen),
    };
    const keyInfo = { id: resolved.key.id, name: resolved.key.name };

    const server = buildMcpServer(context, {
      onInvocation: (record) => {
        void recordUsage(record, keyInfo);
      },
      onAudit: (entry) => {
        void recordAudit(entry, {
          type: 'api_key',
          id: resolved.key.id,
          // Ist die Person bekannt, steht sie im Audit-Log an erster Stelle:
          // Der Zugang allein beantwortet die Frage "wer war das" nicht, sobald
          // sich mehrere Menschen einen Key teilen.
          name: aufrufer
            ? `${aufruferText(aufrufer)} (ueber ${resolved.key.name})`
            : resolved.key.name,
          ip: request.ip,
        });
      },
    });

    void markKeyUsed(resolved.key.id);

    const transport = new StreamableHTTPServerTransport({
      // Zustandslos: keine Sitzungs-IDs, keine serverseitige Sitzungsverwaltung.
      sessionIdGenerator: undefined,
    });

    // Ab hier schreibt der Transport direkt auf die Node-Antwort; Fastify darf
    // sie nicht mehr anfassen.
    reply.hijack();

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      logger.error({ err: error }, 'Fehler beim Verarbeiten einer MCP-Anfrage');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Interner Fehler bei der Verarbeitung.' },
            id: null,
          }),
        );
      }
    }
  };

  // Streamable HTTP nutzt POST fuer Aufrufe, GET fuer den Ereignisstrom und
  // DELETE zum Beenden einer Sitzung.
  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
