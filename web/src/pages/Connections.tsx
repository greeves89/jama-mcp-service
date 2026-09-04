import { useEffect, useState } from 'react';
import { Cable, Pencil, Plus, TestTube2, Trash2 } from 'lucide-react';
import { api, type Connection, type ConnectionHealth } from '../api';
import { Badge, Button, Card, Field, Notice, Spinner, Table, inputClass, zeit } from '../components/ui';

export default function ConnectionsPage() {
  const [verbindungen, setVerbindungen] = useState<Connection[]>();
  const [fehler, setFehler] = useState<string>();
  const [formularOffen, setFormularOffen] = useState(false);
  // Die Verbindung, die gerade bearbeitet wird. Getrennt vom Anlegen-Formular,
  // damit beide nicht gleichzeitig offen stehen koennen.
  const [inBearbeitung, setInBearbeitung] = useState<Connection>();
  const [testErgebnis, setTestErgebnis] = useState<Record<string, ConnectionHealth>>({});
  const [testLaeuft, setTestLaeuft] = useState<string>();

  const laden = () => {
    api.connections().then(setVerbindungen).catch((error) => setFehler(error.message));
  };

  useEffect(laden, []);

  const testen = async (id: string) => {
    setTestLaeuft(id);
    try {
      const ergebnis = await api.testConnection(id);
      setTestErgebnis((vorher) => ({ ...vorher, [id]: ergebnis }));
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Test fehlgeschlagen');
    } finally {
      setTestLaeuft(undefined);
    }
  };

  const loeschen = async (verbindung: Connection) => {
    if (!confirm(`Verbindung "${verbindung.name}" löschen?`)) return;
    try {
      await api.deleteConnection(verbindung.id);
      laden();
    } catch (error) {
      setFehler(error instanceof Error ? error.message : 'Löschen fehlgeschlagen');
    }
  };

  if (fehler && !verbindungen) return <Notice tone="bad">{fehler}</Notice>;
  if (!verbindungen) return <Spinner />;

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Jama-Verbindungen</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Instanzen, gegen die dieser Dienst arbeitet. Zugangsdaten liegen verschlüsselt in der
            Datenbank und verlassen den Server nie.
          </p>
        </div>
        <Button
          onClick={() => {
            setInBearbeitung(undefined);
            setFormularOffen(!formularOffen);
          }}
        >
          <Plus size={14} />
          Neue Verbindung
        </Button>
      </header>

      {fehler && <Notice tone="bad">{fehler}</Notice>}

      {formularOffen && (
        <VerbindungsFormular
          onAbbrechen={() => setFormularOffen(false)}
          onFertig={() => {
            setFormularOffen(false);
            laden();
          }}
        />
      )}

      {inBearbeitung && (
        <VerbindungsFormular
          // Der Schluessel erzwingt ein frisches Formular beim Wechsel auf eine
          // andere Verbindung — sonst blieben die Eingaben der vorigen stehen.
          key={inBearbeitung.id}
          verbindung={inBearbeitung}
          onAbbrechen={() => setInBearbeitung(undefined)}
          onFertig={() => {
            setInBearbeitung(undefined);
            // Ein frueheres Testergebnis gehoert nach dem Aendern weg: es galt
            // fuer die alten Daten und stuende sonst irrefuehrend in der Zeile.
            setTestErgebnis((vorher) => {
              const { [inBearbeitung.id]: _verworfen, ...rest } = vorher;
              return rest;
            });
            laden();
          }}
        />
      )}

      <Card>
        {verbindungen.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Noch keine Verbindung angelegt.
          </p>
        ) : (
          <Table kopf={['Name', 'Instanz', 'Auth', 'Limit', 'Zustand', 'Geprüft', '']}>
            {verbindungen.map((verbindung) => (
              <tr key={verbindung.id}>
                <td className="px-2 py-2">
                  <div className="font-medium">{verbindung.name}</div>
                  {verbindung.isProduction && (
                    <Badge tone="bad">Produktivsystem</Badge>
                  )}
                </td>
                <td className="px-2 py-2">
                  <code className="text-xs">{verbindung.baseUrl}</code>
                  {verbindung.apiVersion && (
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      API: {verbindung.apiVersion}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={verbindung.authType === 'oauth' ? 'good' : 'neutral'}>
                    {verbindung.authType === 'oauth' ? 'OAuth' : 'Basic'}
                  </Badge>
                </td>
                <td className="px-2 py-2 tabular-nums text-xs">
                  {verbindung.rateLimitRps ?? 'Standard'}
                  {verbindung.rateLimitRps ? '/s' : ''}
                </td>
                <td className="px-2 py-2">
                  <Badge
                    tone={
                      verbindung.healthStatus === 'ok'
                        ? 'good'
                        : verbindung.healthStatus === 'error'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {verbindung.healthStatus}
                  </Badge>
                  {testErgebnis[verbindung.id] && (
                    <div className="mt-1 max-w-xs text-xs text-slate-600 dark:text-slate-300">
                      {testErgebnis[verbindung.id]!.message}
                    </div>
                  )}
                  {!testErgebnis[verbindung.id] && verbindung.healthMessage && (
                    <div className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
                      {verbindung.healthMessage}
                    </div>
                  )}
                </td>
                <td className="px-2 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {zeit(verbindung.lastHealthCheckAt)}
                </td>
                <td className="px-2 py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="secondary"
                      onClick={() => void testen(verbindung.id)}
                      disabled={testLaeuft === verbindung.id}
                      title="Verbindung testen"
                    >
                      <TestTube2 size={13} />
                      {testLaeuft === verbindung.id ? 'Test läuft' : 'Testen'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setFormularOffen(false);
                        setInBearbeitung(verbindung);
                      }}
                      title="Verbindung bearbeiten"
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button variant="danger" onClick={() => void loeschen(verbindung)} title="Löschen">
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

/**
 * Formular zum Anlegen und zum Bearbeiten einer Verbindung.
 *
 * Beides in einem Bauteil, weil es dieselben Felder und dieselben Regeln sind.
 * Der einzige echte Unterschied liegt bei den Zugangsdaten: Jama zeigt ein
 * Client-Secret nur ein einziges Mal an, und wir geben es nie wieder heraus.
 * Wer also den Namen korrigieren oder das Anfragelimit senken will, koennte ein
 * Pflichtfeld "Secret" gar nicht ausfuellen. Beim Bearbeiten bleiben die Felder
 * deshalb leer und optional — leer heisst: unveraendert uebernehmen.
 */
function VerbindungsFormular({
  verbindung,
  onFertig,
  onAbbrechen,
}: {
  verbindung?: Connection;
  onFertig: () => void;
  onAbbrechen: () => void;
}) {
  const bearbeiten = verbindung !== undefined;

  const [name, setName] = useState(verbindung?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(verbindung?.baseUrl ?? '');
  const [isProduction, setIsProduction] = useState(verbindung?.isProduction ?? false);
  const [rateLimitRps, setRateLimitRps] = useState(String(verbindung?.rateLimitRps ?? 6));
  // authType kommt als freier Text aus der API; alles ausser "basic" wird als
  // OAuth behandelt, weil das der Standardfall ist.
  const [authArt, setAuthArt] = useState<'oauth' | 'basic'>(
    verbindung?.authType === 'basic' ? 'basic' : 'oauth',
  );
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fehler, setFehler] = useState<string>();
  const [laeuft, setLaeuft] = useState(false);

  // Ein Wechsel der Anmeldeart macht die hinterlegten Daten unbrauchbar: ein
  // Client-Secret ist kein Passwort. In dem Fall sind neue Angaben Pflicht,
  // auch beim Bearbeiten.
  const artGewechselt = bearbeiten && authArt !== (verbindung.authType === 'basic' ? 'basic' : 'oauth');
  const zugangsdatenAngefasst =
    authArt === 'oauth' ? clientId !== '' || clientSecret !== '' : username !== '' || password !== '';
  const zugangsdatenPflicht = !bearbeiten || artGewechselt;

  const absenden = async (event: React.FormEvent) => {
    event.preventDefault();
    setLaeuft(true);
    setFehler(undefined);

    const zugangsdaten =
      authArt === 'oauth'
        ? { type: 'oauth' as const, clientId, clientSecret }
        : { type: 'basic' as const, username, password };

    try {
      if (bearbeiten) {
        await api.updateConnection(verbindung.id, {
          name,
          baseUrl,
          isProduction,
          rateLimitRps: Number.parseFloat(rateLimitRps),
          // Nur mitschicken, wenn wirklich etwas eingetragen wurde. Sonst
          // ueberschriebe ein leeres Formular die funktionierenden Daten.
          ...(zugangsdatenAngefasst ? { credentials: zugangsdaten } : {}),
        });
      } else {
        await api.createConnection({
          name,
          baseUrl,
          isProduction,
          rateLimitRps: Number.parseFloat(rateLimitRps),
          credentials: zugangsdaten,
        });
      }
      onFertig();
    } catch (error) {
      const text = error instanceof Error ? error.message : undefined;
      setFehler(text ?? (bearbeiten ? 'Speichern fehlgeschlagen' : 'Anlegen fehlgeschlagen'));
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <Card title={bearbeiten ? `Verbindung bearbeiten: ${verbindung.name}` : 'Neue Jama-Verbindung'}>
      <form onSubmit={absenden} className="space-y-4">
        {fehler && <Notice tone="bad">{fehler}</Notice>}

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Frei wählbar, zum Beispiel Sandbox oder Produktion.">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Basis-URL" hint="Ohne /rest — etwa https://beispiel.jamacloud.com">
            <input
              className={inputClass}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://beispiel.jamacloud.com"
              required
            />
          </Field>
          <Field
            label="Anfragen pro Sekunde"
            hint="Jama drosselt bei 10/s für die gesamte Instanz. Ein Wert unter dem Limit lässt Luft für andere Integrationen."
          >
            <input
              type="number"
              step="0.5"
              min="0.5"
              max="10"
              className={inputClass}
              value={rateLimitRps}
              onChange={(e) => setRateLimitRps(e.target.value)}
            />
          </Field>
          <Field label="Authentifizierung" hint="OAuth funktioniert auch in SSO-Umgebungen, Basic Auth nicht.">
            <select className={inputClass} value={authArt} onChange={(e) => setAuthArt(e.target.value as typeof authArt)}>
              <option value="oauth">OAuth 2.0 (empfohlen)</option>
              <option value="basic">Basic Auth</option>
            </select>
          </Field>
        </div>

        {bearbeiten && !artGewechselt && (
          <Notice tone="info">
            Die hinterlegten Zugangsdaten bleiben unverändert, solange die folgenden Felder leer
            bleiben. Nur ausfüllen, wenn sie erneuert werden sollen — etwa nachdem Jama die
            Anmeldung abgelehnt hat.
          </Notice>
        )}

        {artGewechselt && (
          <Notice tone="warn">
            Die Anmeldeart wurde gewechselt. Die bisherigen Zugangsdaten passen nicht mehr, deshalb
            sind neue Angaben erforderlich.
          </Notice>
        )}

        {authArt === 'oauth' ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Client-ID">
              <input
                className={inputClass}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                required={zugangsdatenPflicht || zugangsdatenAngefasst}
                placeholder={bearbeiten && !artGewechselt ? 'unverändert' : undefined}
              />
            </Field>
            <Field label="Client-Secret" hint="Jama zeigt das Secret nur einmal an.">
              <input
                type="password"
                className={inputClass}
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                required={zugangsdatenPflicht || zugangsdatenAngefasst}
                placeholder={bearbeiten && !artGewechselt ? 'unverändert' : undefined}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Benutzername">
              <input
                className={inputClass}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required={zugangsdatenPflicht || zugangsdatenAngefasst}
                placeholder={bearbeiten && !artGewechselt ? 'unverändert' : undefined}
              />
            </Field>
            <Field label="Passwort">
              <input
                type="password"
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={zugangsdatenPflicht || zugangsdatenAngefasst}
                placeholder={bearbeiten && !artGewechselt ? 'unverändert' : undefined}
              />
            </Field>
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={isProduction} onChange={(e) => setIsProduction(e.target.checked)} />
          Dies ist ein Produktivsystem
        </label>

        {isProduction && (
          <Notice tone="warn">
            Produktivverbindungen werden überall rot markiert. Schreibende Keys auf dieser
            Verbindung wirken auf echte Projektdaten.
          </Notice>
        )}

        <Notice tone="info">
          Der REST-Zugriff erfordert eine Named-Creator-Lizenz. Mit einer Creator-Float-Lizenz
          schlägt jeder Aufruf fehl — der Verbindungstest zeigt den Lizenztyp an.
        </Notice>

        {bearbeiten && (baseUrl !== verbindung.baseUrl || zugangsdatenAngefasst) && (
          <Notice tone="warn">
            Weil sich Adresse oder Zugangsdaten ändern, gilt das bisherige Testergebnis nicht mehr.
            Der Zustand fällt auf „unbekannt" zurück — bitte nach dem Speichern erneut testen.
          </Notice>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={laeuft}>
            <Cable size={14} />
            {laeuft
              ? bearbeiten
                ? 'Wird gespeichert'
                : 'Wird angelegt'
              : bearbeiten
                ? 'Änderungen speichern'
                : 'Verbindung anlegen'}
          </Button>
          <Button variant="secondary" onClick={onAbbrechen}>
            Abbrechen
          </Button>
        </div>
      </form>
    </Card>
  );
}
