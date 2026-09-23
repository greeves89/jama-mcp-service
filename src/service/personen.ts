import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { jamaBenutzer, jamaProjekte, personenrechte, personenvorgabe } from '../db/schema.js';
import { ServiceError } from '../shared/errors.js';
import { recordAudit } from './usage.js';
import type { Stufe } from '../mcp/rechte.js';

/**
 * Verwaltung der personenbezogenen Rechte.
 *
 * Diese Datei pflegt ausschliesslich die Zuordnung — sie entscheidet nichts.
 * Was aus einer Zuordnung folgt, rechnet src/mcp/rechte.ts aus, ohne
 * Datenbank. Die Trennung ist der Grund, warum sich die Rangfolge aus
 * Sperrliste, Zugangsfreigabe und Personenzuordnung ohne laufende Instanz
 * pruefen laesst.
 *
 * Alles hier haengt an der Jama-Nummer, nie an der uuid des Spiegels: der
 * Spiegel darf jederzeit verworfen und neu aufgebaut werden, die Zuordnung
 * ueberlebt das.
 */

export type { Stufe };

const STUFEN: readonly Stufe[] = ['keine', 'lesen', 'schreiben'];

export interface Personenzeile {
  jamaUserId: number;
  /**
   * Die Feldnamen folgen Jama, nicht dem uebrigen deutschen Wortschatz dieser
   * Datei. Der Grund ist die Naht: Der Spiegel traegt sie so, die Oberflaeche
   * erwartet sie so, und die Route reicht die Zeile unveraendert durch. Ein
   * drittes Namensschema an dieser Stelle waere eine Uebersetzung, die
   * irgendwann jemand vergisst.
   */
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  licenseType: string | null;
  aktiv: boolean;
  grundstufe: Stufe;
  /** Vor- und Nachname zusammengesetzt, damit die Anzeige nicht raten muss. */
  name: string;
  /** Wie viele Projekte dieser Person ausdruecklich zugeordnet sind. */
  anzahlZuordnungen: number;
}

export interface Projektzeile {
  jamaProjectId: number;
  projectKey: string | null;
  name: string | null;
  /** Jama-Projektnummer des Ordners darueber; null bei einer Wurzel. */
  elternId: number | null;
  istOrdner: boolean;
  archiviert: boolean;
}

export interface PersonenFilter {
  /** Sucht in Vor-, Nachname, Anmeldename und E-Mail-Adresse. */
  q?: string;
  nurMitZuordnung?: boolean;
  nurAktive?: boolean;
}

export interface ProjektFilter {
  q?: string;
  /** Archivierte Projekte mit ausgeben. Standard: nur die aktuellen. */
  mitArchivierten?: boolean;
}

export interface Zuordnung {
  lesen: number[];
  schreiben: number[];
  grundstufe: Stufe;
}

/**
 * Prueft eine Stufe, bevor sie geschrieben wird.
 *
 * Die Spalte ist ein Text ohne Datenbank-Einschraenkung, damit spaetere Stufen
 * ohne Migration moeglich bleiben. Genau deshalb muss die Pruefung hier
 * stattfinden: ein Tippfehler laege sonst als unbekannte Stufe in der
 * Tabelle und wuerde bei der Rechteberechnung stillschweigend wie "keine"
 * wirken.
 */
function pruefeStufe(stufe: string): Stufe {
  if (!STUFEN.includes(stufe as Stufe)) {
    throw new ServiceError(
      'VALIDATION',
      `"${stufe}" ist keine gültige Stufe. Erlaubt sind: ${STUFEN.join(', ')}.`,
      400,
    );
  }
  return stufe as Stufe;
}

function pruefeNummer(wert: number, bezeichnung: string): number {
  if (!Number.isInteger(wert) || wert <= 0) {
    throw new ServiceError('VALIDATION', `${bezeichnung} muss eine positive Ganzzahl sein.`, 400);
  }
  return wert;
}

/**
 * Bereitet einen Suchbegriff fuer ilike auf.
 *
 * Die Prozent- und Unterstrichzeichen sind in einem LIKE-Muster Platzhalter.
 * Ohne Maskierung machte eine Eingabe aus einem einzelnen Prozentzeichen eine
 * Suche ueber alles — der Wert selbst wird ueber Drizzle als Parameter
 * uebergeben und ist damit nie Teil des Abfragetextes.
 */
function suchmuster(begriff: string): string {
  const maskiert = begriff.trim().replace(/[\\%_]/g, (zeichen) => `\\${zeichen}`);
  return `%${maskiert}%`;
}

/**
 * Ein vollstaendiger Wert fuer einen Vergleich ohne Ruecksicht auf Gross- und
 * Kleinschreibung. Die Platzhalterzeichen werden maskiert, damit aus einer
 * Kopfzeile mit Prozentzeichen kein Muster wird, das auf beliebige Personen
 * passt.
 */
function suchwert(begriff: string): string {
  return begriff.trim().replace(/[\\%_]/g, (zeichen) => `\\${zeichen}`);
}

/** Ein Anzeigename, der auch dann traegt, wenn Jama nur Teile gefuellt hat. */
function anzeigename(zeile: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  email: string | null;
  jamaUserId: number;
}): string {
  const voll = [zeile.firstName, zeile.lastName].filter(Boolean).join(' ').trim();
  return voll || zeile.username || zeile.email || `Benutzer ${zeile.jamaUserId}`;
}

/**
 * Eine fehlende Zeile in personenvorgabe bedeutet ausdruecklich "keine".
 *
 * Die Spaltenvorgabe 'lesen' greift nur beim Anlegen einer Zeile, also wenn
 * jemand die Grundstufe bewusst gesetzt hat. Fuer eine Person, ueber die nie
 * entschieden wurde, waere ein stillschweigendes Leserecht auf jedes Projekt
 * des Zugangs das Gegenteil dessen, wofuer diese Matrix gebaut wurde.
 */
function grundstufeOder(wert: string | null): Stufe {
  if (wert === null) return 'keine';
  return STUFEN.includes(wert as Stufe) ? (wert as Stufe) : 'keine';
}

/**
 * Kennzeichen, mit denen ein Aufruf einer Person zugeordnet werden kann.
 *
 * Beides stammt aus Kopfzeilen des vorgelagerten Clients und ist eine Auskunft,
 * kein Nachweis (siehe src/mcp/aufrufer.ts). Deshalb kann diese Zuordnung
 * Rechte nur einschraenken und nie ausweiten: sie waehlt innerhalb der
 * Freigabe des Zugangs aus, mehr nicht.
 */
export interface Personenkennung {
  email?: string;
  anmeldename?: string;
}

/**
 * Sucht zu einem Aufruf die Jama-Benutzernummer im Spiegel.
 *
 * Gesucht wird ausschliesslich ueber E-Mail-Adresse und Anmeldenamen, beides
 * Gross- und Kleinschreibung egal. Der angezeigte Vor- und Nachname bleibt
 * bewusst aussen vor: Namensgleichheit ist in grossen Instanzen die Regel, und
 * eine Verwechslung wuerde hier die Rechte einer anderen Person vergeben.
 *
 * Aus demselben Grund liefert ein mehrdeutiger Treffer null statt einer
 * Nummer. Unbekannt ist ungefaehrlich — die aufrufende Person faellt dann auf
 * die Behandlung fuer Unbekannte zurueck und darf hoechstens lesen. Falsch
 * erkannt waere es nicht.
 */
export async function findeJamaBenutzerId(kennung: Personenkennung): Promise<number | null> {
  const db = getDb();

  const email = kennung.email?.trim();
  if (email) {
    const treffer = await db
      .select({ jamaUserId: jamaBenutzer.jamaUserId })
      .from(jamaBenutzer)
      .where(and(eq(jamaBenutzer.aktiv, true), ilike(jamaBenutzer.email, suchwert(email))))
      .limit(2);

    if (treffer.length === 1) return treffer[0]?.jamaUserId ?? null;
    if (treffer.length > 1) return null;
  }

  const anmeldename = kennung.anmeldename?.trim();
  if (anmeldename) {
    const treffer = await db
      .select({ jamaUserId: jamaBenutzer.jamaUserId })
      .from(jamaBenutzer)
      .where(
        and(eq(jamaBenutzer.aktiv, true), ilike(jamaBenutzer.username, suchwert(anmeldename))),
      )
      .limit(2);

    if (treffer.length === 1) return treffer[0]?.jamaUserId ?? null;
  }

  return null;
}

export async function ladePersonen(filter: PersonenFilter = {}): Promise<Personenzeile[]> {
  const bedingungen: SQL[] = [];

  if (filter.nurAktive) bedingungen.push(eq(jamaBenutzer.aktiv, true));

  if (filter.q && filter.q.trim() !== '') {
    const muster = suchmuster(filter.q);
    const suche = or(
      ilike(jamaBenutzer.firstName, muster),
      ilike(jamaBenutzer.lastName, muster),
      ilike(jamaBenutzer.username, muster),
      ilike(jamaBenutzer.email, muster),
    );
    if (suche) bedingungen.push(suche);
  }

  const anzahl = sql<number>`count(${personenrechte.id})::int`;

  const zeilen = await getDb()
    .select({
      jamaUserId: jamaBenutzer.jamaUserId,
      username: jamaBenutzer.username,
      firstName: jamaBenutzer.firstName,
      lastName: jamaBenutzer.lastName,
      email: jamaBenutzer.email,
      licenseType: jamaBenutzer.licenseType,
      aktiv: jamaBenutzer.aktiv,
      grundstufe: personenvorgabe.grundstufe,
      anzahlZuordnungen: anzahl,
    })
    .from(jamaBenutzer)
    .leftJoin(personenvorgabe, eq(personenvorgabe.jamaUserId, jamaBenutzer.jamaUserId))
    .leftJoin(personenrechte, eq(personenrechte.jamaUserId, jamaBenutzer.jamaUserId))
    .where(bedingungen.length > 0 ? and(...bedingungen) : undefined)
    .groupBy(jamaBenutzer.id, personenvorgabe.jamaUserId)
    // Die Einschraenkung auf Personen mit Zuordnung gehoert hinter die
    // Gruppierung, nicht davor: davor gaebe es die Anzahl noch nicht.
    .having(filter.nurMitZuordnung ? sql`count(${personenrechte.id}) > 0` : undefined)
    .orderBy(asc(jamaBenutzer.lastName), asc(jamaBenutzer.firstName), asc(jamaBenutzer.jamaUserId));

  return zeilen.map((zeile) => ({
    jamaUserId: zeile.jamaUserId,
    username: zeile.username,
    firstName: zeile.firstName,
    lastName: zeile.lastName,
    name: anzeigename(zeile),
    email: zeile.email,
    licenseType: zeile.licenseType,
    aktiv: zeile.aktiv,
    grundstufe: grundstufeOder(zeile.grundstufe),
    anzahlZuordnungen: Number(zeile.anzahlZuordnungen ?? 0),
  }));
}

/**
 * Liefert die Projekte des Spiegels als flache Liste mit elternId.
 *
 * Bewusst flach: der Baum entsteht in der Oberflaeche. Wuerde er hier gebaut,
 * muesste jede Filterung ihn erneut zusammensetzen, und ein Zweig, dessen
 * Ordner der Suchbegriff nicht trifft, verschwaende samt seiner Treffer.
 */
export async function ladeProjekte(filter: ProjektFilter = {}): Promise<Projektzeile[]> {
  const bedingungen: SQL[] = [];

  if (!filter.mitArchivierten) bedingungen.push(eq(jamaProjekte.archiviert, false));

  if (filter.q && filter.q.trim() !== '') {
    const muster = suchmuster(filter.q);
    const suche = or(ilike(jamaProjekte.name, muster), ilike(jamaProjekte.projectKey, muster));
    if (suche) bedingungen.push(suche);
  }

  const zeilen = await getDb()
    .select({
      jamaProjectId: jamaProjekte.jamaProjectId,
      projectKey: jamaProjekte.projectKey,
      name: jamaProjekte.name,
      elternId: jamaProjekte.elternId,
      istOrdner: jamaProjekte.istOrdner,
      archiviert: jamaProjekte.archiviert,
    })
    .from(jamaProjekte)
    .where(bedingungen.length > 0 ? and(...bedingungen) : undefined)
    .orderBy(asc(jamaProjekte.name), asc(jamaProjekte.jamaProjectId));

  return zeilen;
}

export async function ladeZuordnung(jamaUserId: number): Promise<Zuordnung> {
  pruefeNummer(jamaUserId, 'Die Benutzernummer');
  const db = getDb();

  const rechte = await db
    .select({ jamaProjectId: personenrechte.jamaProjectId, stufe: personenrechte.stufe })
    .from(personenrechte)
    .where(eq(personenrechte.jamaUserId, jamaUserId));

  const vorgaben = await db
    .select({ grundstufe: personenvorgabe.grundstufe })
    .from(personenvorgabe)
    .where(eq(personenvorgabe.jamaUserId, jamaUserId))
    .limit(1);

  return {
    lesen: rechte.filter((zeile) => zeile.stufe === 'lesen').map((zeile) => zeile.jamaProjectId),
    schreiben: rechte
      .filter((zeile) => zeile.stufe === 'schreiben')
      .map((zeile) => zeile.jamaProjectId),
    grundstufe: grundstufeOder(vorgaben[0]?.grundstufe ?? null),
  };
}

/**
 * Setzt die Zuordnung einer Person zu genau einem Projekt.
 *
 * 'keine' loescht die Zeile, statt sie zu speichern. Eine gespeicherte Null
 * waere ein zweiter Weg, dasselbe auszudruecken, und jede Auswertung muesste
 * ihn zusaetzlich kennen.
 */
export async function setzeZuordnung(
  jamaUserId: number,
  projectId: number,
  stufe: Stufe,
  von: string,
): Promise<void> {
  pruefeNummer(jamaUserId, 'Die Benutzernummer');
  pruefeNummer(projectId, 'Die Projektnummer');
  const gepruefteStufe = pruefeStufe(stufe);

  const db = getDb();
  await pruefePersonBekannt(jamaUserId);
  await pruefeProjekteBekannt([projectId]);

  if (gepruefteStufe === 'keine') {
    await db
      .delete(personenrechte)
      .where(
        and(
          eq(personenrechte.jamaUserId, jamaUserId),
          eq(personenrechte.jamaProjectId, projectId),
        ),
      );
  } else {
    await db
      .insert(personenrechte)
      .values({
        jamaUserId,
        jamaProjectId: projectId,
        stufe: gepruefteStufe,
        vergebenAm: new Date(),
        vergebenVon: von,
      })
      .onConflictDoUpdate({
        target: [personenrechte.jamaUserId, personenrechte.jamaProjectId],
        set: { stufe: gepruefteStufe, vergebenAm: new Date(), vergebenVon: von },
      });
  }

  await recordAudit(
    {
      action: 'personen.zuordnung',
      targetType: 'person',
      targetKey: String(jamaUserId),
      payload: { projectId, stufe: gepruefteStufe },
      result: 'ok',
    },
    { type: 'admin', name: von },
  );
}

/**
 * Setzt die Grundstufe fuer alle aktiven Personen auf einmal.
 *
 * Ohne diesen Weg ist die Matrix im Alltag unbedienbar: Wer den Schalter fuer
 * einen Zugang umlegt, blendet damit zunaechst jeden aus, weil eine Person
 * ohne Eintrag als "keine" gilt. Bei zweihundert Personen jede Zeile einzeln
 * anzuklicken, waere der sichere Weg dahin, dass die Matrix nie eingeschaltet
 * wird.
 *
 * Deaktivierte Personen bleiben bewusst aussen vor. Ihnen ein Recht zu geben,
 * das erst bei einer Reaktivierung wirkt, waere eine stille Vorabfreigabe.
 *
 * Liefert die Anzahl der betroffenen Personen.
 */
export async function setzeGrundstufeFuerAlle(stufe: Stufe, von: string): Promise<number> {
  const gepruefteStufe = pruefeStufe(stufe);
  const db = getDb();

  const betroffene = await db
    .select({ jamaUserId: jamaBenutzer.jamaUserId })
    .from(jamaBenutzer)
    .where(eq(jamaBenutzer.aktiv, true));

  if (betroffene.length > 0) {
    await db
      .insert(personenvorgabe)
      .values(betroffene.map((zeile) => ({ jamaUserId: zeile.jamaUserId, grundstufe: gepruefteStufe })))
      .onConflictDoUpdate({
        target: personenvorgabe.jamaUserId,
        set: { grundstufe: gepruefteStufe },
      });
  }

  // Ein Eintrag fuer den ganzen Vorgang, nicht zweihundert. Wer spaeter sucht,
  // warum jemand plötzlich lesen darf, findet hier die eine Entscheidung.
  await recordAudit(
    {
      action: 'personen.grundstufe.alle',
      targetType: 'person',
      targetKey: 'alle',
      payload: { stufe: gepruefteStufe, betroffene: betroffene.length },
      result: 'ok',
    },
    { type: 'admin', name: von },
  );

  return betroffene.length;
}

export async function setzeGrundstufe(
  jamaUserId: number,
  stufe: Stufe,
  von: string,
): Promise<void> {
  pruefeNummer(jamaUserId, 'Die Benutzernummer');
  const gepruefteStufe = pruefeStufe(stufe);
  await pruefePersonBekannt(jamaUserId);

  await getDb()
    .insert(personenvorgabe)
    .values({ jamaUserId, grundstufe: gepruefteStufe })
    .onConflictDoUpdate({
      target: personenvorgabe.jamaUserId,
      set: { grundstufe: gepruefteStufe },
    });

  await recordAudit(
    {
      action: 'personen.grundstufe',
      targetType: 'person',
      targetKey: String(jamaUserId),
      payload: { stufe: gepruefteStufe },
      result: 'ok',
    },
    { type: 'admin', name: von },
  );
}

/**
 * Ersetzt die gesamte Zuordnung einer Person in einem Vorgang.
 *
 * Loeschen und Neuschreiben liegen in derselben Transaktion. Ein Teilerfolg
 * waere hier schlimmer als ein Fehlschlag: bricht es nach dem Loeschen ab,
 * stuende die Person ohne jedes Recht da, und niemand haette einen Anhaltspunkt,
 * was vorher galt. Der Aufrufer schickt den gewuenschten Endzustand, nicht eine
 * Folge von Einzelschritten — so kann die Oberflaeche einen ganzen Baumzweig
 * auf einmal setzen, ohne Zwischenzustaende zu erzeugen.
 */
export async function setzeZuordnungMehrfach(
  jamaUserId: number,
  eintraege: Array<{ projectId: number; stufe: Stufe }>,
  von: string,
): Promise<void> {
  pruefeNummer(jamaUserId, 'Die Benutzernummer');
  await pruefePersonBekannt(jamaUserId);

  // Mehrfach genannte Projekte: der letzte Eintrag gewinnt. Ohne diese
  // Vereinheitlichung verletzte der Einfuegevorgang die Eindeutigkeit von
  // Person und Projekt und die ganze Aenderung schluege fehl.
  const gewuenscht = new Map<number, Stufe>();
  for (const eintrag of eintraege) {
    pruefeNummer(eintrag.projectId, 'Die Projektnummer');
    gewuenscht.set(eintrag.projectId, pruefeStufe(eintrag.stufe));
  }

  await pruefeProjekteBekannt([...gewuenscht.keys()]);

  const zuSetzen = [...gewuenscht.entries()].filter(([, stufe]) => stufe !== 'keine');
  const jetzt = new Date();

  await getDb().transaction(async (tx) => {
    await tx.delete(personenrechte).where(eq(personenrechte.jamaUserId, jamaUserId));

    if (zuSetzen.length > 0) {
      await tx.insert(personenrechte).values(
        zuSetzen.map(([projectId, stufe]) => ({
          jamaUserId,
          jamaProjectId: projectId,
          stufe,
          vergebenAm: jetzt,
          vergebenVon: von,
        })),
      );
    }
  });

  await recordAudit(
    {
      action: 'personen.zuordnung.ersetzt',
      targetType: 'person',
      targetKey: String(jamaUserId),
      payload: {
        anzahl: zuSetzen.length,
        lesen: zuSetzen.filter(([, stufe]) => stufe === 'lesen').map(([projectId]) => projectId),
        schreiben: zuSetzen
          .filter(([, stufe]) => stufe === 'schreiben')
          .map(([projectId]) => projectId),
      },
      result: 'ok',
    },
    { type: 'admin', name: von },
  );
}

/**
 * Die Person muss im Spiegel stehen.
 *
 * Nicht aus Datenbankgruenden — die Zuordnung traegt absichtlich keinen
 * Fremdschluessel —, sondern weil eine Zuordnung an eine unbekannte Nummer
 * niemand mehr zuordnen kann: sie erschiene in keiner Liste und liesse sich
 * ueber die Oberflaeche nie wieder entfernen.
 */
async function pruefePersonBekannt(jamaUserId: number): Promise<void> {
  const treffer = await getDb()
    .select({ jamaUserId: jamaBenutzer.jamaUserId })
    .from(jamaBenutzer)
    .where(eq(jamaBenutzer.jamaUserId, jamaUserId))
    .limit(1);

  if (treffer.length === 0) {
    throw new ServiceError(
      'VALIDATION',
      `Die Benutzernummer ${jamaUserId} steht nicht im Spiegel. Führe zuerst einen Abgleich mit Jama durch.`,
      404,
    );
  }
}

/** Aus demselben Grund wie bei der Person. */
async function pruefeProjekteBekannt(projectIds: number[]): Promise<void> {
  if (projectIds.length === 0) return;

  const treffer = await getDb()
    .select({ jamaProjectId: jamaProjekte.jamaProjectId })
    .from(jamaProjekte)
    .where(inArray(jamaProjekte.jamaProjectId, projectIds));

  const bekannt = new Set(treffer.map((zeile) => zeile.jamaProjectId));
  const fehlend = projectIds.filter((projectId) => !bekannt.has(projectId));

  if (fehlend.length > 0) {
    throw new ServiceError(
      'VALIDATION',
      `Diese Projektnummern stehen nicht im Spiegel: ${fehlend.join(', ')}. Führe zuerst einen Abgleich mit Jama durch.`,
      404,
    );
  }
}
