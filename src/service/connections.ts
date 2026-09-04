import type { JamaCredentials } from '../jama/auth.js';

/**
 * Regeln fuer das Aendern einer Jama-Verbindung.
 *
 * Bewusst getrennt von der Route: hier steckt die Entscheidung, welche Felder
 * geschrieben werden und wann ein frueheres Testergebnis ungueltig wird. Diese
 * Regel laesst sich so ohne Datenbank und ohne Schluesselmaterial pruefen.
 */

export interface VerbindungsAenderung {
  name?: string;
  baseUrl?: string;
  isProduction?: boolean;
  rateLimitRps?: number | null;
  credentials?: JamaCredentials;
}

/**
 * Ein Testergebnis gilt immer nur fuer ein bestimmtes Ziel und bestimmte
 * Zugangsdaten. Aendert sich eines davon, sagt das alte Ergebnis nichts mehr
 * aus. Bliebe es stehen, zeigte die Uebersicht ein gruenes "ok" fuer eine
 * Verbindung, die in dieser Form nie geprueft wurde — und niemand kaeme auf
 * die Idee, nachzutesten.
 *
 * Name, Produktivkennzeichen und Anfragelimit beruehren die Erreichbarkeit
 * nicht und lassen das Ergebnis deshalb stehen.
 */
export function testergebnisWirdUngueltig(aenderung: VerbindungsAenderung): boolean {
  return aenderung.baseUrl !== undefined || aenderung.credentials !== undefined;
}

/**
 * Baut die zu schreibenden Spalten.
 *
 * Nur ausdruecklich uebergebene Felder landen im Ergebnis — ein weggelassenes
 * Feld bleibt unangetastet. Das ist die Grundlage dafuer, dass sich im
 * Dashboard der Name aendern laesst, ohne die Zugangsdaten erneut einzugeben:
 * Jama zeigt ein Client-Secret nur ein einziges Mal an, niemand hat es also
 * bei jeder Korrektur zur Hand.
 *
 * Das Verschluesseln wird hereingereicht, damit diese Funktion ohne
 * Schluesselmaterial auskommt und im Test nachvollziehbar bleibt.
 */
export function baueVerbindungsUpdate(
  aenderung: VerbindungsAenderung,
  verschluesseln: (credentials: JamaCredentials) => string,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};

  if (aenderung.name !== undefined) update.name = aenderung.name;
  // Ein abschliessender Schraegstrich fuehrt beim Zusammensetzen der Pfade zu
  // doppelten Trennern, die manche Server mit 404 beantworten.
  if (aenderung.baseUrl !== undefined) update.baseUrl = aenderung.baseUrl.replace(/\/+$/, '');
  if (aenderung.isProduction !== undefined) update.isProduction = aenderung.isProduction;
  if (aenderung.rateLimitRps !== undefined) update.rateLimitRps = aenderung.rateLimitRps;

  if (aenderung.credentials !== undefined) {
    update.credentialsEnc = verschluesseln(aenderung.credentials);
    update.authType = aenderung.credentials.type;
  }

  if (testergebnisWirdUngueltig(aenderung)) {
    update.healthStatus = 'unknown';
    update.healthMessage = 'Seit der letzten Änderung noch nicht geprüft.';
    update.lastHealthCheckAt = null;
  }

  return update;
}
