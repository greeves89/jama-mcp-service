import type { z, ZodRawShape } from 'zod';
import type { JamaClient } from '../jama/client.js';
import type { Toolset } from '../shared/toolsets.js';
import type { Aufrufer } from './aufrufer.js';
import type { Rechtelage } from './rechte.js';

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
  /**
   * Vollstaendige Rechtelage des Aufrufs: Sperrliste, Zugangsfreigabe und
   * Personenmatrix in ihrer Rangfolge. Sie ist ab hier die Grundlage aller
   * Guards; `allowedProjectIds` und `readOnly` bleiben daneben stehen, damit
   * nichts bricht, und werden spaeter aufgeraeumt.
   *
   * Optional, weil nicht jeder Kontext ueber die MCP-Route entsteht: Der
   * Probelauf im Admin baut seinen Kontext ueber buildToolContext, und diese
   * Datei darf dafuer nicht zum Zwangsumbau fremder Bausteine werden. Fehlt
   * das Feld, leiten die Guards die Lage aus den beiden Feldern darueber ab —
   * das ergibt exakt das bisherige Verhalten, nie ein weiteres Recht.
   */
  rechte?: Rechtelage;
  toolsets: Toolset[];
  /**
   * Instanzweit abgeschaltete Tools. Wirkt zusaetzlich zu den Toolsets und
   * gilt fuer alle Zugaenge gleichermassen.
   */
  disabledTools: string[];
  /** Antwortbudget in Token fuer diesen Aufruf. */
  tokenBudget: number;
  /**
   * Person, die den Aufruf ausgeloest hat, sofern der Client sie mitteilt.
   * Eine Auskunft, kein Nachweis — die Rechte haengen weiterhin am Key.
   */
  aufrufer?: Aufrufer;
  /**
   * Vermerkt jede Aenderung als Kommentar am Item. Kostet einen zusaetzlichen
   * Jama-Aufruf je Item und ist deshalb instanzweit abschaltbar.
   */
  vermerkeHerkunft: boolean;
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

/** Ein Bild, das als eigener Inhaltsblock an den Client geht. */
export interface ToolBild {
  /** Rohdaten base64-kodiert, ohne data:-Praefix. */
  data: string;
  mimeType: string;
  /** Woher es stammt — erscheint im Text, damit die Zuordnung erkennbar bleibt. */
  quelle: string;
}

export interface ToolResult {
  /** Wird als Text an den Client geliefert. Objekte werden als JSON serialisiert. */
  data: unknown;
  /**
   * Bilder, die zusaetzlich zum Text ausgeliefert werden.
   *
   * Sie gehen als eigene Inhaltsbloecke hinaus, nicht als Text: Ein Bild im
   * JSON waere eine base64-Zeichenkette, die das Modell nicht betrachten kann
   * und die allein durch ihre Laenge das Kontextfenster fuellt.
   */
  bilder?: ToolBild[];
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
