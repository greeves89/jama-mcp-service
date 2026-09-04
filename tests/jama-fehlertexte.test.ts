import { describe, expect, it } from 'vitest';
import { explainJamaError } from '../src/shared/errors.js';

/**
 * Verständlichkeit der Jama-Fehlermeldungen.
 *
 * Anlass ist ein Praxisbefund: Beim Verbindungstest antwortete Jama mit 401.
 * Im Dashboard wie im Log stand daraufhin immer derselbe allgemeine Satz — die
 * Antwort von Jama wurde bei genau diesem Status verworfen. Damit war nicht zu
 * unterscheiden, ob die Client-ID unbekannt, das Secret falsch oder das Konto
 * gesperrt war. Der Betreiber konnte nur raten.
 */
describe('Erläuterung eines abgelehnten Zugangs (401)', () => {
  it('gibt error und error_description von Jama weiter', () => {
    const antwort = JSON.stringify({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });

    const text = explainJamaError(401, antwort);

    expect(text).toContain('invalid_client');
    expect(text).toContain('Client authentication failed');
  });

  it('nennt weiterhin die Lizenz als häufige Ursache', () => {
    // Der häufigste Grund in der Praxis: eine Creator-Float-Lizenz, die zwar
    // die Anmeldung an der Oberfläche erlaubt, aber keinen REST-Zugriff.
    expect(explainJamaError(401, '')).toContain('Named-Creator-Lizenz');
  });

  it('kommt mit einer leeren Antwort zurecht', () => {
    const text = explainJamaError(401, '');

    expect(text).toContain('401');
    // Ohne Inhalt wird auch nichts angehängt.
    expect(text).not.toContain('Antwort von Jama');
  });

  it('gibt auch eine Antwort weiter, die kein JSON ist', () => {
    // Manche Instanzen liefern bei Fehlern eine HTML-Seite.
    const text = explainJamaError(401, '<html><body>Access denied</body></html>');

    expect(text).toContain('Access denied');
  });

  it('kürzt eine überlange Antwort', () => {
    const text = explainJamaError(401, 'x'.repeat(5000));

    // Sonst verstopft eine vollständige Fehlerseite Log und Dashboard.
    expect(text.length).toBeLessThan(700);
  });

  it('erklärt bei 400 weiterhin die Custom-Field-Suffixe', () => {
    const text = explainJamaError(400, '{"meta":{"message":"unknown field"}}');

    expect(text).toContain('jama_get_project_schema');
    expect(text).toContain('unknown field');
  });
});
