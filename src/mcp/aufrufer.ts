import type { FastifyRequest } from 'fastify';

/**
 * Wer den Aufruf ausgeloest hat — die Person vor dem Chatfenster.
 *
 * Der API-Key benennt nur den Zugang, nicht den Menschen. Teilen sich mehrere
 * Personen einen Zugang, ist ohne diese Angabe nicht mehr feststellbar, wer
 * eine Aenderung in Jama veranlasst hat.
 */
export interface Aufrufer {
  name?: string;
  email?: string;
  id?: string;
  rolle?: string;
}

/**
 * Kopfzeilen, aus denen die Identitaet gelesen wird.
 *
 * Open WebUI sendet die erste Gruppe, sobald ENABLE_FORWARD_USER_INFO_HEADERS
 * gesetzt ist. Zum Zeitpunkt dieser Zeilen reicht es sie allerdings nur an
 * OpenAI-kompatible Endpunkte weiter, noch nicht an MCP-Server ueber Streamable
 * HTTP (open-webui Nr. 21184). Die Auswertung steht trotzdem hier: Sie kostet
 * nichts, greift automatisch sobald das nachgezogen wird, und andere Clients
 * sowie vorgelagerte Proxys setzen die uebrigen Varianten schon heute.
 *
 * Die Reihenfolge entscheidet: Die erste besetzte Kopfzeile gewinnt.
 */
const KOPFZEILEN = {
  name: ['x-openwebui-user-name', 'x-user-name', 'x-forwarded-user', 'x-remote-user'],
  email: ['x-openwebui-user-email', 'x-user-email', 'x-forwarded-email'],
  id: ['x-openwebui-user-id', 'x-user-id'],
  rolle: ['x-openwebui-user-role', 'x-user-role'],
} as const;

/**
 * Begrenzt, was aus einer Kopfzeile uebernommen wird.
 *
 * Kopfzeilen stammen von aussen. Steuerzeichen koennten ein Logformat
 * zerreissen oder in einem Jama-Kommentar Unfug anrichten; die Laenge wird
 * begrenzt, damit niemand ueber eine Kopfzeile beliebig viel Text in fremde
 * Systeme schreibt.
 */
function saeubern(wert: string | string[] | undefined): string | undefined {
  const roh = Array.isArray(wert) ? wert[0] : wert;
  if (typeof roh !== 'string') return undefined;

  const sauber = [...roh]
    .map((zeichen) => {
      const code = zeichen.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : zeichen;
    })
    .join('')
    .trim()
    .slice(0, 120);

  return sauber.length > 0 ? sauber : undefined;
}

/**
 * Liest die Identitaet aus den Kopfzeilen einer Anfrage.
 *
 * Bewusst ohne Pruefung: Diese Angaben sind eine Auskunft des vorgelagerten
 * Clients, kein Nachweis. Sie taugen fuer die Nachvollziehbarkeit im
 * Normalbetrieb — als Berechtigungsgrundlage sind sie ungeeignet, denn wer den
 * API-Key besitzt, kann jeden beliebigen Namen behaupten. Die Rechte haengen
 * deshalb weiterhin ausschliesslich am Key.
 */
export function aufruferAusAnfrage(request: FastifyRequest): Aufrufer | undefined {
  const gefunden: Aufrufer = {};

  for (const [feld, kandidaten] of Object.entries(KOPFZEILEN)) {
    for (const kopfzeile of kandidaten) {
      const wert = saeubern(request.headers[kopfzeile]);
      if (wert !== undefined) {
        gefunden[feld as keyof Aufrufer] = wert;
        break;
      }
    }
  }

  return Object.keys(gefunden).length > 0 ? gefunden : undefined;
}

/**
 * Kurze Bezeichnung der Person fuer Protokolle und Kommentare.
 *
 * Ist nichts bekannt, wird das ausdruecklich gesagt statt eine Herkunft
 * vorzutaeuschen, die niemand belegen kann.
 */
export function aufruferText(aufrufer: Aufrufer | undefined): string {
  if (!aufrufer) return 'nicht uebermittelt';

  if (aufrufer.name && aufrufer.email) return `${aufrufer.name} <${aufrufer.email}>`;
  return aufrufer.name ?? aufrufer.email ?? aufrufer.id ?? 'nicht uebermittelt';
}
