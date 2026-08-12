import { z } from 'zod';
import { defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed, filterByAllowedProjects } from '../guards.js';
import {
  buildMappingContext,
  collectItemTypeIds,
  toItemDetail,
  toItemSummary,
} from '../../jama/mapping.js';
import type {
  JamaFilter,
  JamaItem,
  JamaRelease,
  JamaTag,
  JamaUser,
} from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "core": Einstieg, Suche und Navigation.
 *
 * Diese Tools sind der Standardumfang jedes Zugangs. Besonderes Augenmerk liegt
 * auf jama_get_project_schema — ohne diesen Aufruf kann ein LLM weder wissen,
 * welche Felder ein ItemType hat, noch welche Picklist-Werte zulaessig sind,
 * und jeder Schreibversuch endet in einem 400.
 */

const whoami = defineTool({
  name: 'jama_whoami',
  toolset: 'core',
  title: 'Verbindung und Benutzer pruefen',
  description:
    'Liefert den angemeldeten Jama-Benutzer, dessen Lizenztyp, die erreichbare Instanz und die verfuegbaren API-Versionen. Guter erster Aufruf, um zu pruefen, ob die Verbindung steht und welche Faehigkeiten zur Verfuegung stehen.',
  inputSchema: {},
  mutating: false,
  handler: async (_args, context) => {
    const user = await context.client.currentUser();
    const notes: string[] = [];

    let capabilities;
    try {
      capabilities = await context.client.capabilities();
    } catch {
      notes.push('Die Versionsabfrage war nicht moeglich; die Verbindung selbst steht aber.');
    }

    if (user.licenseType && !/creator/i.test(user.licenseType)) {
      notes.push(
        `Lizenztyp "${user.licenseType}": Jama beschraenkt den REST-Zugriff auf Named-Creator-Lizenzen. Weitere Aufrufe koennen fehlschlagen.`,
      );
    }
    if (context.readOnly) {
      notes.push('Dieser Zugang ist auf Lesen beschraenkt — schreibende Tools sind gesperrt.');
    }
    if (context.allowedProjectIds.length > 0) {
      notes.push(`Zugriff ist auf die Projekte ${context.allowedProjectIds.join(', ')} begrenzt.`);
    }

    return {
      data: {
        instanz: context.client.http.baseUrl,
        benutzer: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username,
        benutzername: user.username,
        email: user.email,
        lizenztyp: user.licenseType,
        aktiv: user.active,
        apiVersionen: capabilities?.versions,
        zugang: {
          name: context.apiKeyName,
          toolsets: context.toolsets,
          nurLesend: context.readOnly,
          projekte: context.allowedProjectIds.length > 0 ? context.allowedProjectIds : 'alle',
        },
      },
      notes,
    };
  },
});

const listProjects = defineTool({
  name: 'jama_list_projects',
  toolset: 'core',
  title: 'Projekte auflisten',
  description:
    'Listet alle Jama-Projekte auf, die der hinterlegte Benutzer sehen darf. Optional nach Namensbestandteil filterbar. Ergebnis ist gecacht und kostet damit in der Regel keinen Aufruf gegen das Rate-Limit.',
  inputSchema: {
    contains: z
      .string()
      .optional()
      .describe('Filtert auf Projekte, deren Name diesen Text enthaelt (Gross-/Kleinschreibung egal).'),
    includeFolders: z
      .boolean()
      .default(false)
      .describe('Auch Projektordner mit ausgeben. Standard: nur echte Projekte.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const projects = await context.client.schema.getProjects();

    let filtered = projects.filter((project) => args.includeFolders || project.isFolder !== true);

    if (context.allowedProjectIds.length > 0) {
      filtered = filtered.filter((project) => context.allowedProjectIds.includes(project.id));
    }

    if (args.contains) {
      const needle = args.contains.toLowerCase();
      filtered = filtered.filter((project) =>
        String(project.fields?.name ?? '').toLowerCase().includes(needle),
      );
    }

    return {
      data: filtered.map((project) => ({
        id: project.id,
        name: project.fields?.name,
        projectKey: project.projectKey ?? project.fields?.projectKey,
        istOrdner: project.isFolder === true ? true : undefined,
        beschreibung: project.fields?.description
          ? String(project.fields.description).slice(0, 200)
          : undefined,
      })),
      notes:
        filtered.length === 0
          ? ['Keine Projekte gefunden. Moeglicherweise fehlen dem Jama-Benutzer die Berechtigungen.']
          : undefined,
    };
  },
});

const getProjectSchema = defineTool({
  name: 'jama_get_project_schema',
  toolset: 'core',
  title: 'Schema eines Projekts abrufen',
  description:
    'Liefert die verfuegbaren ItemTypes mit ihren Feldern, Pflichtangaben und zulaessigen Picklist-Werten sowie die Beziehungstypen. DIESEN AUFRUF IMMER VOR DEM ANLEGEN ODER AENDERN VON ITEMS AUSFUEHREN: Custom Fields tragen ein Suffix wie "priority$32", und Picklist-Felder akzeptieren nur definierte Werte. Ohne dieses Wissen scheitert jeder Schreibvorgang mit einem 400.',
  inputSchema: {
    projectId: z
      .number()
      .int()
      .optional()
      .describe('Projekt-ID. Ohne Angabe werden alle ItemTypes der Instanz geliefert.'),
    itemTypeKeys: z
      .array(z.string())
      .optional()
      .describe(
        'Auf bestimmte ItemTypes einschraenken, per typeKey (z. B. "REQ") oder Anzeigename. Ohne Angabe werden alle geliefert — bei grossen Instanzen kann das umfangreich werden.',
      ),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);

    const types = await context.client.schema.getItemTypes();

    let selected = types;
    if (args.itemTypeKeys && args.itemTypeKeys.length > 0) {
      const needles = args.itemTypeKeys.map((key) => key.toLowerCase());
      selected = types.filter(
        (type) =>
          needles.includes((type.typeKey ?? '').toLowerCase()) ||
          needles.includes((type.display ?? '').toLowerCase()),
      );
      if (selected.length === 0) {
        return {
          data: {
            itemTypes: [],
            verfuegbareTypen: types.map((type) => ({ key: type.typeKey, name: type.display })),
          },
          notes: [
            'Kein ItemType passte auf die Angabe. Die verfuegbaren Typen stehen unter "verfuegbareTypen".',
          ],
        };
      }
    }

    const described = [];
    for (const type of selected) {
      const description = await context.client.schema.describeItemType(type.id);
      if (description) described.push(description);
    }

    const relationshipTypes = await context.client.schema.getRelationshipTypes();

    return {
      data: {
        itemTypes: described,
        beziehungstypen: relationshipTypes.map((type) => ({
          id: type.id,
          name: type.name ?? type.label,
          vonLabel: type.fromLabel,
          nachLabel: type.toLabel,
          standard: type.default,
        })),
      },
      projectId: args.projectId,
      notes: [
        'Felder mit readOnly: true koennen nicht geschrieben werden. Bei Picklist-Feldern die Werte aus "options" verwenden — der Service loest sie beim Schreiben selbst auf die internen IDs auf.',
      ],
    };
  },
});

const searchItems = defineTool({
  name: 'jama_search_items',
  toolset: 'core',
  title: 'Items suchen',
  description:
    'Durchsucht Items ueber die Jama-Volltextsuche (abstractitems). Unterstuetzt Lucene-Syntax im Feld "contains", etwa "name:Bremsdruck" oder "name:*druck". Mehrere Werte im selben Feld werden mit ODER verknuepft, verschiedene Felder mit UND. Liefert eine kompakte Trefferliste; Details danach ueber jama_get_item.',
  inputSchema: {
    projectId: z.number().int().optional().describe('Auf ein Projekt einschraenken.'),
    contains: z
      .string()
      .optional()
      .describe(
        'Suchbegriff. Lucene-Syntax moeglich: "name:Bremse" sucht nur im Namen, "*" als Platzhalter. Ohne Feldangabe wird ueber Name und Beschreibung gesucht.',
      ),
    documentKey: z
      .string()
      .optional()
      .describe('Genauen Document Key suchen, z. B. "PROJ-REQ-42".'),
    itemTypeIds: z
      .array(z.number().int())
      .optional()
      .describe('Auf bestimmte ItemTypes einschraenken (IDs aus jama_get_project_schema).'),
    releaseId: z.number().int().optional().describe('Auf ein Release einschraenken.'),
    modifiedAfter: z
      .string()
      .optional()
      .describe('Nur Items, die nach diesem Zeitpunkt geaendert wurden (ISO 8601, z. B. "2026-08-01").'),
    createdAfter: z
      .string()
      .optional()
      .describe('Nur Items, die nach diesem Zeitpunkt angelegt wurden (ISO 8601).'),
    sortBy: z
      .string()
      .optional()
      .describe('Sortierung, z. B. "modifiedDate.desc" oder "documentKey.asc".'),
    limit: z.number().int().min(1).max(200).default(25).describe(PAGINATION_DESCRIPTION),
    startAt: z.number().int().min(0).default(0).describe('Versatz fuer das Blaettern.'),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);

    if (!args.contains && !args.documentKey && args.projectId === undefined) {
      throw new ServiceError(
        'VALIDATION',
        'Die Suche braucht mindestens ein Kriterium: projectId, contains oder documentKey. Eine unbegrenzte Suche ueber die gesamte Instanz waere fuer das Rate-Limit zu teuer.',
        400,
      );
    }

    const query: Record<string, string | number | (string | number)[] | undefined> = {
      project: args.projectId,
      contains: args.contains,
      documentKey: args.documentKey,
      itemType: args.itemTypeIds,
      release: args.releaseId,
      sortBy: args.sortBy,
    };

    // Jama interpretiert einen einzelnen Datumswert als "ab diesem Zeitpunkt".
    if (args.modifiedAfter) query.modifiedDate = args.modifiedAfter;
    if (args.createdAfter) query.createdDate = args.createdAfter;

    const { items, total, nextStartAt } = await context.client.http.paginate<JamaItem>(
      'abstractitems',
      { query, limit: args.limit, startAt: args.startAt },
    );

    const { items: allowed, removed } = filterByAllowedProjects(items, context);
    const mapping = await buildMappingContext(
      context.client.schema,
      collectItemTypeIds(allowed),
    );

    const notes: string[] = [];
    if (removed > 0) {
      notes.push(`${removed} Treffer wurden ausgeblendet, weil ihr Projekt nicht freigegeben ist.`);
    }
    if (nextStartAt !== undefined) {
      notes.push(
        `Weitere Treffer verfuegbar. Naechster Aufruf mit startAt: ${nextStartAt} (insgesamt ${total}).`,
      );
    }

    return {
      data: {
        treffer: allowed.map((item) => toItemSummary(item, mapping)),
        gesamt: total,
        naechsterStartAt: nextStartAt,
      },
      projectId: args.projectId,
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const getItem = defineTool({
  name: 'jama_get_item',
  toolset: 'core',
  title: 'Item im Detail abrufen',
  description:
    'Liefert ein einzelnes Item mit allen Feldern. Rich-Text wird nach Markdown konvertiert und Picklist-Werte werden in Klartext aufgeloest. Angabe wahlweise per numerischer ID oder per Document Key.',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Document Key, z. B. "PROJ-REQ-42".'),
    maxDescriptionChars: z
      .number()
      .int()
      .min(200)
      .max(50_000)
      .default(8000)
      .describe('Obergrenze fuer die Beschreibung. Laengere Texte werden mit Hinweis gekuerzt.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds([item]));
    const detail = toItemDetail(item, mapping, {
      maxDescriptionChars: args.maxDescriptionChars,
    });

    return { data: detail, projectId: item.project };
  },
});

const getItemsBatch = defineTool({
  name: 'jama_get_items_batch',
  toolset: 'core',
  title: 'Mehrere Items abrufen',
  description:
    'Holt mehrere Items in einem Tool-Aufruf. Deutlich sparsamer als viele Einzelaufrufe von jama_get_item, sowohl beim Rate-Limit als auch beim Kontextverbrauch. Die Beschreibungen werden staerker gekuerzt als beim Einzelabruf.',
  inputSchema: {
    itemIds: z
      .array(z.number().int())
      .min(1)
      .max(50)
      .describe('Bis zu 50 Item-IDs. Jede ID kostet einen Aufruf gegen das Rate-Limit.'),
    maxDescriptionChars: z
      .number()
      .int()
      .min(0)
      .max(20_000)
      .default(1500)
      .describe('Obergrenze je Beschreibung. 0 laesst die Beschreibungen ganz weg.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const items: JamaItem[] = [];
    const fehlend: number[] = [];

    for (const itemId of args.itemIds) {
      const item = await context.client.http.getOptional<JamaItem>(`items/${itemId}`);
      if (!item) {
        fehlend.push(itemId);
        continue;
      }
      try {
        assertProjectAllowed(item.project, context);
        items.push(item);
      } catch {
        fehlend.push(itemId);
      }
    }

    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(items));
    const notes: string[] = [];
    if (fehlend.length > 0) {
      notes.push(
        `Nicht geliefert (unbekannt oder nicht freigegeben): ${fehlend.join(', ')}.`,
      );
    }

    return {
      data: items.map((item) =>
        args.maxDescriptionChars === 0
          ? toItemSummary(item, mapping)
          : toItemDetail(item, mapping, { maxDescriptionChars: args.maxDescriptionChars }),
      ),
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const browseTree = defineTool({
  name: 'jama_browse_tree',
  toolset: 'core',
  title: 'Projektstruktur durchsuchen',
  description:
    'Navigiert die Baumstruktur eines Projekts: liefert die direkten Kinder eines Items oder die oberste Ebene eines Projekts. Geeignet, um sich einen Ueberblick ueber den Aufbau zu verschaffen, ohne alle Items zu laden.',
  inputSchema: {
    projectId: z
      .number()
      .int()
      .optional()
      .describe('Projekt, dessen oberste Ebene geliefert werden soll.'),
    parentItemId: z
      .number()
      .int()
      .optional()
      .describe('Item, dessen direkte Kinder geliefert werden sollen.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(3)
      .default(1)
      .describe(
        'Wie viele Ebenen tief. Jede zusaetzliche Ebene loest je Knoten einen weiteren Aufruf aus — bei breiten Baeumen schnell teuer.',
      ),
    limitPerLevel: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe('Obergrenze der Kinder je Knoten.'),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);
    if (args.projectId === undefined && args.parentItemId === undefined) {
      throw new ServiceError(
        'VALIDATION',
        'Es muss entweder projectId oder parentItemId angegeben werden.',
        400,
      );
    }

    const loadChildren = async (itemId: number): Promise<JamaItem[]> => {
      const { items } = await context.client.http.paginate<JamaItem>(`items/${itemId}/children`, {
        limit: args.limitPerLevel,
      });
      return items;
    };

    let roots: JamaItem[];
    if (args.parentItemId !== undefined) {
      const parent = await context.client.http.getOptional<JamaItem>(`items/${args.parentItemId}`);
      if (!parent) {
        throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.parentItemId} existiert nicht.`, 404);
      }
      assertProjectAllowed(parent.project, context);
      roots = await loadChildren(args.parentItemId);
    } else {
      // Oberste Ebene: Items ohne uebergeordnetes Item im Projekt.
      const { items } = await context.client.http.paginate<JamaItem>('items', {
        query: { project: args.projectId, rootOnly: true },
        limit: args.limitPerLevel,
      });
      roots = items;
    }

    const collected = [...roots];
    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(collected));

    interface TreeNode {
      id: number;
      documentKey?: string;
      name: string;
      itemType?: string;
      sequence?: string;
      kinder?: TreeNode[];
    }

    const build = async (items: JamaItem[], remaining: number): Promise<TreeNode[]> => {
      const nodes: TreeNode[] = [];
      for (const item of items) {
        const summary = toItemSummary(item, mapping);
        const node: TreeNode = {
          id: summary.id,
          documentKey: summary.documentKey,
          name: summary.name,
          itemType: summary.itemType,
          sequence: summary.sequence,
        };
        if (remaining > 1) {
          const children = await loadChildren(item.id);
          if (children.length > 0) node.kinder = await build(children, remaining - 1);
        }
        nodes.push(node);
      }
      return nodes;
    };

    return {
      data: await build(roots, args.depth),
      projectId: args.projectId,
      notes:
        roots.length >= args.limitPerLevel
          ? [`Die Ebene wurde bei ${args.limitPerLevel} Eintraegen abgeschnitten.`]
          : undefined,
    };
  },
});

const runFilter = defineTool({
  name: 'jama_run_filter',
  toolset: 'core',
  title: 'Gespeicherten Filter ausfuehren',
  description:
    'Fuehrt einen in der Jama-Oberflaeche gespeicherten Filter aus. Sehr wirkungsvoll, weil Fachanwender dort komplexe Bedingungen pflegen, die sich ueber die Suche nur muehsam nachbauen liessen. Ohne filterId werden die verfuegbaren Filter aufgelistet.',
  inputSchema: {
    filterId: z.number().int().optional().describe('Auszufuehrender Filter. Ohne Angabe: Filter auflisten.'),
    projectId: z.number().int().optional().describe('Beim Auflisten auf ein Projekt einschraenken.'),
    countOnly: z
      .boolean()
      .default(false)
      .describe('Nur die Trefferzahl ermitteln, ohne die Items zu laden. Spart Aufrufe.'),
    limit: z.number().int().min(1).max(200).default(25).describe(PAGINATION_DESCRIPTION),
    startAt: z.number().int().min(0).default(0).describe('Versatz fuer das Blaettern.'),
  },
  mutating: false,
  handler: async (args, context) => {
    if (args.projectId !== undefined) assertProjectAllowed(args.projectId, context);

    if (args.filterId === undefined) {
      const { items } = await context.client.http.paginate<JamaFilter>('filters', {
        query: { project: args.projectId },
        limit: 100,
      });
      return {
        data: items.map((filter) => ({
          id: filter.id,
          name: filter.name,
          beschreibung: filter.description,
          projekt: filter.project,
          sichtbarkeit: filter.filterScope,
        })),
        projectId: args.projectId,
        notes: ['Zum Ausfuehren den gewuenschten Filter erneut mit filterId aufrufen.'],
      };
    }

    if (args.countOnly) {
      const response = await context.client.http.request<number | { count?: number }>(
        `filters/${args.filterId}/count`,
      );
      const count = typeof response.data === 'number' ? response.data : response.data?.count;
      return { data: { filterId: args.filterId, trefferzahl: count } };
    }

    const { items, total, nextStartAt } = await context.client.http.paginate<JamaItem>(
      `filters/${args.filterId}/results`,
      { limit: args.limit, startAt: args.startAt },
    );

    const { items: allowed, removed } = filterByAllowedProjects(items, context);
    const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(allowed));

    const notes: string[] = [];
    if (removed > 0) notes.push(`${removed} Treffer aus nicht freigegebenen Projekten entfernt.`);
    if (nextStartAt !== undefined) {
      notes.push(`Weitere Treffer verfuegbar — naechster Aufruf mit startAt: ${nextStartAt}.`);
    }

    return {
      data: {
        treffer: allowed.map((item) => toItemSummary(item, mapping)),
        gesamt: total,
        naechsterStartAt: nextStartAt,
      },
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const listReleases = defineTool({
  name: 'jama_list_releases',
  toolset: 'core',
  title: 'Releases auflisten',
  description: 'Liefert die Releases eines Projekts mit Datum und Aktivstatus.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    activeOnly: z.boolean().default(false).describe('Nur aktive Releases ausgeben.'),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);
    const { items } = await context.client.http.paginate<JamaRelease>('releases', {
      query: { project: args.projectId },
      limit: 200,
    });

    const filtered = args.activeOnly ? items.filter((release) => release.active !== false) : items;

    return {
      data: filtered.map((release) => ({
        id: release.id,
        name: release.name,
        beschreibung: release.description,
        releaseDatum: release.releaseDate,
        aktiv: release.active,
      })),
      projectId: args.projectId,
    };
  },
});

const listTags = defineTool({
  name: 'jama_list_tags',
  toolset: 'core',
  title: 'Tags auflisten',
  description:
    'Liefert die Tags eines Projekts. Mit tagId werden stattdessen die Items geliefert, die diesen Tag tragen.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    tagId: z
      .number()
      .int()
      .optional()
      .describe('Wenn gesetzt: die Items zu diesem Tag liefern statt der Tag-Liste.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    if (args.tagId !== undefined) {
      const { items, total } = await context.client.http.paginate<JamaItem>(
        `tags/${args.tagId}/items`,
        { limit: args.limit },
      );
      const { items: allowed } = filterByAllowedProjects(items, context);
      const mapping = await buildMappingContext(context.client.schema, collectItemTypeIds(allowed));
      return {
        data: { items: allowed.map((item) => toItemSummary(item, mapping)), gesamt: total },
        projectId: args.projectId,
      };
    }

    const { items } = await context.client.http.paginate<JamaTag>('tags', {
      query: { project: args.projectId },
      limit: 200,
    });

    return {
      data: items.map((tag) => ({ id: tag.id, name: tag.name })),
      projectId: args.projectId,
    };
  },
});

const listUsers = defineTool({
  name: 'jama_list_users',
  toolset: 'core',
  title: 'Benutzer auflisten',
  description:
    'Liefert die Jama-Benutzer, optional nach Name oder E-Mail gefiltert. Nuetzlich, um Zuweisungen aufzuloesen oder Verantwortliche zu ermitteln. Erfordert entsprechende Administrationsrechte in Jama.',
  inputSchema: {
    contains: z.string().optional().describe('Filtert auf Name, Benutzername oder E-Mail.'),
    activeOnly: z.boolean().default(true).describe('Nur aktive Benutzer ausgeben.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const users: JamaUser[] = await context.client.schema.getUsers();
    const needle = args.contains?.toLowerCase();

    const filtered = users
      .filter((user) => !args.activeOnly || user.active !== false)
      .filter((user) => {
        if (!needle) return true;
        return [user.firstName, user.lastName, user.username, user.email]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .slice(0, args.limit);

    return {
      data: filtered.map((user) => ({
        id: user.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(' '),
        benutzername: user.username,
        email: user.email,
        lizenztyp: user.licenseType,
        aktiv: user.active,
      })),
    };
  },
});

/**
 * Loest ein Item ueber ID oder Document Key auf. Der Umweg ueber die Suche beim
 * Document Key kostet einen zusaetzlichen Aufruf, ist aber der einzige Weg —
 * Jama bietet keinen direkten Zugriff per Key.
 */
export async function resolveItem(
  args: { itemId?: number; documentKey?: string },
  context: { client: { http: import('../../jama/http.js').JamaHttp } },
): Promise<JamaItem> {
  if (args.itemId !== undefined) {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) {
      throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    }
    return item;
  }

  if (args.documentKey) {
    const { items } = await context.client.http.paginate<JamaItem>('abstractitems', {
      query: { documentKey: args.documentKey },
      limit: 2,
    });
    const match = items[0];
    if (!match) {
      throw new ServiceError(
        'JAMA_NOT_FOUND',
        `Kein Item mit dem Document Key "${args.documentKey}" gefunden.`,
        404,
      );
    }
    return match;
  }

  throw new ServiceError('VALIDATION', 'Es muss itemId oder documentKey angegeben werden.', 400);
}

export const coreTools: ToolDefinition[] = [
  whoami,
  listProjects,
  getProjectSchema,
  searchItems,
  getItem,
  getItemsBatch,
  browseTree,
  runFilter,
  listReleases,
  listTags,
  listUsers,
] as unknown as ToolDefinition[];
