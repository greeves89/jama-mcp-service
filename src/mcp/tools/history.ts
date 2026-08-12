import { z } from 'zod';
import { CONFIRM_DESCRIPTION, defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { buildMappingContext, collectItemTypeIds, itemName, toItemSummary } from '../../jama/mapping.js';
import { htmlToMarkdown, stripTags } from '../../jama/markdown.js';
import { resolveItem } from './core.js';
import type { JamaActivity, JamaBaseline, JamaItem, JamaVersion } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "history": Baselines, Versionen, Aktivitaeten.
 *
 * jama_compare_baselines ist das Kernstueck: Jama liefert zwei Bestandslisten,
 * aber keinen Vergleich. Den Diff feldweise auf Client-Seite zu bilden erspart
 * dem LLM, zwei vollstaendige Baselines im Kontext zu halten und selbst zu
 * vergleichen — was bei realen Groessen ohnehin scheitern wuerde.
 */

const listBaselines = defineTool({
  name: 'jama_list_baselines',
  toolset: 'history',
  title: 'Baselines auflisten',
  description: 'Liefert die Baselines eines Projekts mit Zeitpunkt und Ersteller.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);
    const { items, total } = await context.client.http.paginate<JamaBaseline>('baselines', {
      query: { project: args.projectId },
      limit: args.limit,
    });
    const userLabels = await context.client.schema.getUserLabels();

    return {
      data: {
        baselines: items.map((baseline) => ({
          id: baseline.id,
          name: baseline.name,
          beschreibung: baseline.description,
          erstelltAm: baseline.createdDate,
          erstelltVon:
            baseline.createdBy === undefined ? undefined : userLabels.get(baseline.createdBy),
        })),
        gesamt: total,
      },
      projectId: args.projectId,
    };
  },
});

const createBaseline = defineTool({
  name: 'jama_create_baseline',
  toolset: 'history',
  title: 'Baseline anlegen',
  description:
    'Erzeugt eine Baseline ueber einen Projektbereich und friert damit den aktuellen Stand ein. Nutzt einen labs-Endpoint, den Jama nicht mit einer Supportzusage versieht — bei aelteren Versionen kann der Aufruf fehlschlagen.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    name: z.string().min(1).describe('Name der Baseline.'),
    description: z.string().optional().describe('Beschreibung, etwa der Anlass.'),
    sourceItemId: z
      .number()
      .int()
      .optional()
      .describe('Ordner oder Set, das als Quelle dient. Ohne Angabe wird das ganze Projekt genommen.'),
  },
  mutating: true,
  labs: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const body: Record<string, unknown> = {
      project: args.projectId,
      name: args.name,
      description: args.description,
    };
    if (args.sourceItemId !== undefined) body.sourceItem = args.sourceItemId;

    const response = await context.client.http.request<{ id?: number } | number>('baselines', {
      method: 'POST',
      body,
      apiVersion: 'labs',
    });
    const id =
      typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

    context.audit({
      action: 'baseline.create',
      targetType: 'baseline',
      targetKey: String(id),
      payload: { projectId: args.projectId, name: args.name },
      result: 'ok',
    });

    return { data: { angelegt: true, baselineId: id, name: args.name }, projectId: args.projectId };
  },
});

const compareBaselines = defineTool({
  name: 'jama_compare_baselines',
  toolset: 'history',
  title: 'Baselines vergleichen',
  description:
    'Vergleicht zwei Baselines feldweise und liefert, was hinzugekommen, entfallen und geaendert ist. Der eigentliche Aenderungsbericht zwischen zwei Staenden — Jama selbst liefert nur die beiden Bestandslisten.',
  inputSchema: {
    baselineIdA: z.number().int().describe('Aeltere Baseline (Ausgangsstand).'),
    baselineIdB: z.number().int().describe('Neuere Baseline (Vergleichsstand).'),
    maxItems: z
      .number()
      .int()
      .min(10)
      .max(2000)
      .default(500)
      .describe('Obergrenze je Baseline. Jede Seite kostet Aufrufe gegen das Rate-Limit.'),
    ignoreFields: z
      .array(z.string())
      .default(['modifiedDate', 'lastActivityDate', 'modifiedBy'])
      .describe('Felder, deren Aenderung nicht als inhaltliche Aenderung zaehlt.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const load = async (baselineId: number) => {
      const { items, total } = await context.client.http.paginate<JamaItem>(
        `baselines/${baselineId}/versioneditems`,
        { limit: args.maxItems },
      );
      return { items, total };
    };

    const [a, b] = await Promise.all([load(args.baselineIdA), load(args.baselineIdB)]);

    const byKey = (items: JamaItem[]) => {
      const map = new Map<string, JamaItem>();
      for (const item of items) map.set(item.documentKey ?? String(item.id), item);
      return map;
    };

    const mapA = byKey(a.items);
    const mapB = byKey(b.items);
    const ignore = new Set(args.ignoreFields);

    const hinzugefuegt: unknown[] = [];
    const entfallen: unknown[] = [];
    const geaendert: Array<{
      documentKey: string;
      name: string;
      aenderungen: Array<{ feld: string; vorher: unknown; nachher: unknown }>;
    }> = [];

    const mapping = await buildMappingContext(
      context.client.schema,
      collectItemTypeIds([...a.items, ...b.items]),
    );

    for (const [key, item] of mapB) {
      if (!mapA.has(key)) {
        hinzugefuegt.push(toItemSummary(item, mapping));
      }
    }

    for (const [key, item] of mapA) {
      if (!mapB.has(key)) {
        entfallen.push(toItemSummary(item, mapping));
        continue;
      }

      const nachher = mapB.get(key);
      if (!nachher) continue;

      const aenderungen: Array<{ feld: string; vorher: unknown; nachher: unknown }> = [];
      const felder = new Set([
        ...Object.keys(item.fields ?? {}),
        ...Object.keys(nachher.fields ?? {}),
      ]);

      for (const feld of felder) {
        if (ignore.has(feld)) continue;
        const vorher = item.fields?.[feld];
        const neu = nachher.fields?.[feld];
        if (JSON.stringify(vorher) === JSON.stringify(neu)) continue;

        // Rich-Text auf Klartext reduzieren, sonst besteht der Diff aus Markup.
        const normalise = (value: unknown) =>
          typeof value === 'string' && /<[a-z][\s\S]*>/i.test(value)
            ? stripTags(value).slice(0, 300)
            : value;

        const vorherNorm = normalise(vorher);
        const nachherNorm = normalise(neu);
        if (JSON.stringify(vorherNorm) === JSON.stringify(nachherNorm)) continue;

        aenderungen.push({ feld, vorher: vorherNorm, nachher: nachherNorm });
      }

      if (aenderungen.length > 0) {
        geaendert.push({ documentKey: key, name: itemName(nachher), aenderungen });
      }
    }

    const notes: string[] = [];
    if (a.total > a.items.length || b.total > b.items.length) {
      notes.push(
        `Nicht vollstaendig verglichen: Baseline A hat ${a.total} Items (${a.items.length} geladen), Baseline B hat ${b.total} (${b.items.length} geladen). Fuer einen vollstaendigen Bericht maxItems erhoehen.`,
      );
    }
    if (hinzugefuegt.length === 0 && entfallen.length === 0 && geaendert.length === 0) {
      notes.push('Zwischen den beiden Baselines gibt es keine inhaltlichen Unterschiede.');
    }

    return {
      data: {
        baselineA: { id: args.baselineIdA, items: a.items.length },
        baselineB: { id: args.baselineIdB, items: b.items.length },
        zusammenfassung: {
          hinzugefuegt: hinzugefuegt.length,
          entfallen: entfallen.length,
          geaendert: geaendert.length,
        },
        hinzugefuegt,
        entfallen,
        geaendert,
      },
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const getItemHistory = defineTool({
  name: 'jama_get_item_history',
  toolset: 'history',
  title: 'Versionshistorie eines Items',
  description:
    'Liefert die Versionen eines Items mit Zeitpunkt und Bearbeiter. Mit compareVersions werden zwei Staende feldweise verglichen — die Grundlage fuer die Frage "wer hat wann was geaendert".',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Alternativ der Document Key.'),
    compareVersions: z
      .array(z.number().int())
      .length(2)
      .optional()
      .describe('Zwei Versionsnummern, die feldweise verglichen werden sollen.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    const { items: versions } = await context.client.http.paginate<JamaVersion>(
      `items/${item.id}/versions`,
      { limit: args.limit },
    );
    const userLabels = await context.client.schema.getUserLabels();

    const historie = versions.map((version) => ({
      version: version.versionNumber,
      am: version.createdDate,
      von: version.createdBy === undefined ? undefined : userLabels.get(version.createdBy),
      anlass: version.eventType,
    }));

    let vergleich;
    if (args.compareVersions) {
      const [numberA, numberB] = args.compareVersions as [number, number];
      const [a, b] = await Promise.all([
        context.client.http.getOptional<JamaItem>(`items/${item.id}/versions/${numberA}/versioneditem`),
        context.client.http.getOptional<JamaItem>(`items/${item.id}/versions/${numberB}/versioneditem`),
      ]);

      if (!a || !b) {
        throw new ServiceError(
          'JAMA_NOT_FOUND',
          'Mindestens eine der angegebenen Versionen existiert nicht.',
          404,
        );
      }

      const aenderungen: Array<{ feld: string; vorher: unknown; nachher: unknown }> = [];
      const felder = new Set([...Object.keys(a.fields ?? {}), ...Object.keys(b.fields ?? {})]);
      for (const feld of felder) {
        const vorher = a.fields?.[feld];
        const nachher = b.fields?.[feld];
        if (JSON.stringify(vorher) === JSON.stringify(nachher)) continue;
        const kuerzen = (value: unknown) =>
          typeof value === 'string' && /<[a-z][\s\S]*>/i.test(value)
            ? htmlToMarkdown(value).slice(0, 400)
            : value;
        aenderungen.push({ feld, vorher: kuerzen(vorher), nachher: kuerzen(nachher) });
      }
      vergleich = { von: numberA, nach: numberB, aenderungen };
    }

    return {
      data: {
        item: { id: item.id, documentKey: item.documentKey, name: itemName(item) },
        versionen: historie,
        vergleich,
      },
      projectId: item.project,
    };
  },
});

const getActivities = defineTool({
  name: 'jama_get_activities',
  toolset: 'history',
  title: 'Aktivitaeten abrufen',
  description:
    'Liefert den Aktivitaetsstrom eines Projekts oder eines Items: wer hat wann was geaendert, angelegt oder geloescht. Mit adminOnly werden stattdessen die administrativen Vorgaenge der Instanz geliefert.',
  inputSchema: {
    projectId: z.number().int().optional().describe('Projekt-ID.'),
    itemId: z.number().int().optional().describe('Auf ein einzelnes Item einschraenken.'),
    adminOnly: z
      .boolean()
      .default(false)
      .describe('Administrative Vorgaenge statt Projektaktivitaeten. Erfordert Adminrechte in Jama.'),
    since: z.string().optional().describe('Nur Aktivitaeten ab diesem Zeitpunkt (ISO 8601).'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);

    const path = args.adminOnly
      ? 'activities/adminActivity'
      : args.itemId !== undefined
        ? `items/${args.itemId}/activities`
        : 'activities';

    const query: Record<string, string | number | undefined> = {};
    if (!args.adminOnly && args.itemId === undefined) {
      if (args.projectId === undefined) {
        throw new ServiceError(
          'VALIDATION',
          'Fuer den Aktivitaetsstrom wird projectId oder itemId benoetigt.',
          400,
        );
      }
      query.project = args.projectId;
    }
    if (args.since) query.date = args.since;

    const { items, total } = await context.client.http.paginate<JamaActivity>(path, {
      query,
      limit: args.limit,
    });
    const userLabels = await context.client.schema.getUserLabels();

    return {
      data: {
        aktivitaeten: items.map((activity) => ({
          id: activity.id,
          aktion: activity.action,
          objektTyp: activity.objectType,
          am: activity.date,
          von: activity.user === undefined ? undefined : userLabels.get(activity.user),
          betroffeneItems: activity.associatedItems?.map((entry) => ({
            id: entry.id,
            documentKey: entry.documentKey,
            name: entry.name,
          })),
        })),
        gesamt: total,
      },
      projectId: args.projectId,
    };
  },
});

const restoreDeleted = defineTool({
  name: 'jama_restore_deleted',
  toolset: 'history',
  title: 'Geloeschte Items wiederherstellen',
  description:
    'Stellt die Items wieder her, die zu einer Loeschaktivitaet gehoeren. Die passende Aktivitaets-ID liefert jama_get_activities. Erfordert confirm: true, weil dabei Objekte in den aktuellen Stand zurueckkehren.',
  inputSchema: {
    activityId: z.number().int().describe('Aktivitaet, deren Loeschung rueckgaengig gemacht wird.'),
    confirm: z.boolean().default(false).describe(CONFIRM_DESCRIPTION),
  },
  mutating: true,
  destructive: true,
  handler: async (args, context) => {
    const betroffene = await context.client.http.getOptional<Array<{ id?: number; documentKey?: string }>>(
      `activities/${args.activityId}/affecteditems`,
    );

    await context.client.http.request(`activities/${args.activityId}/restore`, {
      method: 'POST',
    });

    context.audit({
      action: 'activity.restore',
      targetType: 'activity',
      targetKey: String(args.activityId),
      payload: { betroffene: betroffene?.length ?? 0 },
      result: 'ok',
    });

    return {
      data: {
        wiederhergestellt: true,
        activityId: args.activityId,
        items: betroffene?.map((entry) => ({ id: entry.id, documentKey: entry.documentKey })),
      },
    };
  },
});

export const historyTools: ToolDefinition[] = [
  listBaselines,
  createBaseline,
  compareBaselines,
  getItemHistory,
  getActivities,
  restoreDeleted,
] as unknown as ToolDefinition[];
