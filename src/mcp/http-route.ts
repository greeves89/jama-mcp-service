import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';
import { buildToolContext, markKeyUsed, resolveApiKey, type ResolvedKey } from '../service/keys.js';
import { recordAudit, recordUsage } from '../service/usage.js';
import { toServiceError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { aufruferAusAnfrage, aufruferText, type Aufrufer } from './aufrufer.js';
import { findeJamaBenutzerId, ladeZuordnung } from '../service/personen.js';
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
    // Beides sind Kopfzeilenwerte. Schickt der Client statt des Anmeldenamens
    // einen Anzeigenamen, findet der Abgleich schlicht nichts — die Person
    // gilt dann als unbekannt und darf hoechstens lesen. Das ist der
    // gewuenschte Ausgang; geraten wird an dieser Stelle nicht.
    const jamaUserId = await findeJamaBenutzerId({
      email: aufrufer?.email,
      anmeldename: aufrufer?.name,
    });
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

export function registerMcpRoute(app: FastifyInstance): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    let resolved;
    try {
      resolved = await resolveApiKey(bearerToken(request));
    } catch (error) {
      const serviceError = toServiceError(error);
      logger.warn({ code: serviceError.code, ip: request.ip }, 'MCP-Zugriff abgelehnt');

      // Die Antwort folgt der JSON-RPC-Form, damit MCP-Clients sie auswerten
      // koennen, statt an einem nackten HTTP-Fehler zu scheitern.
      return reply.status(serviceError.httpStatus).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: serviceError.message, data: { code: serviceError.code } },
        id: null,
      });
    }

    const aufrufer = aufruferAusAnfrage(request);
    const basis = await buildToolContext(resolved);
    const context = {
      ...basis,
      aufrufer,
      rechte: await baueRechtelage(resolved, basis, aufrufer),
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
