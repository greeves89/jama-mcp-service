import TurndownService from 'turndown';

/**
 * Jama liefert Rich-Text-Felder (Description, Kommentare, Testschritte) als HTML.
 * Roh weitergereicht kostet ein einziges Requirement schnell mehrere tausend
 * Token — der Grossteil davon Markup, das dem LLM nichts sagt. Die Konvertierung
 * nach Markdown ist deshalb keine Kosmetik, sondern der groesste einzelne
 * Hebel fuer die Token-Kosten.
 */

/**
 * Turndown liefert unter Node ein DOM-aehnliches Objekt (domino), aber wir
 * binden die DOM-Typbibliothek bewusst nicht ein — sie wuerde hunderte
 * Browser-Globals in ein reines Server-Projekt ziehen. Diese schmale Schnittstelle
 * beschreibt genau das, was hier gebraucht wird.
 */
interface DomLikeElement {
  nodeName: string;
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomLikeElement | null;
  querySelectorAll(selector: string): DomLikeElement[];
}

function asElement(node: unknown): DomLikeElement {
  return node as DomLikeElement;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});

/**
 * Tabellen bleiben erhalten. In Jama stecken Akzeptanzkriterien und
 * Parametersaetze oft in Tabellen — wuerden sie zu Fliesstext zerfallen, ginge
 * die Zuordnung von Spalte zu Wert verloren.
 */
turndown.addRule('table', {
  filter: 'table',
  replacement: (_content, node) => {
    const rows = Array.from(asElement(node).querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const parsed = rows.map((row) =>
      Array.from(row.querySelectorAll('th, td')).map((cell) =>
        (cell.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim(),
      ),
    );

    const columns = Math.max(...parsed.map((cells) => cells.length));
    if (columns === 0) return '';

    const pad = (cells: string[]) => {
      const filled = [...cells];
      while (filled.length < columns) filled.push('');
      return `| ${filled.join(' | ')} |`;
    };

    const [header, ...body] = parsed;
    const lines = [
      pad(header ?? []),
      `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
      ...body.map(pad),
    ];
    return `\n\n${lines.join('\n')}\n\n`;
  },
});

/**
 * Bilder werden zu einem Platzhalter. Data-URIs in Jama-Descriptions koennen
 * sechsstellige Zeichenzahlen erreichen — die duerfen niemals ins Kontextfenster.
 */
turndown.addRule('image', {
  filter: 'img',
  replacement: (_content, node) => {
    const element = asElement(node);
    const alt = element.getAttribute('alt')?.trim();
    const src = element.getAttribute('src') ?? '';
    const isDataUri = src.startsWith('data:');
    const label = alt || 'Bild';
    return isDataUri
      ? `[${label}: eingebettetes Bild, nicht dargestellt]`
      : `[${label}: ${src.split('/').pop() ?? src}]`;
  },
});

/** Jamas Editor hinterlaesst haeufig leere Absaetze, die nur Platz kosten. */
turndown.addRule('emptyParagraph', {
  filter: (node) => {
    const element = asElement(node);
    return (
      element.nodeName === 'P' &&
      (element.textContent ?? '').trim() === '' &&
      !element.querySelector('img')
    );
  },
  replacement: () => '',
});

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return '';
  const trimmed = html.trim();
  if (trimmed === '') return '';

  // Kein Markup vorhanden — dann ist die Konvertierung reine Verschwendung.
  if (!/<[a-z][\s\S]*>/i.test(trimmed)) return trimmed;

  try {
    return turndown
      .turndown(trimmed)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    // Lieber entschaerftes HTML als gar kein Inhalt.
    return stripTags(trimmed);
  }
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kuerzt einen Markdown-Text auf eine Zeichenzahl und schneidet dabei an einer
 * Absatzgrenze, damit keine halbe Tabelle stehen bleibt.
 */
export function shorten(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
  const body = boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut;
  return `${body}\n\n[gekuerzt — vollstaendigen Text ueber jama_get_item abrufen]`;
}
