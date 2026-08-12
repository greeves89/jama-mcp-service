import { GuardError } from '../shared/errors.js';
import type { ToolContext, ToolDefinition } from './types.js';

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
 *   5. Projekt    — darf er dieses konkrete Projekt anfassen?
 *
 * Die Projektpruefung kommt zuletzt, weil sie als einzige einen Jama-Aufruf
 * kosten kann (Aufloesung eines Items auf sein Projekt).
 */

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

export function assertWriteAllowed(tool: ToolDefinition, context: ToolContext): void {
  if (!tool.mutating) return;
  if (context.readOnly) {
    throw new GuardError(
      'READ_ONLY',
      `"${tool.name}" veraendert Daten in Jama. Dieser Zugang ist auf Lesen beschraenkt — entweder ist der API-Key als schreibgeschuetzt angelegt oder die globale Notbremse ist aktiv.`,
      { tool: tool.name },
    );
  }
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
 * Prueft eine Projekt-Allowlist. Eine leere Liste bedeutet: keine zusaetzliche
 * Einschraenkung — es gelten weiterhin die Berechtigungen des hinterlegten
 * Jama-Benutzers, die wir nie ausweiten.
 */
export function assertProjectAllowed(projectId: number | undefined, context: ToolContext): void {
  if (context.allowedProjectIds.length === 0) return;
  if (projectId === undefined) return;
  if (!context.allowedProjectIds.includes(projectId)) {
    throw new GuardError(
      'PROJECT_FORBIDDEN',
      `Projekt ${projectId} ist fuer diesen Zugang nicht freigegeben. Freigegeben sind: ${context.allowedProjectIds.join(', ')}.`,
      { projectId, allowed: context.allowedProjectIds },
    );
  }
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
  if (context.allowedProjectIds.length === 0) return { items, removed: 0 };
  const allowed = items.filter(
    (item) => item.project === undefined || context.allowedProjectIds.includes(item.project),
  );
  return { items: allowed, removed: items.length - allowed.length };
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
  assertWriteAllowed(tool, context);
  assertConfirmed(tool, args, context);

  // Projekt-Guard, soweit das Projekt direkt in den Argumenten steht. Tools, die
  // erst ueber eine Item-ID auf das Projekt schliessen, rufen
  // assertProjectAllowed spaeter selbst auf.
  const projectId = args.projectId;
  if (typeof projectId === 'number') assertProjectAllowed(projectId, context);
}
