import type { z, ZodRawShape } from 'zod';
import type { JamaClient } from '../jama/client.js';
import type { Toolset } from '../shared/toolsets.js';

/**
 * Kontext, den jeder Tool-Aufruf erhaelt. Er traegt alles, was die Guards
 * brauchen — bewusst als Datenobjekt und nicht als globaler Zustand, damit
 * gleichzeitige Aufrufe verschiedener API-Keys sich nicht in die Quere kommen.
 */
export interface ToolContext {
  client: JamaClient;
  /** Fehlt bei stdio-Betrieb ohne Datenbank. */
  apiKeyId?: string;
  apiKeyName: string;
  /** Leer bedeutet: keine zusaetzliche Einschraenkung ueber die Jama-Rechte hinaus. */
  allowedProjectIds: number[];
  /** Kombination aus Key-Einstellung und globaler Notbremse. */
  readOnly: boolean;
  toolsets: Toolset[];
  /**
   * Instanzweit abgeschaltete Tools. Wirkt zusaetzlich zu den Toolsets und
   * gilt fuer alle Zugaenge gleichermassen.
   */
  disabledTools: string[];
  /** Antwortbudget in Token fuer diesen Aufruf. */
  tokenBudget: number;
  /** Wird von den Tools befuellt, damit der Aufruf im Audit-Log landet. */
  audit: (entry: AuditIntent) => void;
}

export interface AuditIntent {
  action: string;
  targetType?: string;
  targetKey?: string;
  payload?: Record<string, unknown>;
  result: 'ok' | 'error' | 'denied';
  message?: string;
}

export interface ToolResult {
  /** Wird als Text an den Client geliefert. Objekte werden als JSON serialisiert. */
  data: unknown;
  /** Zusaetzliche Hinweise, die dem LLM helfen, den naechsten Schritt zu waehlen. */
  notes?: string[];
  /** Projekt-ID fuer die Nutzungsstatistik. */
  projectId?: number;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  toolset: Toolset;
  title: string;
  description: string;
  inputSchema: Shape;
  /**
   * Veraendert das Tool Daten in Jama? Steuert den Read-only-Guard, das
   * Audit-Logging und die Annotation gegenueber dem MCP-Client.
   */
  mutating: boolean;
  /**
   * Kann der Aufruf Daten unwiederbringlich zerstoeren? Solche Tools verlangen
   * zusaetzlich ein ausdrueckliches confirm.
   */
  destructive?: boolean;
  /** Nutzt labs-Endpoints ohne Support-Zusage von Jama. */
  labs?: boolean;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, context: ToolContext) => Promise<ToolResult>;
}

/** Hilfsfunktion, die die Typinferenz der Shape erhaelt. */
export function defineTool<Shape extends ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition<Shape> {
  return definition;
}

/** Von allen Tools gemeinsam genutzte Eingabefelder. */
export const PAGINATION_DESCRIPTION =
  'Obergrenze der zurueckgelieferten Eintraege. Jama liefert maximal 50 pro Seite; hoehere Werte loesen mehrere Aufrufe aus und belasten das Rate-Limit der Instanz.';

export const CONFIRM_DESCRIPTION =
  'Muss ausdruecklich auf true gesetzt werden. Dieser Aufruf veraendert Daten unwiderruflich.';
