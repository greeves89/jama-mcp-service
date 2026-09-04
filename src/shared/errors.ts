/**
 * Fehlerklassen mit stabilen Codes. Der Code wandert in usage_events.error_code
 * und wird im Admin-Dashboard ausgewertet — deshalb sind die Werte Teil des
 * Vertrags und duerfen nicht beilaeufig umbenannt werden.
 */

export type ErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'AUTH_DISABLED'
  | 'TOOLSET_FORBIDDEN'
  | 'TOOL_DISABLED'
  | 'PROJECT_FORBIDDEN'
  | 'READ_ONLY'
  | 'CONFIRM_REQUIRED'
  | 'JAMA_AUTH'
  | 'JAMA_NOT_FOUND'
  | 'JAMA_BAD_REQUEST'
  | 'JAMA_THROTTLED'
  | 'JAMA_UNAVAILABLE'
  | 'JAMA_UNEXPECTED'
  | 'CONNECTION_MISSING'
  | 'VALIDATION'
  | 'INTERNAL';

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  /** Zusatzinformationen, die dem Aufrufer gezeigt werden duerfen. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    httpStatus = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class AuthError extends ServiceError {
  constructor(code: ErrorCode, message: string, httpStatus = 401) {
    super(code, message, httpStatus);
    this.name = 'AuthError';
  }
}

export class GuardError extends ServiceError {
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, 403, details);
    this.name = 'GuardError';
  }
}

export class JamaApiError extends ServiceError {
  readonly jamaStatus: number;

  constructor(jamaStatus: number, message: string, details?: Record<string, unknown>) {
    super(mapJamaStatus(jamaStatus), message, jamaStatus === 429 ? 429 : 502, details);
    this.name = 'JamaApiError';
    this.jamaStatus = jamaStatus;
  }
}

function mapJamaStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'JAMA_BAD_REQUEST';
    case 401:
    case 403:
      return 'JAMA_AUTH';
    case 404:
      return 'JAMA_NOT_FOUND';
    case 429:
      return 'JAMA_THROTTLED';
    case 502:
    case 503:
    case 504:
      return 'JAMA_UNAVAILABLE';
    default:
      return 'JAMA_UNEXPECTED';
  }
}

/**
 * Uebersetzt einen Jama-Fehler in eine Nachricht, mit der ein LLM etwas anfangen
 * kann. Ein nacktes "401" fuehrt sonst zu Endlosschleifen aus Wiederholungen.
 */
/**
 * Zieht aus einer OAuth-Fehlerantwort den eigentlichen Grund heraus.
 *
 * Jama antwortet bei abgelehnten Zugangsdaten nach RFC 6749 mit einem
 * JSON-Objekt aus "error" und "error_description" — dort steht, ob die
 * Client-ID unbekannt, das Secret falsch oder das Konto gesperrt ist. Diese
 * Angabe ist der einzige belastbare Hinweis auf die Ursache und darf deshalb
 * nicht hinter einem allgemeinen Text verschwinden.
 */
function oauthGrund(body: string): string | undefined {
  try {
    const daten = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    const teile = [daten.error, daten.error_description]
      .filter((wert): wert is string => typeof wert === 'string' && wert.length > 0)
      .map((wert) => wert.slice(0, 200));
    return teile.length > 0 ? teile.join(': ') : undefined;
  } catch {
    // Kein JSON — dann ist der Rohtext immer noch besser als nichts.
    const text = body.trim().slice(0, 200);
    return text.length > 0 ? text : undefined;
  }
}

export function explainJamaError(status: number, body: string): string {
  const snippet = body.slice(0, 400);
  switch (status) {
    case 400:
      return `Jama hat die Anfrage abgelehnt (400). Haeufigste Ursache sind unbekannte Feldnamen — Custom Fields tragen ein Suffix wie "customField$12". Rufe jama_get_project_schema auf, um die gueltigen Feldnamen des ItemTypes zu erhalten. Antwort von Jama: ${snippet}`;
    case 401: {
      // Bisher wurde Jamas Antwort hier verworfen. Damit stand in jedem
      // Fehlerfall derselbe Text, und die Ursache — falsches Secret, unbekannte
      // Client-ID, gesperrtes Konto — blieb unsichtbar.
      const grund = oauthGrund(body);
      return (
        'Jama hat die Anmeldung abgelehnt (401). Die hinterlegten Zugangsdaten sind ungültig oder abgelaufen. Der Zugriff erfordert außerdem eine Named-Creator-Lizenz; Creator-Float-Lizenzen haben keinen API-Zugang.' +
        (grund ? ` Antwort von Jama: ${grund}` : '')
      );
    }
    case 403:
      return 'Keine Berechtigung fuer diese Ressource (403). Der hinterlegte Jama-Benutzer hat auf dieses Projekt oder Item keinen Zugriff.';
    case 404:
      return 'Die angeforderte Ressource existiert in Jama nicht (404). Pruefe die ID oder den Document Key.';
    case 405:
      return 'Diese Operation ist auf der Ressource nicht erlaubt (405).';
    case 429:
      return 'Jama drosselt die Anfragen (429). Das Limit liegt bei 10 Anfragen pro Sekunde fuer die gesamte Instanz. Die Anfrage wurde bereits mehrfach mit wachsendem Abstand wiederholt.';
    default:
      return `Unerwartete Antwort von Jama (${status}): ${snippet}`;
  }
}

export function toServiceError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ServiceError('INTERNAL', message, 500);
}
