import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { getConfig } from '../shared/config.js';
import { AuthError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

/**
 * Pruefung von Token aus dem Firmenzugang (Entra ID).
 *
 * Dieser Dienst ist hier ausschliesslich geschuetzte Ressource: Er stellt
 * nichts aus, er prueft. Das ist der Unterschied zu src/mcp/aufrufer.ts, wo
 * Name und E-Mail aus Kopfzeilen gelesen werden — dort steht ausdruecklich,
 * dass diese Angaben eine Behauptung des Clients sind und deshalb keine Rechte
 * begruenden duerfen. Hier steht die Unterschrift des Ausstellers dahinter,
 * und erst damit wird aus einer Behauptung ein Nachweis.
 *
 * BEWUSST OHNE BIBLIOTHEK. node:crypto bringt fuer RS256 und JWKS alles mit,
 * was gebraucht wird. Eine zusaetzliche Abhaengigkeit an genau der Stelle, an
 * der ueber Zugang entschieden wird, waere das teuerste Lieferkettenrisiko des
 * ganzen Dienstes: Ein uebernommenes Paket koennte jede der folgenden
 * Pruefungen unbemerkt aufweichen, und niemand saehe es im eigenen Diff. Der
 * Preis sind rund zweihundert Zeilen Base64url, JSON und Vergleich, die hier
 * vollstaendig lesbar stehen und im Test einzeln nachgestellt werden.
 *
 * NIEMALS EIN TOKEN PROTOKOLLIEREN, auch nicht gekuerzt, auch nicht im
 * Fehlerfall: Ein Bearer-Token ist bis zu seinem Ablauf ein vollwertiger
 * Schluessel, und ein Logziel ist selten so gut geschuetzt wie ein Tresor.
 * Protokolliert wird ausschliesslich der Grund der Ablehnung.
 *
 * Nach aussen ist jede Ablehnung derselbe Satz. Ob Aussteller, Empfaenger,
 * Laufzeit oder Berechtigung nicht gestimmt hat, ist eine Auskunft, aus der
 * sich ein Token schrittweise passend machen liesse — sie gehoert ins
 * Serverprotokoll und sonst nirgendwohin.
 *
 * Die Reihenfolge der Pruefungen ist Teil der Sicherheit und darf nicht
 * umgestellt werden:
 *   1. Verfahren (nur RS256) — vor allem anderen.
 *   2. Signatur gegen den oeffentlichen Schluessel aus dem JWKS (ueber kid).
 *   3. Aussteller exakt.
 *   4. Empfaenger exakt, auch bei mehreren Werten.
 *   5. Laufzeit (exp, nbf) mit 60 Sekunden Toleranz.
 *   6. Berechtigung in scp oder roles.
 * Erst danach wird die Nutzlast als Aussage ueber eine Person gelesen.
 */

export interface Tokenperson {
  /** Unveraenderliche Kennung aus dem Firmenzugang (oid). */
  kennung: string;
  email?: string;
  anmeldename?: string;
  name?: string;
}

/** Eine Stunde. Entra wechselt Schluessel selten und kuendigt es nicht an. */
const SCHLUESSEL_TTL_MS = 60 * 60 * 1000;

/**
 * Mindestabstand zwischen zwei Abrufen des Schluesselsatzes.
 *
 * Ohne diese Bremse genuegt ein erfundenes kid, um bei jeder Anfrage einen
 * Abruf beim Aussteller auszuloesen. Das ist von aussen kostenlos und ohne
 * Anmeldung machbar — der Dienst wuerde sich auf Zuruf selbst und nebenbei den
 * Firmenzugang fluten. Der Preis ist gering: Nach einem echten
 * Schluesselwechsel dauert es hoechstens fuenf Minuten, bis der neue
 * Schluessel bekannt ist.
 */
const BREMSE_MS = 5 * 60 * 1000;

/** Zeitgrenze fuer den Abruf des Schluesselsatzes. */
const ABRUF_ZEITGRENZE_MS = 5000;

/** Toleranz fuer auseinanderlaufende Uhren, in Sekunden. */
const UHRTOLERANZ_S = 60;

/**
 * Obergrenze fuer die Tokenlaenge.
 *
 * Das Token kommt unangemeldet herein. Ohne Grenze wuerde der Dienst beliebig
 * viel fremden Text dekodieren und durch JSON.parse schicken, bevor die erste
 * Pruefung ueberhaupt greift. 16 KB liegen weit ueber jedem echten Entra-Token
 * und zugleich an der Grenze, die Node fuer Kopfzeilen ohnehin zieht.
 */
const MAX_TOKENLAENGE = 16 * 1024;

/** Ein Abschnitt eines Tokens ist base64url: keine Polster, kein Klartext. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Derselbe Satz fuer jede Ablehnung — der Grund bleibt im Protokoll. */
const ABLEHNUNGSTEXT = 'Das Token des Firmenzugangs ist ungültig. Bitte die Anmeldung erneuern.';

/**
 * Die Pflichtangaben in einer Form, die der Typpruefer eng fuehrt.
 *
 * Fehlt Aussteller oder Empfaenger, ist der Weg abgeschaltet — ein Dienst, der
 * nicht weiss, wem er glaubt, darf niemandem glauben.
 */
function pflichtangaben(): { aussteller: string; empfaenger: string; berechtigung: string } | undefined {
  const config = getConfig();
  if (!config.ENTRA_ISSUER || !config.ENTRA_AUDIENCE) return undefined;
  return {
    aussteller: config.ENTRA_ISSUER,
    empfaenger: config.ENTRA_AUDIENCE,
    berechtigung: config.ENTRA_SCOPE,
  };
}

export function entraEingerichtet(): boolean {
  return pflichtangaben() !== undefined;
}

/**
 * Speicher fuer die oeffentlichen Schluessel des Ausstellers.
 *
 * Der TtlCache aus src/jama/cache.ts deckt den Ablauf ab, aber nicht die zwei
 * Teile, auf die es hier sicherheitstechnisch ankommt: Die Bremse braucht
 * einen Zeitstempel, der unabhaengig vom Eintrag weiterlebt — gerade ein
 * FEHLGESCHLAGENER Abruf legt keinen Eintrag an und muesste sonst sofort
 * wiederholt werden duerfen. Und ein gleichzeitiger Ansturm muss zu genau
 * einem Abruf fuehren, was getOrLoad nicht zusichert. Deshalb hier ein kleiner
 * eigener Speicher statt einer aufgebohrten allgemeinen Abstraktion.
 */
interface Schluesselspeicher {
  schluessel: Map<string, KeyObject>;
  gueltigBis: number;
  letzterAbruf: number;
  laufend?: Promise<void>;
}

const speicher: Schluesselspeicher = {
  schluessel: new Map(),
  gueltigBis: 0,
  letzterAbruf: 0,
};

/** Nur fuer Tests: erzwingt einen frischen Abruf beim naechsten Aufruf. */
export function leereSchluesselspeicher(): void {
  speicher.schluessel = new Map();
  speicher.gueltigBis = 0;
  speicher.letzterAbruf = 0;
  speicher.laufend = undefined;
}

/**
 * Adresse des Schluesselsatzes.
 *
 * Abgeleitet wird direkt, nicht ueber das Entdeckungsdokument: Das spart bei
 * jedem Nachladen eine zweite Anfrage, und vor allem gibt es kein zweites
 * Dokument, dessen jwks_uri wir erst wieder gegen den Aussteller pruefen
 * muessten, bevor wir ihm folgen. Die Ableitung muss die Version abschneiden —
 * der Aussteller endet auf "/v2.0", der Schluesselsatz liegt eine Ebene
 * darueber unter "/discovery/v2.0/keys". Wer einen Aussteller mit anderem
 * Aufbau betreibt, setzt ENTRA_JWKS_URL; dafuer ist die Angabe da.
 */
function jwksAdresse(aussteller: string): string {
  const konfiguriert = getConfig().ENTRA_JWKS_URL;
  if (konfiguriert) return konfiguriert;

  const ohneSchraege = aussteller.replace(/\/+$/, '');
  const basis = ohneSchraege.endsWith('/v2.0')
    ? ohneSchraege.slice(0, ohneSchraege.length - '/v2.0'.length)
    : ohneSchraege;
  return `${basis}/discovery/v2.0/keys`;
}

/**
 * Liest den Schluesselsatz.
 *
 * Aufgenommen werden ausschliesslich RSA-Signaturschluessel. Ein symmetrischer
 * Eintrag im Satz waere die Vorlage fuer genau den Angriff, den die
 * Verfahrenspruefung verhindert; ein Verschluesselungsschluessel gehoert nicht
 * zur Unterschrift. Ein einzelner unbrauchbarer Eintrag entwertet den Satz
 * nicht — sonst legte ein kuenftiges Schluesselformat die Anmeldung still.
 */
function leseSchluesselsatz(daten: unknown): Map<string, KeyObject> {
  const gefunden = new Map<string, KeyObject>();
  const satz = (daten as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(satz)) return gefunden;

  for (const eintrag of satz) {
    if (typeof eintrag !== 'object' || eintrag === null) continue;
    const jwk = eintrag as JsonWebKey & { kid?: unknown };
    if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.kid.length === 0) continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;

    try {
      gefunden.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
    } catch (fehler) {
      // Die kid stammt hier aus der Antwort des Ausstellers, nicht aus dem
      // Token — sie darf deshalb ins Protokoll.
      logger.warn({ err: fehler, kid: jwk.kid }, 'Schluessel des Firmenzugangs nicht lesbar');
    }
  }

  return gefunden;
}

/** Holt den Schluesselsatz. Scheitert der Abruf, bleibt der alte Satz stehen. */
async function abrufen(adresse: string): Promise<void> {
  if (!adresse.startsWith('https://')) {
    // Ein Schluesselsatz ueber Klartext ist unterwegs austauschbar — damit
    // waere die ganze Signaturpruefung nur noch Theater.
    throw new Error('Der Schluesselsatz des Firmenzugangs muss ueber https geladen werden');
  }

  const antwort = await fetch(adresse, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(ABRUF_ZEITGRENZE_MS),
  });
  if (!antwort.ok) {
    throw new Error(`Schluesselsatz nicht abrufbar (HTTP ${antwort.status})`);
  }

  const neu = leseSchluesselsatz(await antwort.json());
  if (neu.size === 0) {
    throw new Error('Schluesselsatz enthaelt keinen verwendbaren RSA-Schluessel');
  }

  speicher.schluessel = neu;
  speicher.gueltigBis = Date.now() + SCHLUESSEL_TTL_MS;
}

/**
 * Abruf mit Bremse und ohne Doppelarbeit.
 *
 * Der Zeitstempel wird VOR dem Abruf gesetzt, nicht danach: Sonst zaehlte ein
 * Fehlschlag nicht als Versuch und jede weitere Anfrage liefe erneut gegen
 * einen Aussteller, der gerade ohnehin nicht antwortet.
 *
 * Ein Fehlschlag wird bewusst geschluckt statt weitergereicht. Der Aufrufer
 * findet danach schlicht keinen Schluessel und weist das Token ab — ein
 * Ausfall des Ausstellers fuehrt so zu Ablehnungen, nie zu Durchlaessen.
 */
async function aktualisiere(adresse: string): Promise<void> {
  if (speicher.laufend) return speicher.laufend;

  const jetzt = Date.now();
  if (jetzt - speicher.letzterAbruf < BREMSE_MS) return;
  speicher.letzterAbruf = jetzt;

  const lauf = abrufen(adresse)
    .catch((fehler: unknown) => {
      logger.warn({ err: fehler }, 'Schluesselsatz des Firmenzugangs nicht abrufbar');
    })
    .finally(() => {
      speicher.laufend = undefined;
    });

  speicher.laufend = lauf;
  return lauf;
}

async function holeSchluessel(kid: string, adresse: string): Promise<KeyObject | undefined> {
  if (speicher.gueltigBis <= Date.now()) await aktualisiere(adresse);

  const bekannt = speicher.schluessel.get(kid);
  if (bekannt) return bekannt;

  // Unbekanntes kid: Entra tauscht Schluessel aus, ohne das anzukuendigen.
  // Einmal neu holen — mehr laesst die Bremse in aktualisiere() nicht zu.
  await aktualisiere(adresse);
  return speicher.schluessel.get(kid);
}

/** Ablehnung: knapp nach aussen, mit Grund im Protokoll, ohne Tokenmaterial. */
function ablehnen(grund: string): AuthError {
  logger.warn({ grund }, 'Token des Firmenzugangs abgelehnt');
  // Bewusst immer AUTH_INVALID, auch bei abgelaufenen Token: Der Code landet
  // in usage_events und waere sonst genau die Auskunft, die der Text oben
  // zurueckhaelt.
  return new AuthError('AUTH_INVALID', ABLEHNUNGSTEXT);
}

function dekodiere(abschnitt: string): Buffer {
  // Buffer.from ueberliest ungueltige Zeichen stillschweigend; ohne die
  // Vorpruefung wuerde "kein base64" also als irgendetwas durchgehen.
  if (!BASE64URL.test(abschnitt)) throw ablehnen('aufbau');
  return Buffer.from(abschnitt, 'base64url');
}

function leseAbschnitt(abschnitt: string, grund: string): Record<string, unknown> {
  const text = dekodiere(abschnitt).toString('utf8');

  let wert: unknown;
  try {
    wert = JSON.parse(text);
  } catch {
    throw ablehnen(grund);
  }

  if (typeof wert !== 'object' || wert === null || Array.isArray(wert)) throw ablehnen(grund);
  return wert as Record<string, unknown>;
}

/**
 * Begrenzt, was aus einer Angabe zur Person uebernommen wird.
 *
 * Dieselbe Regel wie fuer Kopfzeilen in src/mcp/aufrufer.ts: Steuerzeichen
 * koennen ein Logformat zerreissen oder in einem Jama-Kommentar Unfug
 * anrichten, und die Laenge wird begrenzt. Dort ist die Funktion modullokal
 * und auf Kopfzeilenwerte zugeschnitten (string | string[]), hier auf einen
 * JSON-Wert unbekannten Typs — deshalb steht sie hier eigenstaendig.
 */
function text(wert: unknown): string | undefined {
  if (typeof wert !== 'string') return undefined;

  const sauber = [...wert]
    .map((zeichen) => {
      const code = zeichen.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : zeichen;
    })
    .join('')
    .trim()
    .slice(0, 120);

  return sauber.length > 0 ? sauber : undefined;
}

function zahl(wert: unknown): number | undefined {
  return typeof wert === 'number' && Number.isFinite(wert) ? wert : undefined;
}

/**
 * Empfaengerpruefung.
 *
 * aud darf nach RFC 7519 ein einzelner Wert oder eine Liste sein. Verglichen
 * wird exakt: Ein Praefixvergleich wuerde "api://dienst" auch auf
 * "api://dienst-und-mehr" passen lassen.
 */
function empfaengerPasst(aud: unknown, erwartet: string): boolean {
  if (typeof aud === 'string') return aud === erwartet;
  if (Array.isArray(aud)) return aud.some((wert) => wert === erwartet);
  return false;
}

/**
 * Berechtigungspruefung.
 *
 * Entra liefert delegierte Berechtigungen als leerzeichengetrennte Liste in
 * scp, Anwendungsberechtigungen dagegen als Feld in roles. Beide Wege sind
 * gleichwertig; ein Token ohne beides hat hier nichts verloren, auch wenn
 * Signatur und Aussteller stimmen.
 */
function hatBerechtigung(nutz: Record<string, unknown>, verlangt: string): boolean {
  const scp = nutz.scp;
  if (typeof scp === 'string' && scp.split(' ').includes(verlangt)) return true;

  const roles = nutz.roles;
  return Array.isArray(roles) && roles.some((wert) => wert === verlangt);
}

export async function pruefeToken(token: string): Promise<Tokenperson> {
  const angaben = pflichtangaben();
  if (!angaben) {
    logger.warn('Token vorgelegt, aber der Firmenzugang ist nicht eingerichtet');
    throw new AuthError(
      'AUTH_DISABLED',
      'Die Anmeldung über den Firmenzugang ist für diesen Dienst nicht eingerichtet.',
    );
  }

  if (token.length === 0 || token.length > MAX_TOKENLAENGE) throw ablehnen('laenge');

  const teile = token.split('.');
  if (teile.length !== 3) throw ablehnen('aufbau');
  const kopfTeil = teile[0] ?? '';
  const nutzTeil = teile[1] ?? '';
  const signaturTeil = teile[2] ?? '';

  // 1. Verfahren zuerst. Wer alg frei waehlen darf, waehlt "none" oder ein
  // symmetrisches Verfahren und unterschreibt mit dem oeffentlichen Schluessel,
  // der oeffentlich im JWKS steht — und kommt damit durch jede weitere
  // Pruefung. Deshalb faellt diese Entscheidung, bevor irgendetwas anderes
  // geschieht.
  const kopf = leseAbschnitt(kopfTeil, 'kopf');
  if (kopf.alg !== 'RS256') throw ablehnen('verfahren');

  const kid = typeof kopf.kid === 'string' ? kopf.kid : '';
  if (kid.length === 0 || kid.length > 200) throw ablehnen('kid');
  if (signaturTeil.length === 0) throw ablehnen('signatur');

  // 2. Signatur. Erst danach wird die Nutzlast ueberhaupt angesehen — nicht
  // geprueftes JSON ist fremder Text, kein Inhalt.
  const schluessel = await holeSchluessel(kid, jwksAdresse(angaben.aussteller));
  if (!schluessel) throw ablehnen('schluessel unbekannt');

  const unterschrieben = Buffer.from(`${kopfTeil}.${nutzTeil}`, 'ascii');
  if (!verify('RSA-SHA256', unterschrieben, schluessel, dekodiere(signaturTeil))) {
    throw ablehnen('signatur');
  }

  const nutz = leseAbschnitt(nutzTeil, 'nutzlast');

  // 3. Aussteller exakt.
  if (nutz.iss !== angaben.aussteller) throw ablehnen('aussteller');

  // 4. Empfaenger exakt. Ohne diese Bindung taugt ein Token, das fuer einen
  // ganz anderen Dienst desselben Mandanten ausgestellt wurde, auch hier.
  if (!empfaengerPasst(nutz.aud, angaben.empfaenger)) throw ablehnen('empfaenger');

  // 5. Laufzeit. exp ist Pflicht: Ein Token ohne Ablauf laeuft nie ab.
  const jetzt = Math.floor(Date.now() / 1000);
  const exp = zahl(nutz.exp);
  if (exp === undefined || jetzt > exp + UHRTOLERANZ_S) throw ablehnen('laufzeit');
  const nbf = zahl(nutz.nbf);
  if (nbf !== undefined && nbf > jetzt + UHRTOLERANZ_S) throw ablehnen('laufzeit');

  // 6. Berechtigung.
  if (!hatBerechtigung(nutz, angaben.berechtigung)) throw ablehnen('berechtigung');

  // Erst jetzt sind die Angaben zur Person eine belegte Aussage.
  const kennung = text(nutz.oid);
  if (!kennung) throw ablehnen('kennung');

  const person: Tokenperson = { kennung };

  // preferred_username ist bei Entra ueblicherweise der Anmeldename und
  // zugleich eine Adresse. Er dient nur als Rueckfallwert fuer die E-Mail: Der
  // Abgleich in src/service/personen.ts vergleicht exakt, ein unpassender Wert
  // findet deshalb niemanden — er fuehrt nie zur falschen Person.
  const anmeldename = text(nutz.preferred_username) ?? text(nutz.upn);
  if (anmeldename) person.anmeldename = anmeldename;

  const email = text(nutz.email) ?? (anmeldename?.includes('@') ? anmeldename : undefined);
  if (email) person.email = email;

  const name = text(nutz.name);
  if (name) person.name = name;

  return person;
}
