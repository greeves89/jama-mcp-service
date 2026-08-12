import { coreTools } from './tools/core.js';
import { traceTools } from './tools/trace.js';
import { writeTools } from './tools/write.js';
import { collabTools } from './tools/collab.js';
import { testTools } from './tools/test.js';
import { historyTools } from './tools/history.js';
import { fileTools, reviewTools } from './tools/review-files.js';
import type { ToolDefinition } from './types.js';
import type { Toolset } from '../shared/toolsets.js';

/**
 * Zentrales Verzeichnis aller Tools. Einzige Quelle der Wahrheit — der
 * MCP-Server, der Tool-Katalog im Admin und die Statistik greifen alle hierauf
 * zu, damit kein Tool irgendwo fehlt oder doppelt gefuehrt wird.
 */

export const allTools: ToolDefinition[] = [
  ...coreTools,
  ...traceTools,
  ...writeTools,
  ...collabTools,
  ...testTools,
  ...historyTools,
  ...reviewTools,
  ...fileTools,
];

const byName = new Map(allTools.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}

export function toolsForToolsets(toolsets: readonly Toolset[]): ToolDefinition[] {
  return allTools.filter((tool) => toolsets.includes(tool.toolset));
}

export function toolCountByToolset(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tool of allTools) {
    counts[tool.toolset] = (counts[tool.toolset] ?? 0) + 1;
  }
  return counts;
}

/** Uebersicht fuer den Tool-Katalog im Admin-Dashboard. */
export function toolCatalog(): Array<{
  name: string;
  title: string;
  toolset: string;
  description: string;
  mutating: boolean;
  destructive: boolean;
  labs: boolean;
  parameters: string[];
}> {
  return allTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    toolset: tool.toolset,
    description: tool.description,
    mutating: tool.mutating,
    destructive: tool.destructive === true,
    labs: tool.labs === true,
    parameters: Object.keys(tool.inputSchema),
  }));
}

// Doppelte Tool-Namen wuerden im MCP-Protokoll still das zuletzt registrierte
// gewinnen lassen — beim Start sofort auffallen zu lassen ist deutlich besser.
if (byName.size !== allTools.length) {
  const seen = new Set<string>();
  const duplicates = allTools
    .map((tool) => tool.name)
    .filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  throw new Error(`Doppelte Tool-Namen im Verzeichnis: ${[...new Set(duplicates)].join(', ')}`);
}
