import { z } from 'zod';
import { defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { buildMappingContext, collectItemTypeIds, toItemSummary } from '../../jama/mapping.js';
import { resolveItem } from './core.js';
import type { JamaItem, JamaRelationship } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "trace": Traceability.
 *
 * Hier liegt der eigentliche Mehrwert gegenueber einem duennen API-Wrapper.
 * jama_trace_chain und jama_find_trace_gaps ersetzen jeweils Dutzende
 * Einzelaufrufe, die ein LLM sonst selbst orchestrieren muesste — mit
 * entsprechendem Risiko, in Zyklen zu laufen oder das Rate-Limit zu sprengen.
 */

const getRelationships = defineTool({
  name: 'jama_get_relationships',
  toolset: 'trace',
  title: 'Beziehungen eines Items abrufen',
  description:
    'Liefert die ein- und ausgehenden Beziehungen eines Items mit Beziehungstyp und Suspect-Kennzeichen. Grundlage jeder Auswirkungsanalyse: "Was haengt an dieser Anforderung?"',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Alternativ der Document Key.'),
    direction: z
      .enum(['upstream', 'downstream', 'both'])
      .default('both')
      .describe(
        'upstream: woraus leitet sich das Item ab. downstream: was leitet sich daraus ab. both: beides.',
      ),
    includeItemDetails: z
      .boolean()
      .default(true)
      .describe(
        'Namen und Document Keys der verknuepften Items mitliefern. Kostet je Richtung einen zusaetzlichen Aufruf, macht das Ergebnis aber erst lesbar.',
      ),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    const typeLabels = await context.client.schema.getRelationshipTypeLabels();
    const result: Record<string, unknown> = {
      item: { id: item.id, documentKey: item.documentKey },
    };

    const load = async (richtung: 'upstream' | 'downstream') => {
      const { items: relationships } = await context.client.http.paginate<JamaRelationship>(
        `items/${item.id}/${richtung}relationships`,
        { limit: args.limit },
      );

      if (!args.includeItemDetails) {
        return relationships.map((relationship) => ({
          beziehungsId: relationship.id,
          typ:
            relationship.relationshipType === undefined
              ? undefined
              : typeLabels.get(relationship.relationshipType),
          suspect: relationship.suspect,
          vonItem: relationship.fromItem,
          nachItem: relationship.toItem,
        }));
      }

      const { items: related } = await context.client.http.paginate<JamaItem>(
        `items/${item.id}/${richtung}related`,
        { limit: args.limit },
      );
      const mapping = await buildMappingContext(
        context.client.schema,
        collectItemTypeIds(related),
      );
      const byId = new Map(related.map((entry) => [entry.id, toItemSummary(entry, mapping)]));

      return relationships.map((relationship) => {
        const otherId = richtung === 'upstream' ? relationship.fromItem : relationship.toItem;
        return {
          beziehungsId: relationship.id,
          typ:
            relationship.relationshipType === undefined
              ? undefined
              : typeLabels.get(relationship.relationshipType),
          suspect: relationship.suspect,
          item: byId.get(otherId) ?? { id: otherId },
        };
      });
    };

    if (args.direction === 'upstream' || args.direction === 'both') {
      result.upstream = await load('upstream');
    }
    if (args.direction === 'downstream' || args.direction === 'both') {
      result.downstream = await load('downstream');
    }

    const suspects = [
      ...((result.upstream as { suspect?: boolean }[] | undefined) ?? []),
      ...((result.downstream as { suspect?: boolean }[] | undefined) ?? []),
    ].filter((entry) => entry.suspect === true).length;

    return {
      data: result,
      projectId: item.project,
      notes:
        suspects > 0
          ? [
              `${suspects} Beziehungen sind als "suspect" markiert — das verknuepfte Item wurde nach dem Setzen der Beziehung geaendert und die Verknuepfung sollte fachlich geprueft werden.`,
            ]
          : undefined,
    };
  },
});

const traceChain = defineTool({
  name: 'jama_trace_chain',
  toolset: 'trace',
  title: 'Traceability-Kette verfolgen',
  description:
    'Verfolgt die Verknuepfungskette ab einem Item ueber mehrere Ebenen, etwa von einer Stakeholder-Anforderung bis zum Testfall. Erkennt Zyklen und bricht bei Erreichen der Tiefe oder der Knotenzahl ab. Ersetzt Dutzende Einzelaufrufe.',
  inputSchema: {
    itemId: z.number().int().optional().describe('Startpunkt als numerische ID.'),
    documentKey: z.string().optional().describe('Startpunkt als Document Key.'),
    direction: z
      .enum(['upstream', 'downstream'])
      .default('downstream')
      .describe('Richtung der Verfolgung.'),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(6)
      .default(3)
      .describe(
        'Maximale Tiefe. Jede Ebene loest je Knoten einen Aufruf aus — bei stark verzweigten Ketten waechst das schnell.',
      ),
    maxNodes: z
      .number()
      .int()
      .min(5)
      .max(300)
      .default(80)
      .describe('Harte Obergrenze der besuchten Knoten, als Schutz vor Ausufern.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const start = await resolveItem(args, context);
    assertProjectAllowed(start.project, context);

    const typeLabels = await context.client.schema.getRelationshipTypeLabels();
    const visited = new Set<number>([start.id]);
    const collected: JamaItem[] = [start];

    interface ChainNode {
      id: number;
      documentKey?: string;
      tiefe: number;
      ueberBeziehung?: string;
      suspect?: boolean;
      kinder: ChainNode[];
    }

    let budget = args.maxNodes;
    let abgebrochen = false;
    let zyklen = 0;

    const walk = async (itemId: number, depth: number): Promise<ChainNode[]> => {
      if (depth >= args.maxDepth || budget <= 0) return [];

      const { items: relationships } = await context.client.http.paginate<JamaRelationship>(
        `items/${itemId}/${args.direction}relationships`,
        { limit: 50 },
      );

      const nodes: ChainNode[] = [];
      for (const relationship of relationships) {
        const nextId = args.direction === 'upstream' ? relationship.fromItem : relationship.toItem;

        if (visited.has(nextId)) {
          // Zyklus oder Mehrfachpfad — nicht erneut verfolgen, aber vermerken.
          zyklen += 1;
          nodes.push({
            id: nextId,
            tiefe: depth + 1,
            ueberBeziehung:
              relationship.relationshipType === undefined
                ? undefined
                : typeLabels.get(relationship.relationshipType),
            suspect: relationship.suspect,
            kinder: [],
          });
          continue;
        }

        if (budget <= 0) {
          abgebrochen = true;
          break;
        }

        visited.add(nextId);
        budget -= 1;

        const next = await context.client.http.getOptional<JamaItem>(`items/${nextId}`);
        if (next) collected.push(next);

        nodes.push({
          id: nextId,
          documentKey: next?.documentKey,
          tiefe: depth + 1,
          ueberBeziehung:
            relationship.relationshipType === undefined
              ? undefined
              : typeLabels.get(relationship.relationshipType),
          suspect: relationship.suspect,
          kinder: await walk(nextId, depth + 1),
        });
      }
      return nodes;
    };

    const tree = await walk(start.id, 0);
    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(collected));
    const byId = new Map(collected.map((item) => [item.id, toItemSummary(item, mapping)]));

    // Namen und Typen nachtragen, nachdem das Mapping fuer alle Knoten steht.
    const enrich = (nodes: ChainNode[]): unknown[] =>
      nodes.map((node) => {
        const summary = byId.get(node.id);
        return {
          id: node.id,
          documentKey: summary?.documentKey ?? node.documentKey,
          name: summary?.name,
          itemType: summary?.itemType,
          status: summary?.status,
          tiefe: node.tiefe,
          ueberBeziehung: node.ueberBeziehung,
          suspect: node.suspect,
          kinder: node.kinder.length > 0 ? enrich(node.kinder) : undefined,
        };
      });

    const notes: string[] = [];
    if (abgebrochen) {
      notes.push(
        `Die Verfolgung wurde bei ${args.maxNodes} Knoten abgebrochen. Fuer eine vollstaendige Sicht maxNodes erhoehen oder gezielter einsteigen.`,
      );
    }
    if (zyklen > 0) {
      notes.push(
        `${zyklen} bereits besuchte Knoten wurden nicht erneut verfolgt (Zyklus oder Mehrfachpfad).`,
      );
    }
    if (tree.length === 0) {
      notes.push(
        `Das Item hat keine ${args.direction === 'upstream' ? 'vorgelagerten' : 'nachgelagerten'} Verknuepfungen — das kann eine Traceability-Luecke sein.`,
      );
    }

    return {
      data: {
        start: byId.get(start.id),
        richtung: args.direction,
        kette: enrich(tree),
        besuchteKnoten: visited.size,
      },
      projectId: start.project,
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const traceMatrix = defineTool({
  name: 'jama_trace_matrix',
  toolset: 'trace',
  title: 'Traceability-Matrix erzeugen',
  description:
    'Erzeugt eine kompakte Zuordnungstabelle zwischen zwei ItemTypes eines Projekts, etwa Anforderungen zu Testfaellen. Liefert bewusst nur Schluessel und Namen statt vollstaendiger Items, damit auch grosse Matrizen ins Kontextfenster passen.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    sourceItemTypeId: z
      .number()
      .int()
      .describe('ItemType der Zeilen, z. B. Anforderungen (ID aus jama_get_project_schema).'),
    targetItemTypeId: z
      .number()
      .int()
      .optional()
      .describe('ItemType der Spalten. Ohne Angabe werden alle verknuepften Typen ausgegeben.'),
    direction: z.enum(['downstream', 'upstream']).default('downstream').describe('Blickrichtung.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(300)
      .default(100)
      .describe('Maximale Anzahl Zeilen. Jede Zeile kostet einen Aufruf gegen das Rate-Limit.'),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const { items: sources, total } = await context.client.http.paginate<JamaItem>('abstractitems', {
      query: { project: args.projectId, itemType: args.sourceItemTypeId },
      limit: args.limit,
    });

    if (sources.length === 0) {
      return {
        data: { zeilen: [] },
        projectId: args.projectId,
        notes: [`Im Projekt ${args.projectId} gibt es keine Items vom ItemType ${args.sourceItemTypeId}.`],
      };
    }

    const zeilen: Array<{
      id: number;
      documentKey?: string;
      name: string;
      verknuepft: Array<{ id: number; documentKey?: string; name?: string; itemType?: string }>;
    }> = [];

    const allRelated: JamaItem[] = [];
    const relatedByItem = new Map<number, JamaItem[]>();

    for (const source of sources) {
      const { items: related } = await context.client.http.paginate<JamaItem>(
        `items/${source.id}/${args.direction}related`,
        { limit: 50 },
      );
      const filtered =
        args.targetItemTypeId === undefined
          ? related
          : related.filter((item) => item.itemType === args.targetItemTypeId);
      relatedByItem.set(source.id, filtered);
      allRelated.push(...filtered);
    }

    const mapping = await buildMappingContext(
      context.client.schema,
      collectItemTypeIds([...sources, ...allRelated]),
    );

    let ohneVerknuepfung = 0;
    for (const source of sources) {
      const related = relatedByItem.get(source.id) ?? [];
      if (related.length === 0) ohneVerknuepfung += 1;
      const summary = toItemSummary(source, mapping);
      zeilen.push({
        id: summary.id,
        documentKey: summary.documentKey,
        name: summary.name,
        verknuepft: related.map((item) => {
          const target = toItemSummary(item, mapping);
          return {
            id: target.id,
            documentKey: target.documentKey,
            name: target.name,
            itemType: target.itemType,
          };
        }),
      });
    }

    const abdeckung =
      sources.length === 0
        ? 0
        : Math.round(((sources.length - ohneVerknuepfung) / sources.length) * 1000) / 10;

    const notes: string[] = [
      `Abdeckung: ${sources.length - ohneVerknuepfung} von ${sources.length} Items sind verknuepft (${abdeckung} Prozent).`,
    ];
    if (total > sources.length) {
      notes.push(
        `Es gibt ${total} Items dieses Typs; ausgewertet wurden die ersten ${sources.length}. Fuer eine vollstaendige Matrix limit erhoehen.`,
      );
    }

    return {
      data: { richtung: args.direction, zeilen, ohneVerknuepfung, abdeckungProzent: abdeckung },
      projectId: args.projectId,
      notes,
    };
  },
});

const findTraceGaps = defineTool({
  name: 'jama_find_trace_gaps',
  toolset: 'trace',
  title: 'Traceability-Luecken finden',
  description:
    'Findet Items eines Typs, die keine Verknuepfung in der geforderten Richtung besitzen — etwa Anforderungen ohne Testfall oder Sicherheitsanforderungen ohne Verifikation. Das zentrale Werkzeug fuer Nachweise nach ASPICE, ISO 26262 oder IEC 62304.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    itemTypeId: z
      .number()
      .int()
      .describe('Zu pruefender ItemType (ID aus jama_get_project_schema).'),
    direction: z
      .enum(['downstream', 'upstream'])
      .default('downstream')
      .describe('In welcher Richtung eine Verknuepfung vorhanden sein muss.'),
    requiredTargetItemTypeId: z
      .number()
      .int()
      .optional()
      .describe(
        'Wenn gesetzt: es zaehlt nur eine Verknuepfung auf genau diesen ItemType. So laesst sich etwa "jede Anforderung braucht einen Testfall" pruefen statt nur "irgendeine Verknuepfung".',
      ),
    contains: z
      .string()
      .optional()
      .describe('Vorfilter, etwa "name:Safety", um nur einen Teilbestand zu pruefen.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(300)
      .default(100)
      .describe('Maximale Anzahl gepruefter Items. Jedes Item kostet einen Aufruf.'),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const { items, total } = await context.client.http.paginate<JamaItem>('abstractitems', {
      query: { project: args.projectId, itemType: args.itemTypeId, contains: args.contains },
      limit: args.limit,
    });

    const luecken: JamaItem[] = [];
    const verknuepft: number[] = [];

    for (const item of items) {
      const { items: related } = await context.client.http.paginate<JamaItem>(
        `items/${item.id}/${args.direction}related`,
        { limit: 50 },
      );
      const passend =
        args.requiredTargetItemTypeId === undefined
          ? related
          : related.filter((entry) => entry.itemType === args.requiredTargetItemTypeId);

      if (passend.length === 0) luecken.push(item);
      else verknuepft.push(item.id);
    }

    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(items));
    const abdeckung =
      items.length === 0 ? 100 : Math.round((verknuepft.length / items.length) * 1000) / 10;

    const notes: string[] = [];
    if (total > items.length) {
      notes.push(
        `Geprueft wurden ${items.length} von ${total} Items. Die Aussage gilt nur fuer diesen Ausschnitt — fuer einen vollstaendigen Nachweis limit erhoehen oder in Teilmengen pruefen.`,
      );
    }
    if (luecken.length === 0) {
      notes.push('Alle geprueften Items haben die geforderte Verknuepfung.');
    }

    return {
      data: {
        geprueft: items.length,
        mitVerknuepfung: verknuepft.length,
        ohneVerknuepfung: luecken.length,
        abdeckungProzent: abdeckung,
        luecken: luecken.map((item) => toItemSummary(item, mapping)),
      },
      projectId: args.projectId,
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

/** Ein Regelwerk, so weit es fuer die Auswahl von Belang ist. */
export interface Regelwerk {
  standard: boolean;
  projekte: number[];
}

/**
 * Waehlt die Regelwerke aus, die fuer ein Projekt tatsaechlich gelten.
 *
 * Jama wendet nicht alle hinterlegten Regelwerke an, sondern das dem Projekt
 * zugeordnete — und nur wenn keines zugeordnet ist, das als Standard markierte.
 * Zuvor wurde ueber saemtliche Regelwerke der Instanz geprueft. Das ergab
 * Auskuenfte, die in beide Richtungen falsch sein konnten: "nicht zulaessig",
 * obwohl das Anlegen gelingt, weil die passende Regel in einem fremden
 * Regelwerk lag; und "zulaessig", obwohl Jama ablehnt, weil die gefundene Regel
 * fuer ein anderes Projekt gilt. Eine Vorpruefung, die in beide Richtungen irrt,
 * ist schaedlicher als gar keine: Automatisierungen ueberspringen dann zulaessige
 * Verknuepfungen oder laufen in vermeidbare Fehler.
 *
 * Ohne Projektangabe bleibt es bei allen Regelwerken — dann ist die Frage nicht
 * "gilt das hier?", sondern "was ist ueberhaupt hinterlegt?".
 */
export function regelwerkeFuerProjekt<T extends Regelwerk>(
  regelwerke: readonly T[],
  projektId: number | undefined,
): T[] {
  if (projektId === undefined) return [...regelwerke];

  const zugeordnet = regelwerke.filter((regelwerk) => regelwerk.projekte.includes(projektId));
  if (zugeordnet.length > 0) return zugeordnet;

  return regelwerke.filter((regelwerk) => regelwerk.standard);
}

const checkRelationshipRules = defineTool({
  name: 'jama_check_relationship_rules',
  toolset: 'trace',
  title: 'Beziehungsregeln pruefen',
  description:
    'Liefert die im Projekt hinterlegten Regelwerke fuer Beziehungen und prueft optional im Trockenlauf, ob eine geplante Verknuepfung zulaessig waere. Sinnvoll vor jama_create_relationship, weil Jama sonst mit einem wenig aussagekraeftigen 400 antwortet.',
  inputSchema: {
    projectId: z.number().int().optional().describe('Projekt, dessen Regelwerk interessiert.'),
    fromItemId: z.number().int().optional().describe('Geplante Quelle der Beziehung.'),
    toItemId: z.number().int().optional().describe('Geplantes Ziel der Beziehung.'),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);

    const { items: ruleSets } = await context.client.http.paginate<{
      id: number;
      name?: string;
      isDefault?: boolean;
      projects?: number[];
      rules?: Array<{ fromItemType?: number; toItemType?: number; relationshipType?: number }>;
    }>('relationshiprulesets', { limit: 100 });

    const itemTypes = await context.client.schema.getItemTypes();
    const typeName = (id?: number) =>
      id === undefined ? undefined : itemTypes.find((type) => type.id === id)?.display ?? String(id);
    const relationshipTypes = await context.client.schema.getRelationshipTypeLabels();

    const aufbereitet = ruleSets.map((ruleSet) => ({
      id: ruleSet.id,
      name: ruleSet.name,
      standard: ruleSet.isDefault === true,
      projekte: ruleSet.projects ?? [],
      regeln: (ruleSet.rules ?? []).map((rule) => ({
        von: typeName(rule.fromItemType),
        nach: typeName(rule.toItemType),
        beziehungstyp:
          rule.relationshipType === undefined
            ? undefined
            : relationshipTypes.get(rule.relationshipType),
      })),
    }));

    const geltendeRegelwerke = (projektId: number | undefined) =>
      regelwerkeFuerProjekt(aufbereitet, projektId);

    let trockenlauf;
    let hinweisRegelwerk: string | undefined;

    if (args.fromItemId !== undefined && args.toItemId !== undefined) {
      const [from, to] = await Promise.all([
        context.client.http.getOptional<JamaItem>(`items/${args.fromItemId}`),
        context.client.http.getOptional<JamaItem>(`items/${args.toItemId}`),
      ]);
      if (!from || !to) {
        throw new ServiceError(
          'JAMA_NOT_FOUND',
          'Mindestens eines der beiden Items existiert nicht.',
          404,
        );
      }
      assertProjectAllowed(from.project, context);
      assertProjectAllowed(to.project, context);

      // Massgeblich ist das Projekt der Quelle: dort entsteht die Beziehung.
      const massgeblich = geltendeRegelwerke(from.project);

      if (from.project !== to.project) {
        hinweisRegelwerk =
          'Die beiden Items liegen in verschiedenen Projekten. Geprueft wurde gegen das Regelwerk des Quellprojekts; bei projektuebergreifenden Beziehungen kann Jama zusaetzliche Einschraenkungen anwenden.';
      }

      const passende = massgeblich.flatMap((ruleSet) =>
        ruleSet.regeln
          .filter(
            (rule) => rule.von === typeName(from.itemType) && rule.nach === typeName(to.itemType),
          )
          .map((rule) => ({ ...rule, regelwerk: ruleSet.name ?? String(ruleSet.id) })),
      );

      trockenlauf = {
        von: { id: from.id, documentKey: from.documentKey, itemType: typeName(from.itemType) },
        nach: { id: to.id, documentKey: to.documentKey, itemType: typeName(to.itemType) },
        // Ohne geltendes Regelwerk schraenkt Jama nicht ein — dann ist alles
        // erlaubt, und ein "nicht zulaessig" waere schlicht falsch.
        zulaessig: massgeblich.length === 0 ? true : passende.length > 0,
        geprueftGegen:
          massgeblich.length === 0
            ? 'kein geltendes Regelwerk'
            : massgeblich.map((ruleSet) => ruleSet.name ?? String(ruleSet.id)).join(', '),
        passendeRegeln: passende,
      };
    }

    const hinweise: string[] = [];
    if (ruleSets.length === 0) {
      hinweise.push(
        'Es sind keine Regelwerke hinterlegt. Dann laesst Jama grundsaetzlich jede Verknuepfung zu.',
      );
    } else if (trockenlauf?.zulaessig === false) {
      hinweise.push(
        `Im geltenden Regelwerk (${trockenlauf.geprueftGegen}) gibt es fuer diese Kombination aus ItemTypes keine Regel. Ein Anlegen der Beziehung wuerde vermutlich mit einem 400 scheitern.`,
      );
    } else if (trockenlauf?.geprueftGegen === 'kein geltendes Regelwerk') {
      hinweise.push(
        'Diesem Projekt ist kein Regelwerk zugeordnet und es gibt kein Standardregelwerk. Jama schraenkt die Verknuepfung dann nicht ein.',
      );
    }
    if (hinweisRegelwerk) hinweise.push(hinweisRegelwerk);

    // Nur die tatsaechlich geltenden Regelwerke ausgeben, wenn ein Projekt
    // benannt ist. Die vollstaendige Liste der Instanz beantwortet eine andere
    // Frage und verstellt den Blick auf das, was hier gilt.
    const auszugeben =
      args.projectId !== undefined ? geltendeRegelwerke(args.projectId) : aufbereitet;

    return {
      data: {
        regelwerke: auszugeben,
        regelwerkeGesamt: aufbereitet.length,
        trockenlauf,
      },
      projectId: args.projectId,
      notes: hinweise.length > 0 ? hinweise : undefined,
    };
  },
});

export const traceTools: ToolDefinition[] = [
  getRelationships,
  traceChain,
  traceMatrix,
  findTraceGaps,
  checkRelationshipRules,
] as unknown as ToolDefinition[];
