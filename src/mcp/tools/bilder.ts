import { z } from 'zod';
import { defineTool, type ToolBild, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { resolveItem } from './core.js';
import type { JamaAttachment } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';

/**
 * Bilder aus Jama an das Sprachmodell weiterreichen.
 *
 * Bilder stecken in Jama an zwei Stellen: als Data-URI mitten in der
 * Beschreibung eines Items — so landen sie dort, wenn jemand sie im Editor
 * einfuegt — oder als Anhang am Item. In der Textausgabe erscheinen sie
 * bislang nur als Platzhalter, und das aus gutem Grund: Ein einzelnes
 * eingebettetes Bild erreicht als base64-Zeichenkette leicht mehrere
 * hunderttausend Zeichen und wuerde das Kontextfenster fuellen, ohne dass das
 * Modell etwas davon betrachten koennte.
 *
 * Dieses Werkzeug liefert sie stattdessen als eigene Bildbloecke. Damit sieht
 * das Modell, was auf einem Schaltplan, einem Messschrieb oder einer Skizze
 * steht — Inhalte, die in Anforderungsdokumenten haeufig die eigentliche
 * Aussage tragen und im Text nirgends stehen.
 */

/** Was ein Bild hoechstens wiegen darf, bevor es uebersprungen wird. */
const STANDARD_GRENZE_BYTES = 4_000_000;

/** Von Jama ueblicherweise verwendete Bildformate. */
const BILDTYPEN = /^image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml)$/i;

interface GefundenesBild extends ToolBild {
  bytes: number;
}

/**
 * Liest die in einer Beschreibung eingebetteten Bilder aus.
 *
 * Jamas Editor legt eingefuegte Bilder als Data-URI ab. Der regulaere Ausdruck
 * greift bewusst nur diese Form: Verweise auf Dateien werden weiter unten ueber
 * die Anhaenge aufgeloest, wo Groesse und Typ bekannt sind.
 */
function eingebetteteBilder(beschreibung: string, grenze: number): GefundenesBild[] {
  const gefunden: GefundenesBild[] = [];
  const muster = /<img[^>]+src=["']data:(image\/[a-z+]+);base64,([^"']+)["'][^>]*>/gi;

  let treffer: RegExpExecArray | null;
  let nummer = 0;

  while ((treffer = muster.exec(beschreibung)) !== null) {
    nummer += 1;
    const mimeType = treffer[1]!.toLowerCase();
    const data = treffer[2]!;
    // base64 traegt vier Zeichen je drei Byte.
    const bytes = Math.floor((data.length * 3) / 4);

    if (bytes > grenze) {
      logger.debug({ bytes, grenze }, 'Eingebettetes Bild uebersprungen — zu gross');
      continue;
    }

    gefunden.push({
      data,
      mimeType,
      quelle: `Beschreibung, Bild ${nummer}`,
      bytes,
    });
  }

  return gefunden;
}

const getItemImages = defineTool({
  name: 'jama_get_item_images',
  toolset: 'core',
  title: 'Bilder eines Items abrufen',
  description:
    'Liefert die Bilder eines Items als betrachtbare Bildinhalte — sowohl die in der Beschreibung eingebetteten als auch die angehaengten. In der normalen Textausgabe erscheinen Bilder nur als Platzhalter, weil sie als Zeichenkette das Kontextfenster fuellen wuerden. DIESEN AUFRUF VERWENDEN, wenn eine Anforderung auf eine Abbildung, eine Skizze, einen Schaltplan oder ein Diagramm verweist und deren Inhalt fuer die Aufgabe gebraucht wird.',
  inputSchema: {
    itemId: z.number().int().optional().describe('Numerische Item-ID.'),
    documentKey: z.string().optional().describe('Alternativ der Document Key.'),
    quelle: z
      .enum(['alle', 'beschreibung', 'anhaenge'])
      .default('alle')
      .describe(
        'Woher die Bilder stammen sollen. "beschreibung" meint die im Text eingebetteten, "anhaenge" die am Item haengenden Dateien.',
      ),
    maxBilder: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe(
        'Obergrenze. Jedes Bild belegt Platz im Kontextfenster des Clients, deshalb bewusst niedrig.',
      ),
    maxBytesJeBild: z
      .number()
      .int()
      .min(50_000)
      .max(10_000_000)
      .default(STANDARD_GRENZE_BYTES)
      .describe('Groessere Bilder werden uebersprungen und im Ergebnis benannt.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const item = await resolveItem(args, context);
    assertProjectAllowed(item.project, context);

    const bilder: GefundenesBild[] = [];
    const uebersprungen: string[] = [];

    // --- Eingebettete Bilder aus der Beschreibung -------------------------
    if (args.quelle !== 'anhaenge') {
      const beschreibung =
        typeof item.fields?.description === 'string' ? item.fields.description : '';
      bilder.push(...eingebetteteBilder(beschreibung, args.maxBytesJeBild));
    }

    // --- Angehaengte Bilddateien -----------------------------------------
    if (args.quelle !== 'beschreibung' && bilder.length < args.maxBilder) {
      const { items: anhaenge } = await context.client.http.paginate<JamaAttachment>(
        `items/${item.id}/attachments`,
        { limit: 50 },
      );

      for (const anhang of anhaenge) {
        if (bilder.length >= args.maxBilder) break;

        const name = anhang.fileName ?? anhang.fields?.name ?? `Anhang ${anhang.id}`;
        // Jama nennt den Typ im Anhang nicht zuverlaessig; die Endung ist hier
        // das verlaesslichere Merkmal.
        const endung = String(name).toLowerCase().split('.').pop() ?? '';
        const vermuteterTyp =
          endung === 'jpg' ? 'image/jpeg' : endung === 'svg' ? 'image/svg+xml' : `image/${endung}`;
        if (!BILDTYPEN.test(vermuteterTyp)) continue;

        try {
          const antwort = await context.client.http.rawRequest(`attachments/${anhang.id}/file`, {
            raw: true,
          });
          const inhalt = Buffer.from(await antwort.arrayBuffer());

          if (inhalt.length > args.maxBytesJeBild) {
            uebersprungen.push(`${name} (${Math.round(inhalt.length / 1024)} kB, zu gross)`);
            continue;
          }

          bilder.push({
            data: inhalt.toString('base64'),
            mimeType: antwort.headers.get('content-type') ?? vermuteterTyp,
            quelle: `Anhang: ${name}`,
            bytes: inhalt.length,
          });
        } catch (fehler) {
          // Ein einzelner Fehlschlag darf die uebrigen Bilder nicht verhindern.
          uebersprungen.push(`${name} (Abruf fehlgeschlagen)`);
          logger.warn({ anhangId: anhang.id, err: fehler }, 'Anhang konnte nicht geladen werden');
        }
      }
    }

    const ausgewaehlt = bilder.slice(0, args.maxBilder);
    const zurueckgehalten = bilder.length - ausgewaehlt.length;

    if (ausgewaehlt.length === 0) {
      throw new ServiceError(
        'JAMA_NOT_FOUND',
        `An Item ${item.documentKey ?? item.id} wurden keine Bilder gefunden.${
          uebersprungen.length > 0 ? ` Uebersprungen: ${uebersprungen.join('; ')}.` : ''
        }`,
        404,
      );
    }

    const hinweise: string[] = [];
    if (zurueckgehalten > 0) {
      hinweise.push(
        `${zurueckgehalten} weitere Bilder wurden nicht mitgeliefert. Mit maxBilder laesst sich die Grenze anheben.`,
      );
    }
    if (uebersprungen.length > 0) {
      hinweise.push(`Uebersprungen: ${uebersprungen.join('; ')}.`);
    }

    return {
      data: {
        item: { id: item.id, documentKey: item.documentKey },
        bilder: ausgewaehlt.map((bild, index) => ({
          nummer: index + 1,
          quelle: bild.quelle,
          mimeType: bild.mimeType,
          bytes: bild.bytes,
        })),
      },
      // Die Reihenfolge entspricht der Aufstellung oben, damit sich jedes
      // betrachtete Bild seiner Herkunft zuordnen laesst.
      bilder: ausgewaehlt.map(({ data, mimeType, quelle }) => ({ data, mimeType, quelle })),
      projectId: item.project,
      notes: hinweise.length > 0 ? hinweise : undefined,
    };
  },
});

export const bilderTools: ToolDefinition[] = [getItemImages] as unknown as ToolDefinition[];
