/**
 * Die reine Rechteberechnung.
 *
 * Bewusst ohne Datenbank, ohne Ein- und Ausgabe und ohne Uhrzeit: Dies ist die
 * einzige Stelle, an der ueber Sichtbarkeit entschieden wird, und genau deshalb
 * muss sie vollstaendig und wiederholbar pruefbar sein. Alles, was die
 * Entscheidung braucht, steht in der uebergebenen Lage.
 *
 * Die drei Stufen greifen in strikter Rangfolge und werden nicht miteinander
 * verrechnet. Es gibt keine Punktzahl, in der eine Zuordnung eine Sperre
 * ausgleichen koennte:
 *
 *   1. Sperrliste       — gilt immer und hebt nichts auf.
 *   2. Zugangsfreigabe  — die Obergrenze des Zugangs.
 *   3. Personenmatrix   — schraenkt innerhalb dieser Obergrenze weiter ein.
 *
 * Wer die Reihenfolge umdreht, baut eine Matrix, die die bestehende
 * Mandantengrenze aushebelt.
 */

export type Stufe = 'keine' | 'lesen' | 'schreiben';

export interface Personenlage {
  /** Wird die Matrix fuer diesen Zugang angewandt? */
  aktiv: boolean;
  /** Konnte die aufrufende Person zugeordnet werden? */
  erkannt: boolean;
  grundstufe: Stufe;
  lesen: number[];
  schreiben: number[];
}

export interface Rechtelage {
  gesperrteProjektIds: number[];
  allowedProjectIds: number[];
  readOnly: boolean;
  person: Personenlage;
  /** Was gilt, wenn die Matrix aktiv ist, die Person aber unbekannt bleibt. */
  beiUnbekannt: 'ablehnen' | 'nur_lesen';
}

/**
 * Stufe 1: Die Sperrliste trifft zu.
 *
 * Sie gilt auch fuer einen Zugang ganz ohne Einschraenkung — das ist ihr
 * eigentlicher Zweck: Bereiche, die ueber diese Anbindung niemand sehen soll.
 */
function trifftSperre(projectId: number | undefined, lage: Rechtelage): boolean {
  if (projectId === undefined) return false;
  return lage.gesperrteProjektIds.includes(projectId);
}

/**
 * Stufe 2: Das Projekt liegt ausserhalb der Zugangsfreigabe.
 *
 * Eine leere Freigabe bedeutet "keine zusaetzliche Einschraenkung ueber die
 * Jama-Rechte hinaus" — nicht "nichts erlaubt".
 */
function ausserhalbZugangsfreigabe(projectId: number | undefined, lage: Rechtelage): boolean {
  if (lage.allowedProjectIds.length === 0) return false;
  if (projectId === undefined) return false;
  return !lage.allowedProjectIds.includes(projectId);
}

/**
 * Stufe 3: Was die erkannte Person an genau diesem Projekt darf.
 *
 * Ein Projekt ohne eigenen Eintrag faellt auf die Grundstufe zurueck. Ohne sie
 * muessten alle Personen einzeln an allen Projekten geklickt werden, und genau
 * das fuehrt erfahrungsgemaess dazu, dass die Matrix nie gepflegt wird.
 *
 * Steht ein Projekt wider Erwarten in beiden Listen, gewinnt das Schreibrecht:
 * Die Datenbank laesst je Person und Projekt nur einen Eintrag zu, ein solcher
 * Zustand waere also bereits ein Datenfehler — und "schreiben" schliesst
 * "lesen" ohnehin ein.
 */
function wirkendeStufe(projectId: number, person: Personenlage): Stufe {
  if (person.schreiben.includes(projectId)) return 'schreiben';
  if (person.lesen.includes(projectId)) return 'lesen';
  return person.grundstufe;
}

/** Hat die Person ueberhaupt irgendwo Schreibrecht? */
function hatIrgendeinSchreibrecht(person: Personenlage): boolean {
  return person.grundstufe === 'schreiben' || person.schreiben.length > 0;
}

/**
 * Greift an diesem Zugang ueberhaupt eine Einschraenkung?
 *
 * Gebraucht dort, wo nicht die Erlaubnis selbst zaehlt, sondern ob gefiltert
 * werden muss — etwa bei der Trefferzahl einer Suche.
 */
export function istEingeschraenkt(lage: Rechtelage): boolean {
  return (
    lage.gesperrteProjektIds.length > 0 || lage.allowedProjectIds.length > 0 || lage.person.aktiv
  );
}

/**
 * Darf dieses Projekt gelesen werden?
 *
 * `projectId === undefined` heisst: Der Aufruf nennt kein Projekt. Dann greift
 * die Projektpruefung nicht — so wie heute auch. Die Personenpruefung greift
 * trotzdem, denn "ablehnen" bedeutet kein Zugriff, nicht kein Projektzugriff.
 */
export function darfLesen(projectId: number | undefined, lage: Rechtelage): boolean {
  if (trifftSperre(projectId, lage)) return false;
  if (ausserhalbZugangsfreigabe(projectId, lage)) return false;

  if (!lage.person.aktiv) return true;

  if (!lage.person.erkannt) {
    // Ohne Identitaet bleibt Lesen im Rahmen der Zugangsfreigabe moeglich.
    // Der Grund steht in src/mcp/aufrufer.ts: Die Benutzer-Kopfzeilen kommen
    // derzeit nicht bei jedem Client an. Waere die Vorgabe "ablehnen", wuerde
    // das Scharfschalten der Matrix den laufenden Betrieb lahmlegen.
    return lage.beiUnbekannt === 'nur_lesen';
  }

  // Erkannte Person ohne Projektbezug: Es gibt nichts zu pruefen. Solche
  // Aufrufe liefern Listen, deren Eintraege einzeln durch dieselbe Pruefung
  // laufen. Ein Nein an dieser Stelle wuerde jeder Person mit der Grundstufe
  // "keine" und gepflegten Einzelzuordnungen das Suchen unmoeglich machen,
  // ohne dabei irgendetwas zu schuetzen.
  if (projectId === undefined) return true;

  return wirkendeStufe(projectId, lage.person) !== 'keine';
}

/**
 * Darf dieses Projekt veraendert werden?
 *
 * Aufgebaut auf darfLesen, damit die Rangfolge nur an einer Stelle steht: Was
 * nicht sichtbar ist, kann auch nicht geaendert werden.
 */
export function darfAendern(projectId: number | undefined, lage: Rechtelage): boolean {
  // Der Schreibschutz des Zugangs steht ueber allem, was die Matrix erlaubt —
  // sie kann nur weiter einschraenken, nie lockern.
  if (lage.readOnly) return false;
  if (!darfLesen(projectId, lage)) return false;

  if (!lage.person.aktiv) return true;

  // Unbekannte Person: Jede Aenderung wird abgelehnt, und zwar auch ohne
  // Projektbezug. Andernfalls liesse sich die Matrix ueber jeden projektlosen
  // Schreibaufruf umgehen — es genuegte, das Projekt nicht zu nennen.
  if (!lage.person.erkannt) return false;

  if (projectId === undefined) {
    // Ohne Projekt laesst sich die Stufe nicht projektgenau bestimmen. Wer
    // nirgends Schreibrecht hat, darf hier trotzdem nichts: sonst waere das
    // Weglassen des Projekts erneut der offene Weg an der Matrix vorbei.
    return hatIrgendeinSchreibrecht(lage.person);
  }

  return wirkendeStufe(projectId, lage.person) === 'schreiben';
}

/**
 * Nennt in einem Satz, welche Stufe gegriffen hat.
 *
 * Der Satz geht in Fehlermeldungen und ins Audit-Log. Er benennt deshalb die
 * Stufe, verraet aber nie, ob es das Projekt ueberhaupt gibt: Ein Unterschied
 * zwischen "gesperrt" und "existiert nicht" waere ein Weg, die
 * Projektlandschaft fremder Mandanten abzutasten.
 */
export function begruendung(projectId: number, lage: Rechtelage): string {
  if (trifftSperre(projectId, lage)) {
    return `Projekt ${projectId} ist für diese Anbindung gesperrt.`;
  }
  if (ausserhalbZugangsfreigabe(projectId, lage)) {
    return `Projekt ${projectId} ist für diesen Zugang nicht freigegeben.`;
  }

  if (lage.person.aktiv && !lage.person.erkannt) {
    return lage.beiUnbekannt === 'ablehnen'
      ? 'Die aufrufende Person konnte nicht zugeordnet werden. Für diesen Zugang ist ohne Zuordnung kein Zugriff möglich.'
      : 'Die aufrufende Person konnte nicht zugeordnet werden. Ohne Zuordnung ist nur Lesen möglich, Änderungen sind gesperrt.';
  }

  if (lage.person.aktiv) {
    const stufe = wirkendeStufe(projectId, lage.person);
    if (stufe === 'keine') {
      return `Projekt ${projectId} ist der aufrufenden Person nicht zugeordnet.`;
    }
    if (stufe === 'lesen') {
      return `Projekt ${projectId} ist der aufrufenden Person nur lesend zugeordnet.`;
    }
  }

  if (lage.readOnly) {
    return `Dieser Zugang ist auf Lesen beschränkt; Projekt ${projectId} lässt sich darüber nicht ändern.`;
  }

  return `Projekt ${projectId} ist für diesen Zugang lesend und ändernd freigegeben.`;
}
