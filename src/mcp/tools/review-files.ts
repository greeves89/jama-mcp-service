import { z } from 'zod';
import { defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { htmlToMarkdown } from '../../jama/markdown.js';
import type { JamaAttachment, JamaComment, JamaItem, JamaReview } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolsets "review" und "files".
 *
 * Beide stuetzen sich auf labs-Endpoints, die Jama ohne Supportzusage anbietet
 * und je nach Version gar nicht bereitstellt. Die Tools fangen den 404 deshalb
 * ab und geben eine Erklaerung zurueck, statt einen nackten Fehler zu melden —
 * sonst versucht das Modell den Aufruf wieder und wieder.
 */

function labsHint(endpoint: string): string {
  return `Der Endpunkt "${endpoint}" ist auf dieser Jama-Instanz nicht verfuegbar. Er gehoert zu den labs-Endpoints und existiert erst ab bestimmten Versionen (Reviews ab 9.32, Reports ab 8.79). Ein erneuter Versuch wird nicht helfen.`;
}

const listReviews = defineTool({
  name: 'jama_list_reviews',
  toolset: 'review',
  title: 'Reviews auflisten',
  description:
    'Liefert die Reviews eines Projekts mit Status und Organisator. Nutzt einen labs-Endpoint (ab Jama Connect 9.32).',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  labs: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    try {
      const { items, total } = await context.client.http.paginate<JamaReview>('reviews', {
        query: { project: args.projectId },
        limit: args.limit,
        apiVersion: 'labs',
      });
      const userLabels = await context.client.schema.getUserLabels();

      return {
        data: {
          reviews: items.map((review) => ({
            id: review.id,
            name: review.name,
            beschreibung: review.description,
            status: review.status,
            angelegt: review.createdDate,
            organisator:
              review.organizer === undefined ? undefined : userLabels.get(review.organizer),
          })),
          gesamt: total,
        },
        projectId: args.projectId,
      };
    } catch (error) {
      if (error instanceof Error && /404|nicht/i.test(error.message)) {
        return { data: { reviews: [] }, notes: [labsHint('/reviews')] };
      }
      throw error;
    }
  },
});

const getReviewStatus = defineTool({
  name: 'jama_get_review_status',
  toolset: 'review',
  title: 'Review-Fortschritt abrufen',
  description:
    'Liefert den Fortschritt einer Review-Revision samt Teilnehmern: wer hat bereits abgestimmt, wer steht noch aus. Die typische Frage vor einem Freigabetermin.',
  inputSchema: {
    reviewId: z.number().int().describe('Review-ID aus jama_list_reviews.'),
    revisionId: z
      .number()
      .int()
      .optional()
      .describe('Bestimmte Revision. Ohne Angabe wird die neueste genommen.'),
  },
  mutating: false,
  labs: true,
  handler: async (args, context) => {
    try {
      let revisionId = args.revisionId;

      if (revisionId === undefined) {
        const { items } = await context.client.http.paginate<{ id: number; createdDate?: string }>(
          `reviews/${args.reviewId}/revisions`,
          { limit: 50, apiVersion: 'labs' },
        );
        const neueste = items.at(-1);
        if (!neueste) {
          return {
            data: { reviewId: args.reviewId, revisionen: [] },
            notes: ['Zu diesem Review gibt es keine Revisionen.'],
          };
        }
        revisionId = neueste.id;
      }

      const [progress, participants] = await Promise.all([
        context.client.http.getOptional<Record<string, unknown>>(
          `reviews/${args.reviewId}/revisions/${revisionId}/progress`,
          { apiVersion: 'labs' },
        ),
        context.client.http.paginate<{
          user?: number;
          finished?: boolean;
          role?: string;
          itemsReviewed?: number;
        }>(`reviews/${args.reviewId}/revisions/${revisionId}/participants`, {
          limit: 100,
          apiVersion: 'labs',
        }),
      ]);

      const userLabels = await context.client.schema.getUserLabels();
      const teilnehmer = participants.items.map((entry) => ({
        name: entry.user === undefined ? undefined : userLabels.get(entry.user),
        rolle: entry.role,
        abgeschlossen: entry.finished === true,
        gepruefteItems: entry.itemsReviewed,
      }));

      const offen = teilnehmer.filter((entry) => !entry.abgeschlossen);

      return {
        data: {
          reviewId: args.reviewId,
          revisionId,
          fortschritt: progress,
          teilnehmer,
          nochOffen: offen.map((entry) => entry.name).filter(Boolean),
        },
        notes:
          offen.length === 0
            ? ['Alle Teilnehmer haben ihre Pruefung abgeschlossen.']
            : [`${offen.length} von ${teilnehmer.length} Teilnehmern haben noch nicht abgeschlossen.`],
      };
    } catch (error) {
      if (error instanceof Error && /404/i.test(error.message)) {
        return { data: {}, notes: [labsHint('/reviews')] };
      }
      throw error;
    }
  },
});

const listReviewComments = defineTool({
  name: 'jama_list_review_comments',
  toolset: 'review',
  title: 'Review-Kommentare lesen',
  description:
    'Liefert alle Kommentare eines Reviews. Gute Grundlage, um Rueckmeldungen thematisch zu buendeln, statt sie einzeln in der Oberflaeche durchzugehen.',
  inputSchema: {
    reviewId: z.number().int().describe('Review-ID.'),
    limit: z.number().int().min(1).max(300).default(100).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  labs: true,
  handler: async (args, context) => {
    try {
      const { items, total } = await context.client.http.paginate<JamaComment>(
        `reviews/${args.reviewId}/comments`,
        { limit: args.limit, apiVersion: 'labs' },
      );
      const userLabels = await context.client.schema.getUserLabels();

      return {
        data: {
          reviewId: args.reviewId,
          kommentare: items.map((comment) => ({
            id: comment.id,
            text: htmlToMarkdown(comment.body?.text),
            von: comment.createdBy === undefined ? undefined : userLabels.get(comment.createdBy),
            am: comment.createdDate,
            status: comment.status,
            zuItem: comment.location?.item,
          })),
          gesamt: total,
        },
      };
    } catch (error) {
      if (error instanceof Error && /404/i.test(error.message)) {
        return { data: { kommentare: [] }, notes: [labsHint('/reviews/{id}/comments')] };
      }
      throw error;
    }
  },
});

const listAttachments = defineTool({
  name: 'jama_list_attachments',
  toolset: 'files',
  title: 'Anhaenge auflisten',
  description: 'Liefert die Anhaenge eines Items mit Dateiname, Groesse und Zeitpunkt.',
  inputSchema: {
    itemId: z.number().int().describe('Item, dessen Anhaenge interessieren.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);

    const { items, total } = await context.client.http.paginate<JamaAttachment>(
      `items/${args.itemId}/attachments`,
      { limit: args.limit },
    );
    const userLabels = await context.client.schema.getUserLabels();

    return {
      data: {
        anhaenge: items.map((attachment) => ({
          id: attachment.id,
          dateiname: attachment.fileName ?? attachment.fields?.name,
          beschreibung: attachment.fields?.description,
          angelegt: attachment.createdDate,
          von:
            attachment.createdBy === undefined ? undefined : userLabels.get(attachment.createdBy),
        })),
        gesamt: total,
      },
      projectId: item.project,
    };
  },
});

const uploadAttachment = defineTool({
  name: 'jama_upload_attachment',
  toolset: 'files',
  title: 'Anhang hochladen',
  description:
    'Legt einen Anhang an und verknuepft ihn mit einem Item. Der Inhalt wird base64-kodiert uebergeben. Fasst die drei Jama-Aufrufe zusammen, die dafuer noetig sind: Anhang im Projekt anlegen, Datei hochladen, mit dem Item verknuepfen.',
  inputSchema: {
    itemId: z.number().int().describe('Item, an das der Anhang gehaengt wird.'),
    fileName: z.string().min(1).describe('Dateiname inklusive Endung.'),
    contentBase64: z
      .string()
      .min(1)
      .describe(
        'Dateiinhalt als base64. Grosse Dateien sind hier ungeeignet — sie muessten vollstaendig durch das Kontextfenster.',
      ),
    description: z.string().optional().describe('Beschreibung des Anhangs.'),
    contentType: z
      .string()
      .default('application/octet-stream')
      .describe('MIME-Typ, z. B. "application/pdf".'),
  },
  mutating: true,
  handler: async (args, context) => {
    const item = await context.client.http.getOptional<JamaItem>(`items/${args.itemId}`);
    if (!item) throw new ServiceError('JAMA_NOT_FOUND', `Item ${args.itemId} existiert nicht.`, 404);
    assertProjectAllowed(item.project, context);
    if (item.project === undefined) {
      throw new ServiceError('VALIDATION', 'Das Projekt des Items liess sich nicht ermitteln.', 400);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(args.contentBase64, 'base64');
    } catch {
      throw new ServiceError('VALIDATION', 'contentBase64 ist keine gueltige base64-Kodierung.', 400);
    }
    if (buffer.length === 0) {
      throw new ServiceError('VALIDATION', 'Der Dateiinhalt ist leer.', 400);
    }

    // Schritt 1: Anhangsobjekt im Projekt anlegen.
    const createResponse = await context.client.http.request<{ id?: number } | number>(
      `projects/${item.project}/attachments`,
      {
        method: 'POST',
        body: { fields: { name: args.fileName, description: args.description } },
      },
    );
    const attachmentId =
      typeof createResponse.data === 'number'
        ? createResponse.data
        : (createResponse.data as { id?: number })?.id;

    if (attachmentId === undefined) {
      throw new ServiceError(
        'JAMA_UNEXPECTED',
        'Jama hat beim Anlegen des Anhangs keine ID zurueckgeliefert.',
        502,
      );
    }

    // Schritt 2: Datei als multipart hochladen.
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: args.contentType }), args.fileName);

    try {
      await context.client.http.uploadFile(`attachments/${attachmentId}/file`, form);
    } catch (error) {
      // Das Anhangsobjekt existiert nun ohne Inhalt. Das wird ausdruecklich
      // gemeldet, statt Erfolg vorzutaeuschen — sonst bleibt in Jama eine
      // leere Karteileiche zurueck, von der niemand weiss.
      context.audit({
        action: 'attachment.upload',
        targetType: 'item',
        targetKey: item.documentKey ?? String(item.id),
        payload: { dateiname: args.fileName, bytes: buffer.length, attachmentId },
        result: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceError(
        'JAMA_UNEXPECTED',
        `Das Anhangsobjekt ${attachmentId} wurde in Projekt ${item.project} angelegt, aber der Datei-Upload schlug fehl (${error instanceof Error ? error.message : String(error)}). Der leere Anhang bleibt in Jama zurueck und sollte manuell entfernt werden.`,
        502,
      );
    }

    // Schritt 3: Anhang mit dem Item verknuepfen.
    await context.client.http.request(`items/${args.itemId}/attachments`, {
      method: 'POST',
      body: { attachment: attachmentId },
    });

    context.audit({
      action: 'attachment.upload',
      targetType: 'item',
      targetKey: item.documentKey ?? String(item.id),
      payload: { dateiname: args.fileName, bytes: buffer.length, attachmentId },
      result: 'ok',
    });

    return {
      data: {
        hochgeladen: true,
        attachmentId,
        dateiname: args.fileName,
        bytes: buffer.length,
        itemId: args.itemId,
      },
      projectId: item.project,
    };
  },
});

const downloadAttachment = defineTool({
  name: 'jama_download_attachment',
  toolset: 'files',
  title: 'Anhang herunterladen',
  description:
    'Laedt einen Anhang herunter. Textdateien werden direkt als Text geliefert, binaere Inhalte als base64. Bei grossen Dateien wird nur die Groesse gemeldet, weil der Inhalt sonst das Kontextfenster sprengen wuerde.',
  inputSchema: {
    attachmentId: z.number().int().describe('Anhang-ID aus jama_list_attachments.'),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(5_000_000)
      .default(200_000)
      .describe('Obergrenze. Groessere Dateien werden nicht uebertragen.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const metadata = await context.client.http.getOptional<JamaAttachment>(
      `attachments/${args.attachmentId}`,
    );

    const response = await context.client.http.rawRequest(
      `attachments/${args.attachmentId}/file`,
      { raw: true },
    );
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > args.maxBytes) {
      return {
        data: {
          attachmentId: args.attachmentId,
          dateiname: metadata?.fileName,
          bytes: buffer.length,
          inhalt: null,
        },
        notes: [
          `Die Datei ist ${buffer.length} Byte gross und ueberschreitet die Grenze von ${args.maxBytes}. Der Inhalt wurde nicht uebertragen.`,
        ],
      };
    }

    const contentType = response.headers.get('content-type') ?? '';
    const istText = /^text\/|json|xml|csv|markdown/i.test(contentType);

    return {
      data: {
        attachmentId: args.attachmentId,
        dateiname: metadata?.fileName,
        contentType,
        bytes: buffer.length,
        inhalt: istText ? buffer.toString('utf8') : buffer.toString('base64'),
        kodierung: istText ? 'text' : 'base64',
      },
    };
  },
});

const listReports = defineTool({
  name: 'jama_list_reports',
  toolset: 'files',
  title: 'Reports auflisten',
  description:
    'Liefert die in Jama hinterlegten Reports eines Projekts. Nutzt einen labs-Endpoint (ab Jama Connect 8.79).',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
  },
  mutating: false,
  labs: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);
    try {
      const { items } = await context.client.http.paginate<{
        id?: number;
        name?: string;
        description?: string;
        reportType?: string;
      }>('reports/metadata', {
        query: { project: args.projectId },
        limit: 100,
        apiVersion: 'labs',
      });

      return {
        data: items.map((report) => ({
          id: report.id,
          name: report.name,
          beschreibung: report.description,
          typ: report.reportType,
        })),
        projectId: args.projectId,
      };
    } catch (error) {
      if (error instanceof Error && /404/i.test(error.message)) {
        return { data: [], notes: [labsHint('/reports/metadata')] };
      }
      throw error;
    }
  },
});

const runReport = defineTool({
  name: 'jama_run_report',
  toolset: 'files',
  title: 'Report starten',
  description:
    'Startet einen Jama-Report. Der Lauf ist asynchron: Jama liefert eine Vorgangs-ID, das Ergebnis steht erst spaeter bereit. Nutzt einen labs-Endpoint.',
  inputSchema: {
    reportId: z.number().int().describe('Report-ID aus jama_list_reports.'),
    projectId: z.number().int().describe('Projekt, auf das sich der Report bezieht.'),
    itemIds: z
      .array(z.number().int())
      .optional()
      .describe('Items, auf die der Report angewendet wird.'),
  },
  mutating: true,
  labs: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const response = await context.client.http.request<Record<string, unknown>>(
      `reports/${args.reportId}`,
      {
        method: 'POST',
        body: { project: args.projectId, items: args.itemIds },
        apiVersion: 'labs',
      },
    );

    context.audit({
      action: 'report.run',
      targetType: 'report',
      targetKey: String(args.reportId),
      payload: { projectId: args.projectId, items: args.itemIds?.length },
      result: 'ok',
    });

    return {
      data: { gestartet: true, reportId: args.reportId, antwort: response.data },
      projectId: args.projectId,
      notes: [
        'Der Report laeuft asynchron. Das Ergebnis steht erst nach Abschluss bereit und muss ueber die Jama-Oberflaeche oder den zurueckgelieferten Verweis abgeholt werden.',
      ],
    };
  },
});

export const reviewTools: ToolDefinition[] = [
  listReviews,
  getReviewStatus,
  listReviewComments,
] as unknown as ToolDefinition[];

export const fileTools: ToolDefinition[] = [
  listAttachments,
  uploadAttachment,
  downloadAttachment,
  listReports,
  runReport,
] as unknown as ToolDefinition[];
