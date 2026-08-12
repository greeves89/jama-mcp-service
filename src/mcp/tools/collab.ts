import { z } from 'zod';
import { defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { htmlToMarkdown } from '../../jama/markdown.js';
import { resolveItem } from './core.js';
import type { JamaComment, JamaItem } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "collab": Kommentare und Workflow.
 *
 * Workflow-Uebergaenge sind hier der heikle Teil: sie aendern den Freigabestatus
 * eines Items und damit unter Umstaenden dessen regulatorische Bedeutung.
 * Deshalb wird immer zuerst geprueft, welche Uebergaenge Jama ueberhaupt
 * erlaubt, statt einen Namen zu raten.
 */

const listComments = defineTool({
  name: 'jama_list_comments',
  toolset: 'collab',
  title: 'Kommentare lesen',
  description:
    'Liefert die Kommentare zu einem Item samt Antworten, chronologisch. HTML wird nach Markdown konvertiert. Nuetzlich, um offene Diskussionspunkte zu einer Anforderung zusammenzufassen.',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Alternativ der Document Key.'),
    includeReplies: z
      .boolean()
      .default(true)
      .describe('Antworten mitliefern. Kostet je Kommentar einen zusaetzlichen Aufruf.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    const { items: comments } = await context.client.http.paginate<JamaComment>(
      `items/${item.id}/comments`,
      { limit: args.limit },
    );

    const userLabels = await context.client.schema.getUserLabels();
    const mapComment = (comment: JamaComment) => ({
      id: comment.id,
      text: htmlToMarkdown(comment.body?.text),
      von: comment.createdBy === undefined ? undefined : userLabels.get(comment.createdBy),
      am: comment.createdDate,
      status: comment.status,
      art: comment.commentType,
    });

    const aufbereitet = [];
    for (const comment of comments) {
      // Antworten haengen als eigene Kommentare am Elternkommentar.
      if (comment.inReplyTo !== undefined) continue;

      const entry: Record<string, unknown> = mapComment(comment);
      if (args.includeReplies) {
        const { items: replies } = await context.client.http.paginate<JamaComment>(
          `comments/${comment.id}/replies`,
          { limit: 50 },
        );
        if (replies.length > 0) entry.antworten = replies.map(mapComment);
      }
      aufbereitet.push(entry);
    }

    return {
      data: { item: { id: item.id, documentKey: item.documentKey }, kommentare: aufbereitet },
      projectId: item.project,
      notes: aufbereitet.length === 0 ? ['Zu diesem Item gibt es keine Kommentare.'] : undefined,
    };
  },
});

const addComment = defineTool({
  name: 'jama_add_comment',
  toolset: 'collab',
  title: 'Kommentar schreiben',
  description:
    'Schreibt einen Kommentar an ein Item oder antwortet auf einen bestehenden Kommentar. Der Kommentar erscheint in Jama unter dem hinterlegten Benutzer — nicht als anonymer Automat.',
  inputSchema: {
    itemId: z.number().int().describe('Item, an das kommentiert wird.'),
    text: z.string().min(1).describe('Kommentartext. Einfaches HTML ist erlaubt.'),
    inReplyToCommentId: z
      .number()
      .int()
      .optional()
      .describe('Wenn gesetzt: Antwort auf diesen Kommentar.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    const body: Record<string, unknown> = {
      body: { text: args.text },
      location: { item: args.itemId },
    };
    if (args.inReplyToCommentId !== undefined) body.inReplyTo = args.inReplyToCommentId;

    const response = await context.client.http.request<{ id?: number } | number>('comments', {
      method: 'POST',
      body,
    });
    const id =
      typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

    context.audit({
      action: 'comment.create',
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      payload: { laenge: args.text.length, antwortAuf: args.inReplyToCommentId },
      result: 'ok',
    });

    return { data: { angelegt: true, id, itemId: args.itemId }, projectId: item.project };
  },
});

const getWorkflowOptions = defineTool({
  name: 'jama_get_workflow_options',
  toolset: 'collab',
  title: 'Moegliche Workflow-Uebergaenge abrufen',
  description:
    'Liefert die Uebergaenge, die auf einem Item im aktuellen Zustand erlaubt sind. Immer vor jama_execute_workflow_transition aufrufen — welche Uebergaenge existieren, haengt vom Projekt-Workflow ab und laesst sich nicht erraten.',
  inputSchema: {
    itemId: z.number().int().describe('Betroffenes Item.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    const { items: options } = await context.client.http.paginate<{
      id?: number;
      name?: string;
      label?: string;
      newStatus?: string;
    }>(`items/${args.itemId}/workflowtransitionoptions`, { limit: 50 });

    return {
      data: {
        item: { id: item.id, documentKey: item.documentKey },
        uebergaenge: options.map((option) => ({
          id: option.id,
          name: option.name ?? option.label,
          neuerStatus: option.newStatus,
        })),
      },
      projectId: item.project,
      notes:
        options.length === 0
          ? [
              'Es sind keine Uebergaenge moeglich. Entweder ist kein Workflow konfiguriert oder der Benutzer hat nicht die noetigen Rechte.',
            ]
          : undefined,
    };
  },
});

const executeWorkflowTransition = defineTool({
  name: 'jama_execute_workflow_transition',
  toolset: 'collab',
  title: 'Workflow-Uebergang ausfuehren',
  description:
    'Fuehrt einen Workflow-Uebergang auf einem Item aus, etwa eine Freigabe. Aendert den Freigabestatus und kann damit regulatorische Wirkung haben — vorher jama_get_workflow_options aufrufen und mit dem Anwender abstimmen.',
  inputSchema: {
    itemId: z.number().int().describe('Betroffenes Item.'),
    transitionId: z
      .number()
      .int()
      .describe('ID des Uebergangs aus jama_get_workflow_options.'),
    comment: z.string().optional().describe('Begruendung, die dem Uebergang beigefuegt wird.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    const body: Record<string, unknown> = { transitionId: args.transitionId };
    if (args.comment) body.comment = args.comment;

    try {
      await context.client.http.request(`items/${args.itemId}/workflowtransitions`, {
        method: 'POST',
        body,
      });

      context.audit({
        action: 'item.workflowTransition',
        targetType: 'item',
        targetKey: item.documentKey ?? String(item.id),
        payload: { transitionId: args.transitionId, kommentar: args.comment },
        result: 'ok',
      });

      const updated = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
      const optionLabels = await context.client.schema.getOptionLabels(
        updated?.itemType === undefined ? [] : [updated.itemType],
      );
      const statusRaw = updated?.fields?.status;
      const status =
        typeof statusRaw === 'number' ? optionLabels.get(statusRaw) : (statusRaw as string);

      return {
        data: { ausgefuehrt: true, id: args.itemId, neuerStatus: status },
        projectId: item.project,
      };
    } catch (error) {
      context.audit({
        action: 'item.workflowTransition',
        targetType: 'item',
        targetKey: item.documentKey ?? String(item.id),
        payload: { transitionId: args.transitionId },
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

export const collabTools: ToolDefinition[] = [
  listComments,
  addComment,
  getWorkflowOptions,
  executeWorkflowTransition,
] as unknown as ToolDefinition[];
