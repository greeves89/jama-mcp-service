/**
 * Gemeinsame Typen und Rechenhilfen der beiden Rechte-Seiten.
 *
 * Liegt bewusst neben dem API-Klienten und nicht in ihm: `Personen.tsx` und
 * `Zuordnung.tsx` teilen sich nicht nur die Typen, sondern auch den Aufbau des
 * Projektbaums und die Frage, welche Stufe an einem Projekt tatsaechlich gilt.
 * Zwei Kopien davon wuerden frueher oder spaeter auseinanderlaufen.
 */

export type Stufe = 'keine' | 'lesen' | 'schreiben';

export interface Personenzeile {
  jamaUserId: number;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  licenseType: string | null;
  aktiv: boolean;
  grundstufe: Stufe;
  anzahlZuordnungen: number;
  /** Fertig zusammengesetzter Name, wenn der Dienst ihn liefert. */
  name?: string | null;
}

export interface Projektzeile {
  jamaProjectId: number;
  projectKey: string | null;
  name: string | null;
  elternId: number | null;
  istOrdner: boolean;
  archiviert: boolean;
}

export interface Abgleichszahlen {
  neu: number;
  geaendert: number;
  verschwunden: number;
}

export interface Abgleichsergebnis {
  benutzer: Abgleichszahlen;
  projekte: Abgleichszahlen;
  dauerMs: number;
  warnungen: string[];
}

export interface Abgleichsstand {
  am: string | null;
  benutzer: number;
  projekte: number;
  /** Optional: laeuft gerade ein Abgleich im Hintergrund? */
  laeuft?: boolean;
  laeuftSeitMs?: number | null;
}

/**
 * Antwort auf einen angestossenen Abgleich.
 *
 * Ein Lauf ueber eine grosse Instanz kann laenger dauern, als eine HTTP-Antwort
 * offen bleiben sollte. Deshalb kann eine Antwort auch „angestossen, laeuft
 * weiter" bedeuten — dann fehlt das Ergebnis und es gibt nur einen Hinweis.
 */
export interface Abgleichsantwort {
  fertig: boolean;
  ergebnis: Abgleichsergebnis | null;
  hinweis: string | null;
}

export interface PersonMitZuordnung {
  person: Personenzeile;
  lesen: number[];
  schreiben: number[];
  grundstufe: Stufe;
}

/** Reihenfolge und Beschriftung der drei Stufen — ueberall dieselbe. */
export const STUFEN: ReadonlyArray<{ wert: Stufe; label: string }> = [
  { wert: 'keine', label: 'keine' },
  { wert: 'lesen', label: 'lesen' },
  { wert: 'schreiben', label: 'schreiben' },
];

export function stufeLabel(stufe: Stufe): string {
  return STUFEN.find((eintrag) => eintrag.wert === stufe)?.label ?? 'keine';
}

/** Anzeigename einer Person, mit Rueckfall auf Anmeldename und Nummer. */
export function anzeigename(person: Personenzeile): string {
  if (person.name && person.name.trim() !== '') return person.name.trim();
  const voll = [person.firstName, person.lastName].filter(Boolean).join(' ').trim();
  if (voll !== '') return voll;
  if (person.username) return person.username;
  return `Benutzer ${person.jamaUserId}`;
}

export function projektname(projekt: Projektzeile): string {
  return projekt.name?.trim() || projekt.projectKey || `Projekt ${projekt.jamaProjectId}`;
}

/**
 * Grob gerundete Zeitspanne in Worten. Bewusst ohne Bibliothek: das Dashboard
 * soll keine weitere Abhaengigkeit fuer eine Handvoll Zeilen mitschleppen.
 */
export function vorWieLange(zeitpunkt: string | null): string | null {
  if (!zeitpunkt) return null;
  const datum = new Date(zeitpunkt);
  if (Number.isNaN(datum.getTime())) return null;

  const sekunden = Math.round((Date.now() - datum.getTime()) / 1000);
  if (sekunden < 0) return 'gerade eben';
  if (sekunden < 60) return 'vor wenigen Sekunden';

  const minuten = Math.round(sekunden / 60);
  if (minuten < 60) return minuten === 1 ? 'vor einer Minute' : `vor ${minuten} Minuten`;

  const stunden = Math.round(minuten / 60);
  if (stunden < 24) return stunden === 1 ? 'vor einer Stunde' : `vor ${stunden} Stunden`;

  const tage = Math.round(stunden / 24);
  if (tage < 31) return tage === 1 ? 'vor einem Tag' : `vor ${tage} Tagen`;

  const monate = Math.round(tage / 30);
  return monate <= 1 ? 'vor einem Monat' : `vor ${monate} Monaten`;
}

export interface Projektknoten {
  projekt: Projektzeile;
  kinder: Projektknoten[];
  /** Verschachtelungstiefe, fuer die Einrueckung im Baum. */
  tiefe: number;
}

/**
 * Baut aus der flachen Liste den Baum ueber `elternId`.
 *
 * Zeigt ein Eintrag auf einen Ordner, den der Spiegel nicht kennt — etwa weil
 * er zwischen zwei Abgleichen verschwunden ist —, haengt er an der Wurzel statt
 * unsichtbar zu werden. Ein Projekt, das niemand sieht, kann auch niemand
 * zuordnen, und genau das waere hier der gefaehrlichere Fehler.
 */
export function baueBaum(projekte: Projektzeile[]): Projektknoten[] {
  const knoten = new Map<number, Projektknoten>();
  for (const projekt of projekte) {
    knoten.set(projekt.jamaProjectId, { projekt, kinder: [], tiefe: 0 });
  }

  const wurzeln: Projektknoten[] = [];
  for (const eintrag of knoten.values()) {
    const eltern =
      eintrag.projekt.elternId !== null && eintrag.projekt.elternId !== eintrag.projekt.jamaProjectId
        ? knoten.get(eintrag.projekt.elternId)
        : undefined;
    if (eltern) eltern.kinder.push(eintrag);
    else wurzeln.push(eintrag);
  }

  // Ein Ring in den Elternverweisen wuerde die Tiefenberechnung endlos laufen
  // lassen; besucht merkt sich deshalb jeden bereits eingeordneten Knoten.
  const besucht = new Set<number>();
  const sortiere = (liste: Projektknoten[], tiefe: number): Projektknoten[] => {
    const sauber = liste.filter((eintrag) => {
      if (besucht.has(eintrag.projekt.jamaProjectId)) return false;
      besucht.add(eintrag.projekt.jamaProjectId);
      return true;
    });
    sauber.sort((a, b) => {
      if (a.projekt.istOrdner !== b.projekt.istOrdner) return a.projekt.istOrdner ? -1 : 1;
      if (a.projekt.archiviert !== b.projekt.archiviert) return a.projekt.archiviert ? 1 : -1;
      return projektname(a.projekt).localeCompare(projektname(b.projekt), 'de');
    });
    for (const eintrag of sauber) {
      eintrag.tiefe = tiefe;
      eintrag.kinder = sortiere(eintrag.kinder, tiefe + 1);
    }
    return sauber;
  };

  return sortiere(wurzeln, 0);
}

/** Alle Projekt-Nummern eines Teilbaums, den Knoten selbst eingeschlossen. */
export function teilbaumIds(knoten: Projektknoten): number[] {
  const ids = [knoten.projekt.jamaProjectId];
  for (const kind of knoten.kinder) ids.push(...teilbaumIds(kind));
  return ids;
}

/**
 * Welche Stufe gilt an einem Projekt: die ausdrueckliche Zuordnung, sonst die
 * Grundstufe der Person. Die Unterscheidung ist kein Detail — wer sie nicht
 * sieht, haelt eine geerbte Freigabe fuer eine selbst gesetzte.
 */
export function geltendeStufe(
  projectId: number,
  ausdruecklich: Map<number, Stufe>,
  grundstufe: Stufe,
): { stufe: Stufe; geerbt: boolean } {
  const eigen = ausdruecklich.get(projectId);
  if (eigen !== undefined) return { stufe: eigen, geerbt: false };
  return { stufe: grundstufe, geerbt: true };
}
