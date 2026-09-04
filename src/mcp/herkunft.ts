import { aufruferText } from './aufrufer.js';
import { logger } from '../shared/logger.js';
import type { ToolContext } from './types.js';

/**
 * Vermerkt am geaenderten Item, wer die Aenderung veranlasst hat.
 *
 * Jama fuehrt zwar eine eigene Historie, dort steht aber nur der technische
 * Benutzer, unter dem diese Anbindung arbeitet. Teilen sich mehrere Menschen
 * einen Zugang — der Regelfall bei einem Chat-Werkzeug —, ist im Nachhinein
 * nicht mehr feststellbar, wer eine Anforderung angelegt oder geaendert hat.
 * Der Kommentar traegt diese Angabe im Item selbst nach, sichtbar fuer jeden,
 * der es spaeter oeffnet, und unabhaengig vom Protokoll dieses Dienstes.
 *
 * Fehlschlaege werden bewusst verschluckt: Die Aenderung in Jama ist zu diesem
 * Zeitpunkt bereits geschehen. Ein Abbruch wuerde sie nicht rueckgaengig
 * machen, sondern nur einen erfolgreichen Vorgang als gescheitert melden — und
 * zu einem zweiten Versuch verleiten, der Dubletten erzeugt.
 */
export async function vermerkeHerkunft(
  itemIds: number[],
  context: ToolContext,
  vorgang: string,
): Promise<void> {
  if (itemIds.length === 0) return;

  const person = aufruferText(context.aufrufer);
  const text =
    context.aufrufer !== undefined
      ? `${vorgang} über die Jama-Anbindung durch ${person} (Zugang: ${context.apiKeyName}).`
      : `${vorgang} über die Jama-Anbindung (Zugang: ${context.apiKeyName}). Die auslösende Person wurde vom Client nicht übermittelt.`;

  for (const itemId of itemIds) {
    try {
      await context.client.http.request('comments', {
        method: 'POST',
        body: { body: { text }, location: { item: itemId } },
      });
    } catch (error) {
      logger.warn(
        { itemId, err: error },
        'Herkunftsvermerk konnte nicht geschrieben werden — die Aenderung selbst ist erfolgt',
      );
    }
  }
}
