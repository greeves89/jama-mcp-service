/**
 * Grobe Token-Schaetzung ohne Tokenizer-Abhaengigkeit.
 *
 * Der Zweck ist nicht Genauigkeit, sondern Steuerbarkeit: wir wollen (a) im
 * Admin sichtbar machen, welche Tools die LLM-Kosten treiben, und (b) Antworten
 * kappen, bevor sie das Kontextfenster des Clients sprengen. Ein Faktor von
 * 3,6 Zeichen pro Token liegt fuer gemischt deutsch-englische Fachtexte mit
 * vielen IDs und Sonderzeichen nahe genug und ueberschaetzt eher leicht — was
 * in beide Richtungen die sichere Seite ist.
 */
const CHARS_PER_TOKEN = 3.6;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTokensOfJson(value: unknown): number {
  return estimateTokens(JSON.stringify(value) ?? '');
}

export interface TruncationResult<T> {
  value: T;
  truncated: boolean;
  /** Wie viele Elemente entfernt wurden, wenn es sich um eine Liste handelt. */
  removed: number;
  estimatedTokens: number;
}

/**
 * Kappt eine Liste, bis das Token-Budget eingehalten wird. Es wird immer von
 * hinten entfernt, damit die relevantesten (weil zuerst sortierten) Treffer
 * erhalten bleiben. Mindestens ein Element bleibt immer stehen — eine leere
 * Antwort waere fuer den Aufrufer nicht von "nichts gefunden" zu unterscheiden.
 */
export function truncateList<T>(
  items: T[],
  budgetTokens: number,
  overheadTokens = 0,
): TruncationResult<T[]> {
  const kept = [...items];
  let removed = 0;
  let estimate = estimateTokensOfJson(kept) + overheadTokens;

  while (kept.length > 1 && estimate > budgetTokens) {
    kept.pop();
    removed += 1;
    estimate = estimateTokensOfJson(kept) + overheadTokens;
  }

  return { value: kept, truncated: removed > 0, removed, estimatedTokens: estimate };
}

/**
 * Kappt einen Text auf ein Token-Budget und haengt einen Hinweis an, damit das
 * LLM erkennt, dass der Inhalt unvollstaendig ist, statt ihn fuer vollstaendig
 * zu halten.
 */
export function truncateText(text: string, budgetTokens: number): TruncationResult<string> {
  const maxChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  if (text.length <= maxChars) {
    return { value: text, truncated: false, removed: 0, estimatedTokens: estimateTokens(text) };
  }

  // An einer Zeilengrenze abschneiden, damit keine Tabelle mitten im Zeichen endet.
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  const body = lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut;
  const removedChars = text.length - body.length;
  const notice = `\n\n[gekuerzt: ${removedChars} Zeichen entfernt, um das Antwortbudget einzuhalten]`;
  const value = body + notice;

  return {
    value,
    truncated: true,
    removed: removedChars,
    estimatedTokens: estimateTokens(value),
  };
}
