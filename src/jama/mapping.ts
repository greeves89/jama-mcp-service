import { htmlToMarkdown, shorten } from './markdown.js';
import type { SchemaResolver } from './schema.js';
import type { JamaItem, JamaRelationship, JamaTestRun } from './types.js';

/**
 * Uebersetzt Jama-Rohobjekte in kompakte, selbsterklaerende Strukturen.
 *
 * Der Unterschied ist erheblich: ein rohes Item mit HTML-Description und
 * numerischen Picklist-Verweisen kostet leicht 3.000 Token und ist fuer das
 * Modell trotzdem halb unlesbar. Die aufbereitete Fassung kommt bei gleichem
 * Informationsgehalt mit einem Bruchteil aus.
 */

/** Felder, die in Listenansichten genuegen. */
export interface ItemSummary {
  id: number;
  documentKey?: string;
  name: string;
  itemType?: string;
  status?: string;
  project?: number;
  modifiedDate?: string;
  sequence?: string;
  /** Verweis auf das Item in der Jama-Oberflaeche. */
  url?: string;
}

export interface ItemDetail extends ItemSummary {
  globalId?: string;
  description?: string;
  createdDate?: string;
  lastActivityDate?: string;
  createdBy?: string;
  modifiedBy?: string;
  parentId?: number;
  locked?: boolean;
  fields: Record<string, unknown>;
}

const RICH_TEXT_FIELDS = new Set([
  'description',
  'body',
  'notes',
  'expectedResults',
  'testCaseSteps',
  'acceptanceCriteria',
]);

/** Felder, die in Listen nie interessieren und nur Platz kosten. */
const NOISE_FIELDS = new Set([
  'globalSortOrder',
  'sortOrder',
  'resources',
  'childItemType',
  'documentKeyPrefix',
]);

function fieldString(fields: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = fields?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Ermittelt den Anzeigenamen. Jama legt ihn meist unter fields.name ab, bei
 * manchen Typen aber unter einem Custom Field mit Suffix.
 */
export function itemName(item: JamaItem): string {
  const direct = fieldString(item.fields, 'name');
  if (direct) return direct;
  for (const [key, value] of Object.entries(item.fields ?? {})) {
    if (key.startsWith('name$') && typeof value === 'string') return value;
  }
  return item.documentKey ?? `Item ${item.id}`;
}

export interface MappingContext {
  schema: SchemaResolver;
  optionLabels: Map<number, string>;
  userLabels: Map<number, string>;
  itemTypeLabels: Map<number, string>;
  /** Adresse der Instanz, um Verweise auf Items zu bilden. */
  baseUrl: string;
}

/**
 * Baut den Verweis, unter dem ein Item in der Jama-Oberflaeche zu finden ist.
 *
 * Ohne diese Angabe stellt ein Sprachmodell die Adresse selbst zusammen und
 * raet dabei — mit Document Key statt der numerischen ID, ohne die
 * Projektangabe oder in einer Form, die es aus einer anderen Instanz kennt. Die
 * entstehenden Verweise sehen brauchbar aus und fuehren ins Leere.
 *
 * Jama erwartet die numerische API-ID im Fragment und die Projekt-ID als
 * Parameter. Der Document Key taugt dafuer nicht.
 */
export function itemUrl(
  baseUrl: string,
  itemId: number,
  projectId: number | undefined,
): string | undefined {
  if (!baseUrl) return undefined;

  const basis = baseUrl.replace(/\/+$/, '');
  const projekt = projectId === undefined ? '' : `?projectId=${projectId}`;
  return `${basis}/perspective.req#/items/${itemId}${projekt}`;
}

export async function buildMappingContext(
  schema: SchemaResolver,
  itemTypeIds: number[],
): Promise<MappingContext> {
  const [optionLabels, userLabels, types] = await Promise.all([
    schema.getOptionLabels(itemTypeIds),
    schema.getUserLabels(),
    schema.getItemTypes(),
  ]);

  const itemTypeLabels = new Map<number, string>();
  for (const type of types) {
    itemTypeLabels.set(type.id, type.display ?? type.typeKey ?? `Typ ${type.id}`);
  }

  return { schema, optionLabels, userLabels, itemTypeLabels, baseUrl: schema.instanzUrl };
}

export function toItemSummary(item: JamaItem, context: MappingContext): ItemSummary {
  const statusRaw = item.fields?.status;
  const status =
    typeof statusRaw === 'number' ? context.optionLabels.get(statusRaw) : (statusRaw as string);

  return {
    id: item.id,
    documentKey: item.documentKey,
    name: itemName(item),
    itemType: item.itemType === undefined ? undefined : context.itemTypeLabels.get(item.itemType),
    status: status ?? undefined,
    project: item.project,
    modifiedDate: item.modifiedDate,
    sequence: item.location?.sequence,
    url: itemUrl(context.baseUrl, item.id, item.project),
  };
}

export interface ItemDetailOptions {
  /** Obergrenze fuer die Beschreibung in Zeichen. */
  maxDescriptionChars?: number;
  /** Sollen leere Felder mit ausgegeben werden? Standard: nein. */
  includeEmptyFields?: boolean;
}

export function toItemDetail(
  item: JamaItem,
  context: MappingContext,
  options: ItemDetailOptions = {},
): ItemDetail {
  const summary = toItemSummary(item, context);
  const maxDescription = options.maxDescriptionChars ?? 8000;
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(item.fields ?? {})) {
    if (key === 'name' || key === 'status') continue;
    if (NOISE_FIELDS.has(key)) continue;
    if (value === null || value === undefined || value === '') {
      if (!options.includeEmptyFields) continue;
    }

    // Rich Text nach Markdown; erkennt auch Custom Fields mit Suffix.
    const baseName = key.split('$')[0] ?? key;
    if (typeof value === 'string' && (RICH_TEXT_FIELDS.has(baseName) || /<[a-z][\s\S]*>/i.test(value))) {
      const markdown = htmlToMarkdown(value);
      if (markdown) fields[key] = shorten(markdown, maxDescription);
      continue;
    }

    // Picklist-Verweise aufloesen, damit aus 307 wieder "Approved" wird.
    if (typeof value === 'number' && context.optionLabels.has(value)) {
      fields[key] = context.optionLabels.get(value);
      continue;
    }

    if (Array.isArray(value)) {
      fields[key] = value.map((entry) =>
        typeof entry === 'number' && context.optionLabels.has(entry)
          ? context.optionLabels.get(entry)
          : entry,
      );
      continue;
    }

    fields[key] = value;
  }

  const description = typeof fields.description === 'string' ? fields.description : undefined;
  if (description !== undefined) delete fields.description;

  return {
    ...summary,
    globalId: item.globalId,
    description,
    createdDate: item.createdDate,
    lastActivityDate: item.lastActivityDate,
    createdBy: item.createdBy === undefined ? undefined : context.userLabels.get(item.createdBy),
    modifiedBy: item.modifiedBy === undefined ? undefined : context.userLabels.get(item.modifiedBy),
    parentId: item.location?.parent?.item,
    locked: item.lock?.locked,
    fields,
  };
}

export interface RelationshipSummary {
  id: number;
  fromItem: number;
  toItem: number;
  type?: string;
  suspect?: boolean;
}

export function toRelationshipSummary(
  relationship: JamaRelationship,
  typeLabels: Map<number, string>,
): RelationshipSummary {
  return {
    id: relationship.id,
    fromItem: relationship.fromItem,
    toItem: relationship.toItem,
    type:
      relationship.relationshipType === undefined
        ? undefined
        : typeLabels.get(relationship.relationshipType),
    suspect: relationship.suspect,
  };
}

export interface TestRunSummary {
  id: number;
  documentKey?: string;
  name?: string;
  status?: string;
  executionDate?: string;
  assignedTo?: string;
  testCase?: number;
  testCycle?: number;
}

export function toTestRunSummary(run: JamaTestRun, context: MappingContext): TestRunSummary {
  const assigned = run.fields?.assignedTo;
  return {
    id: run.id,
    documentKey: run.documentKey,
    name: run.fields?.name,
    status: run.fields?.testRunStatus,
    executionDate: run.fields?.executionDate,
    assignedTo: typeof assigned === 'number' ? context.userLabels.get(assigned) : undefined,
    testCase: run.fields?.testCase,
    testCycle: run.testCycle,
  };
}

/** Sammelt die vorkommenden ItemType-IDs, um gezielt Picklists nachzuladen. */
export function collectItemTypeIds(items: JamaItem[]): number[] {
  const ids = new Set<number>();
  for (const item of items) {
    if (typeof item.itemType === 'number') ids.add(item.itemType);
  }
  return [...ids];
}
