import { eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { jamaBenutzer, jamaConnections, jamaProjekte } from '../db/schema.js';
import { jamaCredentialsSchema } from '../jama/auth.js';
import { JamaClient } from '../jama/client.js';
import type { JamaProject, JamaUser } from '../jama/types.js';
import { getConfig } from '../shared/config.js';
import { decryptSecret } from '../shared/crypto.js';
import { ServiceError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';
import { recordAudit } from './usage.js';

/**
 * Abgleich des Spiegels von Benutzern und Projekten aus Jama.
 *
 * Der Spiegel ist nie die Quelle. Jama bleibt fuehrend; dieser Abgleich liest
 * und schreibt nach, er schreibt niemals nach Jama zurueck. Es gibt in dieser
 * Datei deshalb bewusst keinen einzigen schreibenden Jama-Aufruf: wer Rechte in
 * Jama vergeben will, tut das in Jama. Hier entsteht nur die Grundlage dafuer,
 * die Zuordnung im Dashboard ohne Live-Abfrage anzeigen und pflegen zu koennen.
 *
 * Warum ueberhaupt gespiegelt wird: Jamas Benutzer- und Projektlisten gehen
 * ueber die gesamte Instanz und zaehlen gegen das Rate-Limit von zehn Anfragen
 * je Sekunde. Eine Verwaltungsoberflaeche, die bei jedem Blaettern neu
 * nachfragt, bringt den laufenden Betrieb der Tools ins Stocken.
 *
 * Die Abfragen selbst stammen unveraendert aus der vorhandenen Anbindung
 * (SchemaResolver.getUsers und SchemaResolver.getProjects) — genau die, die
 * auch jama_list_users und jama_list_projects benutzen. Nichts davon wird hier
 * nachgebaut; die dortige Filterung nach Zugangsrechten entfaellt bewusst, weil
 * der Spiegel die Instanz abbildet und die Einschraenkung erst beim Zugriff
 * greift.
 */

export interface Abgleichsergebnis {
  benutzer: { neu: number; geaendert: number; verschwunden: number };
  projekte: { neu: number; geaendert: number; verschwunden: number };
  dauerMs: number;
  warnungen: string[];
}

/** Ein Benutzer, so wie er im Spiegel steht oder aus Jama kommt. */
export interface BenutzerStand {
  jamaUserId: number;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  licenseType: string | null;
  aktiv: boolean;
}

/** Ein Projekt, so wie es im Spiegel steht oder aus Jama kommt. */
export interface ProjektStand {
  jamaProjectId: number;
  projectKey: string | null;
  name: string | null;
  /** Jama-Projektnummer des Ordners darueber; null bei einer Wurzel. */
  elternId: number | null;
  istOrdner: boolean;
  archiviert: boolean;
}

/**
 * Ergebnis eines Vergleichs zwischen Spiegel und Jama.
 *
 * "verschwunden" traegt nur Nummern, weil daraus kein Datensatz entsteht,
 * sondern eine vorhandene Zeile stillgelegt wird.
 */
export interface Verschmelzung<T> {
  neu: T[];
  geaendert: T[];
  unveraendert: number[];
  verschwunden: number[];
}

/**
 * Vergleicht den Benutzerspiegel mit dem, was Jama gerade liefert.
 *
 * Reine Funktion ohne Datenbank und ohne Ein- und Ausgabe: der eigentliche
 * Entscheidungsteil des Abgleichs bleibt so ohne laufende Jama-Instanz
 * pruefbar.
 *
 * Wer in Jama fehlt, gilt als verschwunden und wird stillgelegt, nicht
 * geloescht. Eine geloeschte Zeile wuerde der Rechtezuordnung ihren
 * Bezugspunkt nehmen: im Dashboard staende dann eine Nummer ohne Namen, und
 * niemand koennte mehr sagen, wem einmal was zugeordnet war. Bereits
 * stillgelegte Zeilen zaehlen nicht erneut, sonst meldete jeder Lauf dieselben
 * Abgaenge aufs Neue.
 */
export function verschmelzeBenutzer(
  vorhanden: BenutzerStand[],
  ausJama: BenutzerStand[],
): Verschmelzung<BenutzerStand> {
  const bekannt = new Map(vorhanden.map((eintrag) => [eintrag.jamaUserId, eintrag]));
  const gesehen = new Set<number>();

  const neu: BenutzerStand[] = [];
  const geaendert: BenutzerStand[] = [];
  const unveraendert: number[] = [];

  for (const frisch of ausJama) {
    gesehen.add(frisch.jamaUserId);
    const alt = bekannt.get(frisch.jamaUserId);
    if (!alt) {
      neu.push(frisch);
    } else if (benutzerUnterscheidetSich(alt, frisch)) {
      geaendert.push(frisch);
    } else {
      unveraendert.push(frisch.jamaUserId);
    }
  }

  const verschwunden = vorhanden
    .filter((alt) => alt.aktiv && !gesehen.has(alt.jamaUserId))
    .map((alt) => alt.jamaUserId);

  return { neu, geaendert, unveraendert, verschwunden };
}

function benutzerUnterscheidetSich(alt: BenutzerStand, frisch: BenutzerStand): boolean {
  return (
    alt.username !== frisch.username ||
    alt.email !== frisch.email ||
    alt.firstName !== frisch.firstName ||
    alt.lastName !== frisch.lastName ||
    alt.licenseType !== frisch.licenseType ||
    alt.aktiv !== frisch.aktiv
  );
}

/**
 * Gegenstueck fuer Projekte. Dieselbe Regel, nur heisst "stillgelegt" hier
 * archiviert: ein Projekt, das Jama nicht mehr liefert, verschwindet nicht aus
 * dem Spiegel, sondern wird als archiviert gefuehrt. Taucht es wieder auf,
 * gilt es als geaendert und die Archivierung faellt weg — ein Projekt kann in
 * Jama aus dem Blickfeld geraten und spaeter zurueckkehren, etwa wenn sich die
 * Sicht des hinterlegten Benutzers aendert.
 */
export function verschmelzeProjekte(
  vorhanden: ProjektStand[],
  ausJama: ProjektStand[],
): Verschmelzung<ProjektStand> {
  const bekannt = new Map(vorhanden.map((eintrag) => [eintrag.jamaProjectId, eintrag]));
  const gesehen = new Set<number>();

  const neu: ProjektStand[] = [];
  const geaendert: ProjektStand[] = [];
  const unveraendert: number[] = [];

  for (const frisch of ausJama) {
    gesehen.add(frisch.jamaProjectId);
    const alt = bekannt.get(frisch.jamaProjectId);
    if (!alt) {
      neu.push(frisch);
    } else if (projektUnterscheidetSich(alt, frisch)) {
      geaendert.push(frisch);
    } else {
      unveraendert.push(frisch.jamaProjectId);
    }
  }

  const verschwunden = vorhanden
    .filter((alt) => !alt.archiviert && !gesehen.has(alt.jamaProjectId))
    .map((alt) => alt.jamaProjectId);

  return { neu, geaendert, unveraendert, verschwunden };
}

function projektUnterscheidetSich(alt: ProjektStand, frisch: ProjektStand): boolean {
  return (
    alt.projectKey !== frisch.projectKey ||
    alt.name !== frisch.name ||
    // Das Umhaengen in einen anderen Ordner ist eine echte Aenderung: die
    // Oberflaeche baut ihren Baum aus genau dieser Kante, und eine Auswahl
    // "Ordner samt allem darunter" faende sonst den falschen Zweig.
    alt.elternId !== frisch.elternId ||
    alt.istOrdner !== frisch.istOrdner ||
    alt.archiviert !== frisch.archiviert
  );
}

/** Leere Zeichenketten aus Jama sind dasselbe wie "nicht gesetzt". */
function text(wert: unknown): string | null {
  if (typeof wert !== 'string') return null;
  const gekuerzt = wert.trim();
  return gekuerzt === '' ? null : gekuerzt;
}

/** Uebersetzt die Jama-Antwort in den Spiegelstand. */
export function ausJamaBenutzer(user: JamaUser): BenutzerStand {
  return {
    jamaUserId: user.id,
    username: text(user.username),
    email: text(user.email),
    firstName: text(user.firstName),
    lastName: text(user.lastName),
    licenseType: text(user.licenseType),
    // Jama laesst das Feld bei aktiven Benutzern gelegentlich weg; nur ein
    // ausdrueckliches false bedeutet deaktiviert.
    aktiv: user.active !== false,
  };
}

/** Uebersetzt die Jama-Antwort in den Spiegelstand. */
export function ausJamaProjekt(project: JamaProject): ProjektStand {
  return {
    jamaProjectId: project.id,
    projectKey: text(project.projectKey ?? project.fields?.projectKey),
    name: text(project.fields?.name),
    elternId: typeof project.parent === 'number' ? project.parent : null,
    istOrdner: project.isFolder === true,
    // Was Jama liefert, existiert. Archiviert wird ausschliesslich durch
    // Abwesenheit, nie durch ein Feld der Antwort.
    archiviert: false,
  };
}

/**
 * Gleicht den Spiegel gegen eine Jama-Verbindung ab.
 *
 * Benutzer und Projekte laufen in getrennten Transaktionen. Das ist Absicht:
 * die beiden Listen haengen fachlich nicht zusammen, und ein Fehlschlag beim
 * zweiten Teil darf den ersten nicht mit zurueckdrehen. Wer zehntausend
 * Projekte hat, hat sonst nach jedem Zeitueberlauf auch keinen aktuellen
 * Benutzerstand mehr.
 */
/**
 * Macht aus einem Fehler einen Satz, der in die Oberflaeche darf.
 *
 * Die Warnungen des Abgleichs gehen unveraendert bis in den Browser. Ein
 * durchgereichter Fehlertext aus der Jama-Anbindung traegt dorthin regelmaessig
 * die interne Adresse der Instanz, einen Pfad oder eine Kennung — Angaben, die
 * niemand braucht, um zu verstehen, dass der Abgleich gescheitert ist. Der
 * vollstaendige Grund gehoert ins Serverprotokoll, nicht in die Anzeige.
 */
function fuerDieAnzeige(error: unknown): string {
  if (error instanceof ServiceError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Die Anfrage an Jama hat zu lange gedauert.';
  }
  return 'Die Anfrage an Jama ist fehlgeschlagen. Einzelheiten stehen im Serverprotokoll.';
}

export async function gleicheAb(connectionId: string, von: string): Promise<Abgleichsergebnis> {
  const begonnen = Date.now();
  const db = getDb();

  const verbindungen = await db
    .select()
    .from(jamaConnections)
    .where(eq(jamaConnections.id, connectionId))
    .limit(1);

  const verbindung = verbindungen[0];
  if (!verbindung) {
    throw new ServiceError('CONNECTION_MISSING', 'Die Jama-Verbindung existiert nicht.', 404);
  }

  let credentials;
  try {
    credentials = jamaCredentialsSchema.parse(
      JSON.parse(decryptSecret(verbindung.credentialsEnc, getConfig().ENCRYPTION_KEY)),
    );
  } catch (error) {
    throw new ServiceError(
      'CONNECTION_MISSING',
      `Die hinterlegten Jama-Zugangsdaten ließen sich nicht lesen: ${
        error instanceof Error ? error.message : String(error)
      }`,
      500,
    );
  }

  const client = new JamaClient({
    connectionId: verbindung.id,
    baseUrl: verbindung.baseUrl,
    credentials,
    rateLimitRps: verbindung.rateLimitRps ?? undefined,
  });

  const warnungen: string[] = [];
  const ergebnis: Abgleichsergebnis = {
    benutzer: { neu: 0, geaendert: 0, verschwunden: 0 },
    projekte: { neu: 0, geaendert: 0, verschwunden: 0 },
    dauerMs: 0,
    warnungen,
  };

  let benutzerOk = false;
  try {
    ergebnis.benutzer = await gleicheBenutzerAb(client);
    benutzerOk = true;
  } catch (error) {
    warnungen.push(`Der Benutzerabgleich ist fehlgeschlagen. ${fuerDieAnzeige(error)}`);
    logger.warn({ err: error, verbindung: verbindung.name }, 'Benutzerabgleich fehlgeschlagen');
  }

  let projekteOk = false;
  try {
    const { zaehler, hinweise } = await gleicheProjekteAb(client);
    ergebnis.projekte = zaehler;
    warnungen.push(...hinweise);
    projekteOk = true;
  } catch (error) {
    warnungen.push(`Der Projektabgleich ist fehlgeschlagen. ${fuerDieAnzeige(error)}`);
    logger.warn({ err: error, verbindung: verbindung.name }, 'Projektabgleich fehlgeschlagen');
  }

  ergebnis.dauerMs = Date.now() - begonnen;

  await recordAudit(
    {
      action: 'personen.abgleich',
      targetType: 'connection',
      targetKey: connectionId,
      payload: {
        benutzer: ergebnis.benutzer,
        projekte: ergebnis.projekte,
        dauerMs: ergebnis.dauerMs,
        warnungen,
      },
      result: benutzerOk && projekteOk ? 'ok' : 'error',
    },
    { type: 'admin', name: von },
  );

  // Ein einzelner misslungener Teil bleibt eine Warnung im Ergebnis, damit der
  // gelungene Teil sichtbar bleibt. Misslingen beide, ist der Lauf gescheitert
  // und darf nicht als Erfolg zurueckkommen.
  if (!benutzerOk && !projekteOk) {
    throw new ServiceError('JAMA_UNEXPECTED', warnungen.join(' '), 502);
  }

  return ergebnis;
}

async function gleicheBenutzerAb(
  client: JamaClient,
): Promise<{ neu: number; geaendert: number; verschwunden: number }> {
  const db = getDb();
  const frisch = (await client.schema.getUsers()).map(ausJamaBenutzer);

  return db.transaction(async (tx) => {
    const vorhanden = await tx
      .select({
        jamaUserId: jamaBenutzer.jamaUserId,
        username: jamaBenutzer.username,
        email: jamaBenutzer.email,
        firstName: jamaBenutzer.firstName,
        lastName: jamaBenutzer.lastName,
        licenseType: jamaBenutzer.licenseType,
        aktiv: jamaBenutzer.aktiv,
      })
      .from(jamaBenutzer);

    const abgleich = verschmelzeBenutzer(vorhanden, frisch);
    const jetzt = new Date();

    if (abgleich.neu.length > 0) {
      await tx
        .insert(jamaBenutzer)
        .values(abgleich.neu.map((eintrag) => ({ ...eintrag, abgeglichenAm: jetzt })));
    }

    for (const eintrag of abgleich.geaendert) {
      await tx
        .update(jamaBenutzer)
        .set({
          username: eintrag.username,
          email: eintrag.email,
          firstName: eintrag.firstName,
          lastName: eintrag.lastName,
          licenseType: eintrag.licenseType,
          aktiv: eintrag.aktiv,
          abgeglichenAm: jetzt,
        })
        .where(eq(jamaBenutzer.jamaUserId, eintrag.jamaUserId));
    }

    if (abgleich.verschwunden.length > 0) {
      await tx
        .update(jamaBenutzer)
        .set({ aktiv: false, abgeglichenAm: jetzt })
        .where(inArray(jamaBenutzer.jamaUserId, abgleich.verschwunden));
    }

    // Auch unveraenderte Zeilen bekommen den Zeitstempel: sonst sagte
    // "zuletzt abgeglichen" nichts ueber den Lauf aus, sondern nur darueber,
    // wann sich zuletzt etwas geaendert hat.
    for (const teil of teile(abgleich.unveraendert)) {
      await tx
        .update(jamaBenutzer)
        .set({ abgeglichenAm: jetzt })
        .where(inArray(jamaBenutzer.jamaUserId, teil));
    }

    return {
      neu: abgleich.neu.length,
      geaendert: abgleich.geaendert.length,
      verschwunden: abgleich.verschwunden.length,
    };
  });
}

async function gleicheProjekteAb(client: JamaClient): Promise<{
  zaehler: { neu: number; geaendert: number; verschwunden: number };
  hinweise: string[];
}> {
  const db = getDb();
  // Ordner werden mit gespiegelt: sie sind die Kante des Baums, ueber den in
  // der Oberflaeche ganze Zweige auf einmal zugeordnet werden.
  const frisch = (await client.schema.getProjects()).map(ausJamaProjekt);
  const hinweise = fehlendeEltern(frisch);

  const zaehler = await db.transaction(async (tx) => {
    const vorhanden = await tx
      .select({
        jamaProjectId: jamaProjekte.jamaProjectId,
        projectKey: jamaProjekte.projectKey,
        name: jamaProjekte.name,
        elternId: jamaProjekte.elternId,
        istOrdner: jamaProjekte.istOrdner,
        archiviert: jamaProjekte.archiviert,
      })
      .from(jamaProjekte);

    const abgleich = verschmelzeProjekte(vorhanden, frisch);
    const jetzt = new Date();

    if (abgleich.neu.length > 0) {
      await tx
        .insert(jamaProjekte)
        .values(abgleich.neu.map((eintrag) => ({ ...eintrag, abgeglichenAm: jetzt })));
    }

    for (const eintrag of abgleich.geaendert) {
      await tx
        .update(jamaProjekte)
        .set({
          projectKey: eintrag.projectKey,
          name: eintrag.name,
          elternId: eintrag.elternId,
          istOrdner: eintrag.istOrdner,
          archiviert: eintrag.archiviert,
          abgeglichenAm: jetzt,
        })
        .where(eq(jamaProjekte.jamaProjectId, eintrag.jamaProjectId));
    }

    if (abgleich.verschwunden.length > 0) {
      await tx
        .update(jamaProjekte)
        .set({ archiviert: true, abgeglichenAm: jetzt })
        .where(inArray(jamaProjekte.jamaProjectId, abgleich.verschwunden));
    }

    for (const teil of teile(abgleich.unveraendert)) {
      await tx
        .update(jamaProjekte)
        .set({ abgeglichenAm: jetzt })
        .where(inArray(jamaProjekte.jamaProjectId, teil));
    }

    return {
      neu: abgleich.neu.length,
      geaendert: abgleich.geaendert.length,
      verschwunden: abgleich.verschwunden.length,
    };
  });

  return { zaehler, hinweise };
}

/**
 * Meldet Projekte, deren uebergeordneter Ordner in der Antwort fehlt.
 *
 * Das passiert, wenn der hinterlegte Jama-Benutzer ein Projekt sehen darf, den
 * Ordner darueber aber nicht. Die Oberflaeche kann diesen Zweig dann nicht
 * einhaengen und wuerde ihn stillschweigend verschlucken — genau deshalb steht
 * der Hinweis im Ergebnis.
 */
export function fehlendeEltern(projekte: ProjektStand[]): string[] {
  const vorhanden = new Set(projekte.map((projekt) => projekt.jamaProjectId));
  const verwaist = projekte.filter(
    (projekt) => projekt.elternId !== null && !vorhanden.has(projekt.elternId),
  );
  if (verwaist.length === 0) return [];
  return [
    `${verwaist.length} Projekte verweisen auf einen übergeordneten Ordner, den Jama nicht mitgeliefert hat. Sie erscheinen in der Auswahl als eigener Zweig. Möglicherweise fehlen dem hinterlegten Jama-Benutzer die Rechte an diesen Ordnern.`,
  ];
}

/**
 * Zerlegt eine Nummernliste in handliche Stuecke. Bei mehreren tausend
 * Eintraegen sprengt eine einzelne IN-Liste sonst die Parametergrenze der
 * Datenbankverbindung.
 */
function teile(nummern: number[], groesse = 500): number[][] {
  const stuecke: number[][] = [];
  for (let start = 0; start < nummern.length; start += groesse) {
    stuecke.push(nummern.slice(start, start + groesse));
  }
  return stuecke;
}

/**
 * Zeitpunkt und Umfang des letzten Abgleichs.
 *
 * Gezaehlt wird, was gerade gilt: stillgelegte Benutzer und archivierte
 * Projekte bleiben als Bezugspunkt der Zuordnung stehen, gehoeren aber nicht
 * zum Umfang dessen, was Jama zuletzt geliefert hat.
 */
export async function letzterAbgleich(): Promise<{
  am: Date | null;
  benutzer: number;
  projekte: number;
}> {
  const db = getDb();

  const [benutzerStand] = await db
    .select({
      am: sql<Date | null>`max(${jamaBenutzer.abgeglichenAm})`,
      anzahl: sql<number>`count(*) filter (where ${jamaBenutzer.aktiv})::int`,
    })
    .from(jamaBenutzer);

  const [projektStand] = await db
    .select({
      am: sql<Date | null>`max(${jamaProjekte.abgeglichenAm})`,
      anzahl: sql<number>`count(*) filter (where not ${jamaProjekte.archiviert})::int`,
    })
    .from(jamaProjekte);

  const zeitpunkte = [benutzerStand?.am, projektStand?.am]
    .map((wert) => (wert ? new Date(wert) : null))
    .filter((wert): wert is Date => wert !== null && !Number.isNaN(wert.getTime()));

  return {
    am:
      zeitpunkte.length > 0
        ? new Date(Math.max(...zeitpunkte.map((wert) => wert.getTime())))
        : null,
    benutzer: Number(benutzerStand?.anzahl ?? 0),
    projekte: Number(projektStand?.anzahl ?? 0),
  };
}
