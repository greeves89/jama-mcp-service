import { z } from 'zod';
import { CONFIRM_DESCRIPTION, defineTool, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { buildMappingContext, collectItemTypeIds, toItemDetail } from '../../jama/mapping.js';
import { resolveItem } from './core.js';
import type { JamaItem } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "write": veraendernde Operationen auf Items und Beziehungen.
 *
 * Jedes Tool hier ist mutating und wird damit vom Read-only-Guard erfasst;
 * loeschende Tools verlangen zusaetzlich confirm: true. Alle Aufrufe schreiben
 * unabhaengig vom Ausgang einen Audit-Eintrag — das ist in regulierten
 * Umgebungen (ASPICE, ISO 26262, IEC 62304) der eigentliche Grund, warum ein
 * LLM-Zugang ueberhaupt genehmigungsfaehig ist.
 */

/**
 * Setzt Felder in das Format um, das Jama erwartet, und meldet Auffaelligkeiten
 * zurueck. Ohne diesen Schritt wuerde ein LLM "Approved" schreiben, wo Jama 307
 * erwartet — und einen wenig hilfreichen 400 bekommen.
 */
async function prepareFields(
  itemTypeId: number,
  fields: Record<string, unknown>,
  context: { client: { schema: import('../../jama/schema.js').SchemaResolver } },
): Promise<{ resolved: Record<string, unknown>; warnings: string[] }> {
  return context.client.schema.resolveFieldValues(itemTypeId, fields);
}

const createItem = defineTool({
  name: 'jama_create_item',
  toolset: 'write',
  title: 'Item anlegen',
  description:
    'Legt ein neues Item an. Vorher unbedingt jama_get_project_schema aufrufen, um ItemType-ID und gueltige Feldnamen zu ermitteln. Picklist-Werte koennen im Klartext angegeben werden — der Service loest sie selbst auf die internen IDs auf.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt, in dem das Item entsteht.'),
    itemTypeId: z.number().int().describe('ItemType-ID aus jama_get_project_schema.'),
    parentItemId: z
      .number()
      .int()
      .optional()
      .describe(
        'Uebergeordnetes Item (Ordner oder Set). Ohne Angabe entsteht das Item auf oberster Projektebene.',
      ),
    fields: z
      .record(z.unknown())
      .describe(
        'Feldwerte, mindestens "name". Rich-Text-Felder wie "description" akzeptieren HTML. Custom Fields tragen ein Suffix wie "priority$32".',
      ),
  },
  mutating: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const { resolved, warnings } = await prepareFields(args.itemTypeId, args.fields, context);

    if (!resolved.name && !Object.keys(resolved).some((key) => key.startsWith('name$'))) {
      throw new ServiceError('VALIDATION', 'Das Feld "name" ist beim Anlegen erforderlich.', 400);
    }

    const body: Record<string, unknown> = {
      project: args.projectId,
      itemType: args.itemTypeId,
      fields: resolved,
    };
    if (args.parentItemId !== undefined) {
      body.location = { parent: { item: args.parentItemId } };
    }

    try {
      const response = await context.client.http.request<{ id?: number } | number>('items', {
        method: 'POST',
        body,
      });
      const newId =
        typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

      context.audit({
        action: 'item.create',
        targetType: 'item',
        targetKey: String(newId ?? 'unbekannt'),
        payload: { projectId: args.projectId, itemTypeId: args.itemTypeId, felder: Object.keys(resolved) },
        result: 'ok',
      });

      const created =
        newId === undefined
          ? undefined
          : await context.client.http.getOptional<JamaItem>(`items/${newId}`);

      let detail;
      if (created) {
        const mapping = await buildMappingContext(
          context.client.schema,
          collectItemTypeIds([created]),
        );
        detail = toItemDetail(created, mapping, { maxDescriptionChars: 1000 });
      }

      return {
        data: { angelegt: true, id: newId, item: detail },
        projectId: args.projectId,
        notes: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      context.audit({
        action: 'item.create',
        targetType: 'item',
        payload: { projectId: args.projectId, itemTypeId: args.itemTypeId },
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

const createContainer = defineTool({
  name: 'jama_create_container',
  toolset: 'write',
  title: 'Ordner, Set oder Komponente anlegen',
  description:
    'Legt einen Strukturknoten an — Ordner, Set oder Komponente. Anders als bei jama_create_item muss der ItemType nicht bekannt sein: der passende Typ wird selbst ermittelt. Damit laesst sich eine Projektstruktur aufbauen, bevor die eigentlichen Inhalte entstehen.',
  inputSchema: {
    projectId: z.number().int().describe('Zielprojekt.'),
    kind: z
      .enum(['folder', 'set', 'component'])
      .describe(
        'Ordner gliedern innerhalb eines Sets, Sets fassen gleichartige Items zusammen, Komponenten bilden die oberste Gliederungsebene eines Projekts.',
      ),
    name: z.string().min(1).describe('Name des Knotens.'),
    description: z.string().optional().describe('Beschreibung. Einfaches HTML ist erlaubt.'),
    parentItemId: z
      .number()
      .int()
      .optional()
      .describe('Uebergeordneter Knoten. Ohne Angabe entsteht der Knoten auf oberster Projektebene.'),
  },
  mutating: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    // Jama fuehrt Container als gewoehnliche ItemTypes mit festen Schluesseln.
    // Welcher konkret vorliegt, unterscheidet sich zwischen Instanzen — deshalb
    // wird der Typ gesucht statt fest verdrahtet.
    const gesuchteSchluessel: Record<string, string[]> = {
      folder: ['FLD', 'FOLDER'],
      set: ['SET'],
      component: ['CMP', 'COMPONENT'],
    };
    const schluessel = gesuchteSchluessel[args.kind] ?? [];

    const typen = await context.client.schema.getItemTypes();
    const treffer = typen.find(
      (typ) =>
        schluessel.includes((typ.typeKey ?? '').toUpperCase()) ||
        (typ.display ?? '').toLowerCase() === args.kind,
    );

    if (!treffer) {
      throw new ServiceError(
        'VALIDATION',
        `In dieser Jama-Instanz wurde kein ItemType fuer "${args.kind}" gefunden. Verfuegbare Typen: ${typen
          .map((typ) => typ.typeKey ?? typ.display)
          .filter(Boolean)
          .join(', ')}. Alternativ jama_create_item mit ausdruecklicher itemTypeId verwenden.`,
        400,
      );
    }

    const body: Record<string, unknown> = {
      project: args.projectId,
      itemType: treffer.id,
      fields: { name: args.name, description: args.description },
    };
    if (args.parentItemId !== undefined) body.location = { parent: { item: args.parentItemId } };

    const response = await context.client.http.request<{ id?: number } | number>('items', {
      method: 'POST',
      body,
    });
    const id =
      typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

    context.audit({
      action: 'container.create',
      targetType: 'item',
      targetKey: String(id ?? 'unbekannt'),
      payload: { projectId: args.projectId, art: args.kind, name: args.name },
      result: 'ok',
    });

    return {
      data: { angelegt: true, id, art: args.kind, itemTypeId: treffer.id, name: args.name },
      projectId: args.projectId,
    };
  },
});

const updateItem = defineTool({
  name: 'jama_update_item',
  toolset: 'write',
  title: 'Item aendern',
  description:
    'Aendert einzelne Felder eines Items per PATCH. Nicht genannte Felder bleiben unveraendert. Picklist-Werte koennen im Klartext angegeben werden.',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Alternativ der Document Key.'),
    fields: z
      .record(z.unknown())
      .describe('Zu setzende Feldwerte. Ein Wert von null entfernt das Feld.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    if (item.itemType === undefined) {
      throw new ServiceError(
        'VALIDATION',
        `Der ItemType von Item ${item.id} liess sich nicht ermitteln.`,
        400,
      );
    }

    const { resolved, warnings } = await prepareFields(item.itemType, args.fields, context);

    if (Object.keys(resolved).length === 0) {
      throw new ServiceError(
        'VALIDATION',
        `Keines der angegebenen Felder ist beschreibbar. ${warnings.join(' ')}`,
        400,
      );
    }

    const operations = Object.entries(resolved).map(([name, value]) => ({
      op: value === null ? 'remove' : 'replace',
      path: `/fields/${name}`,
      value: value === null ? undefined : value,
    }));

    try {
      await context.client.http.request(`items/${item.id}`, {
        method: 'PATCH',
        body: operations,
      });

      context.audit({
        action: 'item.update',
        targetType: 'item',
        targetKey: item.documentKey ?? String(item.id),
        payload: { felder: Object.keys(resolved) },
        result: 'ok',
      });

      const updated = await context.client.http.getOptional<JamaItem>(`items/${item.id}`);
      let detail;
      if (updated) {
        const mapping = await buildMappingContext(
          context.client.schema,
          collectItemTypeIds([updated]),
        );
        detail = toItemDetail(updated, mapping, { maxDescriptionChars: 1000 });
      }

      return {
        data: { geaendert: true, id: item.id, item: detail },
        projectId: item.project,
        notes: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      context.audit({
        action: 'item.update',
        targetType: 'item',
        targetKey: item.documentKey ?? String(item.id),
        payload: { felder: Object.keys(resolved) },
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

const bulkUpdateItems = defineTool({
  name: 'jama_bulk_update_items',
  toolset: 'write',
  title: 'Mehrere Items aendern',
  description:
    'Setzt dieselben Feldwerte auf mehreren Items. Mit dryRun: true wird nur angezeigt, was passieren wuerde — bei Massenaenderungen dringend empfohlen, weil sich eine falsche Auswahl sonst nur muehsam zurueckdrehen laesst.',
  inputSchema: {
    itemIds: z.array(z.number().int()).min(1).max(200).describe('Zu aendernde Items.'),
    fields: z.record(z.unknown()).describe('Feldwerte, die auf allen Items gesetzt werden.'),
    dryRun: z
      .boolean()
      .default(true)
      .describe(
        'Standardmaessig an: es wird nur geprueft und angezeigt. Fuer die tatsaechliche Aenderung ausdruecklich auf false setzen.',
      ),
  },
  mutating: true,
  handler: async (args, context) => {
    const geplant: Array<{ id: number; documentKey?: string; name?: string }> = [];
    const uebersprungen: Array<{ id: number; grund: string }> = [];
    const warnungen = new Set<string>();

    for (const itemId of args.itemIds) {
      const item = await context.client.http.getOptional<JamaItem>(`items/${itemId}`);
      if (!item) {
        uebersprungen.push({ id: itemId, grund: 'existiert nicht' });
        continue;
      }
      try {
        assertProjectAllowed(item.project, context);
      } catch {
        uebersprungen.push({ id: itemId, grund: 'Projekt nicht freigegeben' });
        continue;
      }
      if (item.itemType === undefined) {
        uebersprungen.push({ id: itemId, grund: 'ItemType unbekannt' });
        continue;
      }

      const { resolved, warnings } = await prepareFields(item.itemType, args.fields, context);
      for (const warning of warnings) warnungen.add(warning);

      if (Object.keys(resolved).length === 0) {
        uebersprungen.push({ id: itemId, grund: 'kein beschreibbares Feld' });
        continue;
      }

      geplant.push({
        id: itemId,
        documentKey: item.documentKey,
        name: typeof item.fields?.name === 'string' ? item.fields.name : undefined,
      });

      if (!args.dryRun) {
        const operations = Object.entries(resolved).map(([name, value]) => ({
          op: value === null ? 'remove' : 'replace',
          path: `/fields/${name}`,
          value: value === null ? undefined : value,
        }));
        await context.client.http.request(`items/${itemId}`, {
          method: 'PATCH',
          body: operations,
        });
      }
    }

    context.audit({
      action: args.dryRun ? 'item.bulkUpdate.dryRun' : 'item.bulkUpdate',
      targetType: 'item',
      targetKey: `${geplant.length} Items`,
      payload: { ids: geplant.map((entry) => entry.id), felder: Object.keys(args.fields) },
      result: 'ok',
    });

    const notes = [...warnungen];
    if (args.dryRun) {
      notes.unshift(
        `Trockenlauf — es wurde nichts geaendert. ${geplant.length} Items waeren betroffen. Fuer die Ausfuehrung erneut mit dryRun: false aufrufen.`,
      );
    }

    return {
      data: {
        trockenlauf: args.dryRun,
        betroffen: geplant,
        uebersprungen,
        anzahl: geplant.length,
      },
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const bulkCreateItems = defineTool({
  name: 'jama_bulk_create_items',
  toolset: 'write',
  title: 'Mehrere Items anlegen',
  description:
    'Legt mehrere Items desselben Typs nacheinander an, etwa beim Uebernehmen einer Anforderungsliste. Bricht bei einem Fehler nicht ab, sondern meldet am Ende, welche Items entstanden sind und welche nicht — sonst bliebe bei einem Teilfehler unklar, was bereits in Jama steht.',
  inputSchema: {
    projectId: z.number().int().describe('Zielprojekt.'),
    itemTypeId: z.number().int().describe('ItemType-ID aus jama_get_project_schema.'),
    parentItemId: z.number().int().optional().describe('Gemeinsames uebergeordnetes Item.'),
    items: z
      .array(z.record(z.unknown()))
      .min(1)
      .max(100)
      .describe('Liste von Feldwert-Objekten, jeweils mindestens mit "name".'),
    dryRun: z
      .boolean()
      .default(true)
      .describe('Standardmaessig an. Fuer das tatsaechliche Anlegen auf false setzen.'),
  },
  mutating: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const angelegt: Array<{ index: number; id?: number; name?: unknown }> = [];
    const fehlgeschlagen: Array<{ index: number; name?: unknown; fehler: string }> = [];
    const warnungen = new Set<string>();

    for (const [index, fields] of args.items.entries()) {
      const { resolved, warnings } = await prepareFields(args.itemTypeId, fields, context);
      for (const warning of warnings) warnungen.add(warning);

      if (!resolved.name && !Object.keys(resolved).some((key) => key.startsWith('name$'))) {
        fehlgeschlagen.push({ index, fehler: 'Feld "name" fehlt' });
        continue;
      }

      if (args.dryRun) {
        angelegt.push({ index, name: resolved.name });
        continue;
      }

      const body: Record<string, unknown> = {
        project: args.projectId,
        itemType: args.itemTypeId,
        fields: resolved,
      };
      if (args.parentItemId !== undefined) body.location = { parent: { item: args.parentItemId } };

      try {
        const response = await context.client.http.request<{ id?: number } | number>('items', {
          method: 'POST',
          body,
        });
        const id =
          typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;
        angelegt.push({ index, id, name: resolved.name });
      } catch (error) {
        fehlgeschlagen.push({
          index,
          name: resolved.name,
          fehler: error instanceof Error ? error.message : String(error),
        });
      }
    }

    context.audit({
      action: args.dryRun ? 'item.bulkCreate.dryRun' : 'item.bulkCreate',
      targetType: 'item',
      targetKey: `${angelegt.length} Items in Projekt ${args.projectId}`,
      payload: { projectId: args.projectId, itemTypeId: args.itemTypeId, anzahl: args.items.length },
      result: fehlgeschlagen.length > 0 ? 'error' : 'ok',
    });

    const notes = [...warnungen];
    if (args.dryRun) {
      notes.unshift(
        `Trockenlauf — es wurde nichts angelegt. ${angelegt.length} Items waeren entstanden. Fuer die Ausfuehrung erneut mit dryRun: false aufrufen.`,
      );
    }
    if (fehlgeschlagen.length > 0 && !args.dryRun) {
      notes.unshift(
        `Achtung: ${angelegt.length} Items wurden angelegt, ${fehlgeschlagen.length} nicht. Der Vorgang ist damit unvollstaendig — vor einem erneuten Versuch pruefen, was bereits existiert, um Dubletten zu vermeiden.`,
      );
    }

    return {
      data: { trockenlauf: args.dryRun, angelegt, fehlgeschlagen },
      projectId: args.projectId,
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

const deleteItem = defineTool({
  name: 'jama_delete_item',
  toolset: 'write',
  title: 'Item loeschen',
  description:
    'Loescht ein Item in Jama. Der Vorgang laesst sich nur ueber die Aktivitaetenhistorie (jama_restore_deleted) rueckgaengig machen und nur, solange die Aktivitaet vorliegt. Erfordert confirm: true und sollte immer mit dem Anwender abgestimmt sein.',
  inputSchema: {
    itemId: z.number().int().describe('Zu loeschendes Item.'),
    confirm: z.boolean().default(false).describe(CONFIRM_DESCRIPTION),
  },
  mutating: true,
  destructive: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) {
      throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    }
    assertProjectAllowed(item.project, context);

    const bezeichnung = item.documentKey ?? String(item.id);
    const name = typeof item.fields?.name === 'string' ? item.fields.name : undefined;

    try {
      await context.client.http.request(`items/${args.itemId}`, { method: 'DELETE' });
      context.audit({
        action: 'item.delete',
        targetType: 'item',
        targetKey: bezeichnung,
        payload: { name, projectId: item.project },
        result: 'ok',
      });
      return {
        data: { geloescht: true, id: args.itemId, documentKey: bezeichnung, name },
        projectId: item.project,
        notes: [
          'Das Item wurde geloescht. Eine Wiederherstellung ist nur ueber jama_restore_deleted moeglich, solange die zugehoerige Aktivitaet vorliegt.',
        ],
      };
    } catch (error) {
      context.audit({
        action: 'item.delete',
        targetType: 'item',
        targetKey: bezeichnung,
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

const moveItem = defineTool({
  name: 'jama_move_item',
  toolset: 'write',
  title: 'Item verschieben',
  description:
    'Verschiebt ein Item unter ein anderes uebergeordnetes Item. Beziehungen und Historie bleiben erhalten, der Document Key aendert sich nicht.',
  inputSchema: {
    itemId: z.number().int().describe('Zu verschiebendes Item.'),
    newParentItemId: z.number().int().describe('Neues uebergeordnetes Item.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const [item, parent] = await Promise.all([
      context.client.http.getOptional<JamaItem>(`items/${args.itemId}`),
      context.client.http.getOptional<JamaItem>(`items/${args.newParentItemId}`),
    ]);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    if (!parent) {
      throw new ServiceError(
        'JAMA_NOT_FOUND',
        `Das Ziel-Item ${args.newParentItemId} existiert nicht.`,
        404,
      );
    }
    assertProjectAllowed(item.project, context);
    assertProjectAllowed(parent.project, context);

    await context.client.http.request(`items/${args.itemId}/location`, {
      method: 'PUT',
      body: { parent: { item: args.newParentItemId } },
    });

    context.audit({
      action: 'item.move',
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      payload: { neuesElternItem: args.newParentItemId },
      result: 'ok',
    });

    return {
      data: { verschoben: true, id: args.itemId, neuesElternItem: args.newParentItemId },
      projectId: item.project,
    };
  },
});

const duplicateItem = defineTool({
  name: 'jama_duplicate_item',
  toolset: 'write',
  title: 'Item duplizieren',
  description:
    'Erzeugt eine Kopie eines Items unter einem gewaehlten uebergeordneten Item. Nuetzlich, um eine Variante auf Basis eines bestehenden Moduls aufzusetzen.',
  inputSchema: {
    itemId: z.number().int().describe('Vorlage.'),
    targetParentItemId: z
      .number()
      .int()
      .optional()
      .describe('Uebergeordnetes Item der Kopie. Ohne Angabe wird neben der Vorlage abgelegt.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    const body: Record<string, unknown> = {};
    if (args.targetParentItemId !== undefined) {
      body.location = { parent: { item: args.targetParentItemId } };
    }

    const response = await context.client.http.request<{ id?: number } | number>(
      `items/${args.itemId}/duplicate`,
      { method: 'POST', body },
    );
    const newId =
      typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

    context.audit({
      action: 'item.duplicate',
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      payload: { neueId: newId },
      result: 'ok',
    });

    return { data: { dupliziert: true, vorlage: args.itemId, neueId: newId }, projectId: item.project };
  },
});

const createRelationship = defineTool({
  name: 'jama_create_relationship',
  toolset: 'write',
  title: 'Beziehung anlegen',
  description:
    'Verknuepft zwei Items, etwa eine Anforderung mit einem Testfall. Bei Unsicherheit ueber die Zulaessigkeit vorher jama_check_relationship_rules aufrufen — Jama lehnt regelwidrige Verknuepfungen mit einem wenig aussagekraeftigen 400 ab.',
  inputSchema: {
    fromItemId: z.number().int().describe('Quelle (uebergeordnet, z. B. die Anforderung).'),
    toItemId: z.number().int().describe('Ziel (nachgelagert, z. B. der Testfall).'),
    relationshipTypeId: z
      .number()
      .int()
      .optional()
      .describe('Beziehungstyp aus jama_get_project_schema. Ohne Angabe nimmt Jama den Standardtyp.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const [from, to] = await Promise.all([
      context.client.http.getOptional<JamaItem>(`items/${args.fromItemId}`),
      context.client.http.getOptional<JamaItem>(`items/${args.toItemId}`),
    ]);
    if (!from || !to) {
      throw new ServiceError('JAMA_NOT_FOUND', 'Quelle oder Ziel existiert nicht.', 404);
    }
    assertProjectAllowed(from.project, context);
    assertProjectAllowed(to.project, context);

    const body: Record<string, unknown> = { fromItem: args.fromItemId, toItem: args.toItemId };
    if (args.relationshipTypeId !== undefined) body.relationshipType = args.relationshipTypeId;

    try {
      const response = await context.client.http.request<{ id?: number } | number>('relationships', {
        method: 'POST',
        body,
      });
      const id =
        typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

      context.audit({
        action: 'relationship.create',
        targetType: 'relationship',
        targetKey: `${from.documentKey ?? from.id} -> ${to.documentKey ?? to.id}`,
        payload: { relationshipTypeId: args.relationshipTypeId },
        result: 'ok',
      });

      return {
        data: {
          angelegt: true,
          id,
          von: { id: from.id, documentKey: from.documentKey },
          nach: { id: to.id, documentKey: to.documentKey },
        },
        projectId: from.project,
      };
    } catch (error) {
      context.audit({
        action: 'relationship.create',
        targetType: 'relationship',
        targetKey: `${from.documentKey ?? from.id} -> ${to.documentKey ?? to.id}`,
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

const deleteRelationship = defineTool({
  name: 'jama_delete_relationship',
  toolset: 'write',
  title: 'Beziehung loeschen',
  description:
    'Entfernt eine Verknuepfung zwischen zwei Items. Erfordert confirm: true, weil dabei Nachweisketten zerstoert werden koennen, die in regulierten Projekten belegpflichtig sind.',
  inputSchema: {
    relationshipId: z.number().int().describe('Zu loeschende Beziehung (ID aus jama_get_relationships).'),
    confirm: z.boolean().default(false).describe(CONFIRM_DESCRIPTION),
  },
  mutating: true,
  destructive: true,
  handler: async (args, context) => {
    await context.client.http.request(`relationships/${args.relationshipId}`, {
      method: 'DELETE',
    });

    context.audit({
      action: 'relationship.delete',
      targetType: 'relationship',
      targetKey: String(args.relationshipId),
      result: 'ok',
    });

    return { data: { geloescht: true, id: args.relationshipId } };
  },
});

const manageTags = defineTool({
  name: 'jama_manage_tags',
  toolset: 'write',
  title: 'Tags setzen oder entfernen',
  description:
    'Fuegt einem Item einen Tag hinzu oder entfernt ihn. Tags eignen sich gut, um Arbeitsstaende zu markieren, ohne Fachfelder zu veraendern.',
  inputSchema: {
    itemId: z.number().int().describe('Betroffenes Item.'),
    tagId: z.number().int().describe('Tag-ID aus jama_list_tags.'),
    action: z.enum(['add', 'remove']).describe('Hinzufuegen oder entfernen.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    if (args.action === 'add') {
      await context.client.http.request(`items/${args.itemId}/tags`, {
        method: 'POST',
        body: { tag: args.tagId },
      });
    } else {
      await context.client.http.request(`items/${args.itemId}/tags/${args.tagId}`, {
        method: 'DELETE',
      });
    }

    context.audit({
      action: `item.tag.${args.action}`,
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      payload: { tagId: args.tagId },
      result: 'ok',
    });

    return {
      data: { id: args.itemId, tagId: args.tagId, aktion: args.action, erfolgreich: true },
      projectId: item.project,
    };
  },
});

const lockItem = defineTool({
  name: 'jama_lock_item',
  toolset: 'write',
  title: 'Item sperren oder freigeben',
  description:
    'Liest oder setzt die Bearbeitungssperre eines Items. Vor laengeren Aenderungsserien sinnvoll, damit nicht parallel in der Oberflaeche gearbeitet wird. Ohne Angabe von "locked" wird nur der aktuelle Zustand gemeldet.',
  inputSchema: {
    itemId: z.number().int().describe('Betroffenes Item.'),
    locked: z
      .boolean()
      .optional()
      .describe('true sperrt, false gibt frei. Ohne Angabe wird nur abgefragt.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    if (args.locked === undefined) {
      const status = await context.client.http.request<{ locked?: boolean; lockedBy?: number }>(
        `items/${args.itemId}/lock`,
      );
      return { data: { id: args.itemId, ...status.data }, projectId: item.project };
    }

    await context.client.http.request(`items/${args.itemId}/lock`, {
      method: 'PUT',
      body: { locked: args.locked },
    });

    context.audit({
      action: args.locked ? 'item.lock' : 'item.unlock',
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      result: 'ok',
    });

    return { data: { id: args.itemId, gesperrt: args.locked }, projectId: item.project };
  },
});

export const writeTools: ToolDefinition[] = [
  createItem,
  createContainer,
  updateItem,
  bulkUpdateItems,
  bulkCreateItems,
  deleteItem,
  moveItem,
  duplicateItem,
  createRelationship,
  deleteRelationship,
  manageTags,
  lockItem,
] as unknown as ToolDefinition[];
