import { GuardError } from '../shared/errors.js';
import type { ToolContext, ToolDefinition } from './types.js';
import { begruendung, darfAendern, darfLesen, istEingeschraenkt, type Rechtelage } from './rechte.js';

/**
 * Schutzschichten vor jedem Tool-Aufruf.
 *
 * Sie greifen in dieser Reihenfolge, weil jede Stufe die naechste ueberfluessig
 * machen kann und die guenstigste Pruefung zuerst laufen soll:
 *
 *   1. Abschaltung — ist das Tool instanzweit deaktiviert?
 *   2. Toolset    — hat dieser Key die Faehigkeit ueberhaupt?
 *   3. Read-only  — darf er schreiben (Key-Einstellung oder globale Notbremse)?
 *   4. Confirm    — hat der Aufrufer die Zerstoerung ausdruecklich bestaetigt?
 *   5. Rechtelage — darf er dieses konkrete Projekt anfassen (Sperrliste,
 *                   Zugangsfreigabe, Personenmatrix)?
 *
 * Die Rechtepruefung kommt zuletzt, weil sie als einzige einen Jama-Aufruf
 * kosten kann (Aufloesung eines Items auf sein Projekt). Die Personenmatrix
 * ist die dritte Stufe genau dieser Entscheidung und sitzt deshalb an
 * derselben Stelle und nicht als eigener Schritt davor: Sie beantwortet
 * dieselbe Frage — darf dieses Projekt angefasst werden — nur feiner.
 */

/**
 * Die Rechtelage eines Kontexts.
 *
 * Kontexte, die nicht ueber die MCP-Route entstehen (der Probelauf im Admin,
 * der Einzelplatzbetrieb aelterer Staende), tragen das Feld noch nicht. Fuer
 * sie wird die Lage aus den bestehenden Feldern abgeleitet: ohne Sperrliste
 * und mit abgeschalteter Matrix ergibt das exakt das bisherige Verhalten. So
 * laeuft keine Aufrufstelle versehentlich voellig ungeprueft — der Rueckfall
 * verschaerft nicht und lockert nicht.
 */
export function rechtelage(context: ToolContext): Rechtelage {
  return (
    context.rechte ?? {
      gesperrteProjektIds: [],
      allowedProjectIds: context.allowedProjectIds,
      readOnly: context.readOnly,
      person: { aktiv: false, erkannt: false, grundstufe: 'keine', lesen: [], schreiben: [] },
      beiUnbekannt: 'nur_lesen',
    }
  );
}

/**
 * Instanzweite Abschaltung. Im HTTP-Betrieb wird ein abgeschaltetes Tool gar
 * nicht erst registriert — diese Pruefung ist das Sicherheitsnetz fuer die
 * Wege, die daran vorbeifuehren: der Probelauf aus dem Admin und ein
 * MCP-Server, der laenger als die Cache-Dauer der Einstellungen offen steht.
 */
export function assertToolEnabled(tool: ToolDefinition, context: ToolContext): void {
  if (context.disabledTools.includes(tool.name)) {
    throw new GuardError(
      'TOOL_DISABLED',
      `Das Tool "${tool.name}" ist auf diesem Dienst abgeschaltet. Diese Entscheidung gilt instanzweit und laesst sich nur im Admin-Dashboard unter "Tools" zuruecknehmen.`,
      { tool: tool.name },
    );
  }
}

export function assertToolsetAllowed(tool: ToolDefinition, context: ToolContext): void {
  if (!context.toolsets.includes(tool.toolset)) {
    throw new GuardError(
      'TOOLSET_FORBIDDEN',
      `Das Tool "${tool.name}" gehoert zum Toolset "${tool.toolset}", das fuer diesen Zugang nicht freigeschaltet ist.`,
      { toolset: tool.toolset, allowed: context.toolsets },
    );
  }
}

/**
 * Schreibrecht des Zugangs und der Person.
 *
 * `args` ist nachgestellt und optional, damit die bestehenden Aufrufstellen mit
 * zwei Argumenten unveraendert weiterlaufen. Nur mit den Argumenten laesst sich
 * die Personenstufe projektgenau pruefen; ohne sie wird projektlos geprueft,
 * was bei aktiver Matrix immer noch jede Aenderung einer unbekannten Person
 * abweist.
 */
export function assertWriteAllowed(
  tool: ToolDefinition,
  context: ToolContext,
  args?: Record<string, unknown>,
): void {
  if (!tool.mutating) return;
  if (context.readOnly) {
    throw new GuardError(
      'READ_ONLY',
      `"${tool.name}" veraendert Daten in Jama. Dieser Zugang ist auf Lesen beschraenkt — entweder ist der API-Key als schreibgeschuetzt angelegt oder die globale Notbremse ist aktiv.`,
      { tool: tool.name },
    );
  }

  const lage = rechtelage(context);
  const projectId = typeof args?.projectId === 'number' ? args.projectId : undefined;
  if (darfAendern(projectId, lage)) return;

  // Der Code sagt, woran es lag: Wer das Projekt nicht einmal sehen darf,
  // bekommt denselben Code wie beim Lesen. Ein eigener Code an dieser Stelle
  // wuerde verraten, dass es das Projekt gibt und der Zugang es lediglich
  // nicht aendern darf. Bleibt das Lesen erlaubt, ist READ_ONLY die
  // zutreffende Auskunft: sichtbar, aber nicht aenderbar.
  const darfEsSehen = darfLesen(projectId, lage);

  // Ohne Projektbezug kommt die Ablehnung immer aus der Matrix — entweder ist
  // die Person unbekannt, oder sie hat nirgends Schreibrecht.
  const ohneProjekt = lage.person.erkannt
    ? 'Der aufrufenden Person ist kein Projekt zum Ändern zugeordnet.'
    : 'Die aufrufende Person konnte nicht zugeordnet werden; ohne Zuordnung sind Änderungen gesperrt.';

  const text =
    projectId === undefined
      ? `"${tool.name}" veraendert Daten in Jama. ${ohneProjekt}`
      : `"${tool.name}" veraendert Daten in Jama. ${begruendung(projectId, lage)}`;

  throw new GuardError(darfEsSehen ? 'READ_ONLY' : 'PROJECT_FORBIDDEN', text, {
    tool: tool.name,
    ...(projectId === undefined ? {} : { projectId }),
  });
}

export function assertConfirmed(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): void {
  if (!tool.destructive) return;
  if (args.confirm !== true) {
    context.audit({
      action: `${tool.name}.denied`,
      result: 'denied',
      message: 'Bestaetigung fehlte',
      payload: redactArgs(args),
    });
    throw new GuardError(
      'CONFIRM_REQUIRED',
      `"${tool.name}" loescht oder ueberschreibt Daten unwiderruflich. Der Aufruf benoetigt confirm: true. Bitte vorher mit dem Anwender ruecksprechen.`,
      { tool: tool.name },
    );
  }
}

/**
 * Prueft, ob dieses Projekt gelesen werden darf — ueber alle drei Stufen.
 *
 * Eine leere Zugangsfreigabe bedeutet weiterhin: keine zusaetzliche
 * Einschraenkung auf dieser Stufe. Es gelten die Berechtigungen des
 * hinterlegten Jama-Benutzers, die wir nie ausweiten.
 */
export function assertProjectAllowed(projectId: number | undefined, context: ToolContext): void {
  const lage = rechtelage(context);
  if (darfLesen(projectId, lage)) return;

  // Ohne Projektbezug kann die Pruefung nur an der Person scheitern; dann gibt
  // es auch keine Projektnummer, die man nennen koennte.
  if (projectId === undefined) {
    throw new GuardError(
      'PROJECT_FORBIDDEN',
      'Die aufrufende Person konnte nicht zugeordnet werden. Für diesen Zugang ist ohne Zuordnung kein Zugriff möglich.',
      {},
    );
  }

  // Die Liste der freigegebenen Projekte steht nur dann in der Meldung, wenn
  // die Zugangsfreigabe der Grund war: Wer an der Sperrliste oder an der
  // Personenmatrix scheitert, soll daraus nichts ueber den Zuschnitt des
  // Zugangs schliessen koennen.
  const freigabeWarDerGrund =
    lage.allowedProjectIds.length > 0 &&
    !lage.allowedProjectIds.includes(projectId) &&
    !lage.gesperrteProjektIds.includes(projectId);

  const text = freigabeWarDerGrund
    ? `${begruendung(projectId, lage)} Freigegeben sind: ${lage.allowedProjectIds.join(', ')}.`
    : begruendung(projectId, lage);

  throw new GuardError('PROJECT_FORBIDDEN', text, {
    projectId,
    ...(freigabeWarDerGrund ? { allowed: lage.allowedProjectIds } : {}),
  });
}

/**
 * Filtert eine Ergebnisliste auf die erlaubten Projekte. Wird gebraucht, wo
 * Jama projektuebergreifend antwortet (etwa bei der Suche ueber abstractitems
 * ohne Projektfilter) — sonst wuerde die Allowlist dort wirkungslos bleiben.
 */
export function filterByAllowedProjects<T extends { project?: number }>(
  items: T[],
  context: ToolContext,
): { items: T[]; removed: number } {
  const lage = rechtelage(context);
  if (!istEingeschraenkt(lage)) return { items, removed: 0 };
  const allowed = items.filter((item) => darfLesen(item.project, lage));
  return { items: allowed, removed: items.length - allowed.length };
}

/**
 * Prueft die Projektfreigabe, ohne abzubrechen.
 *
 * Gebraucht dort, wo ein gesperrtes Element nicht zum Fehler fuehren soll,
 * sondern gekennzeichnet werden muss — etwa in einer Nachweiskette, in der ein
 * fehlender Knoten eine Luecke vortaeuschen wuerde, die es gar nicht gibt.
 */
export function istProjektErlaubt(projectId: number | undefined, context: ToolContext): boolean {
  return darfLesen(projectId, rechtelage(context));
}

/**
 * Meldet die Trefferzahl so, wie sie nach der Projektfilterung noch gilt.
 *
 * Jama zaehlt vor der Filterung. Wuerde diese Zahl unveraendert
 * weitergereicht, liesse sich daraus ablesen, wie viele Treffer es in
 * gesperrten Projekten gibt — eine Suche nach einem Kundennamen oder einem
 * Stichwort wuerde dessen Vorkommen in fremden Projekten verraten, ohne dass
 * ein einziges Item sichtbar wird. Fuer einen beschraenkten Zugang zaehlt
 * deshalb nur, was er auch sehen darf.
 *
 * Massgeblich ist dafuer jede Einschraenkung, nicht nur die Zugangsfreigabe:
 * Auch eine Sperrliste oder eine Personenzuordnung filtert Treffer heraus, und
 * die ungefilterte Zahl wuerde genau das verraten, was sie verbergen soll.
 */
export function sichtbareTrefferzahl(
  gesamtLautJama: number,
  sichtbar: number,
  context: ToolContext,
): number {
  return istEingeschraenkt(rechtelage(context)) ? sichtbar : gesamtLautJama;
}

const SECRET_KEYS = /pass|secret|token|key|pin|credential/i;

/** Entfernt Geheimnisse aus Aufrufparametern, bevor sie ins Audit-Log gehen. */
export function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEYS.test(key)) {
      result[key] = '[redigiert]';
      continue;
    }
    if (typeof value === 'string' && value.length > 500) {
      // Lange Freitexte (Beschreibungen) gehoeren nicht vollstaendig ins Audit —
      // sie koennen vertrauliche Spezifikationsinhalte enthalten.
      result[key] = `${value.slice(0, 200)}… (${value.length} Zeichen)`;
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactArgs(value as Record<string, unknown>);
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function runGuards(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ToolContext,
): void {
  assertToolEnabled(tool, context);
  assertToolsetAllowed(tool, context);
  assertWriteAllowed(tool, context, args);
  assertConfirmed(tool, args, context);

  // Rechte-Guard, soweit das Projekt direkt in den Argumenten steht. Tools, die
  // erst ueber eine Item-ID auf das Projekt schliessen, rufen
  // assertProjectAllowed spaeter selbst auf.
  //
  // Bewusst auch ohne Projekt aufgerufen: Bei aktiver Matrix mit unbekannter
  // Person und der Vorgabe "ablehnen" ist der Zugriff als Ganzes zu, nicht nur
  // der auf ein bestimmtes Projekt. Solange die Matrix aus ist oder "nur_lesen"
  // gilt, ist dieser Aufruf wirkungslos — das Verhalten bleibt unveraendert.
  const projectId = args.projectId;
  assertProjectAllowed(typeof projectId === 'number' ? projectId : undefined, context);
}
